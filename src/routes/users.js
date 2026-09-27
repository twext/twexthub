import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { hashPassword, verifyPassword } from '../password.js';
import { requireSession } from '../auth.js';
import { removeBlobIfUnused } from '../blobs.js';
import {
  PROFILE_IMAGES,
  profileImagePointer,
  removeProfileImageBlob,
  resolveProfileImage,
  storeProfileImage,
} from '../profile-images.js';
import { removeSourceIfUnused } from '../sources.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { fieldErrors, forbidden, HttpError, notFound, payloadTooLarge } from '../errors.js';
import { isValidNamespace } from '../util.js';
import { userToObject } from '../serialize.js';
import { notifyUser, roleChangedMessage, tokensRevokedMessage } from '../notify.js';
import { requireObjectBody } from './shared.js';
import { audit } from '../audit.js';

// A bare /^https?:\/\// prefix accepts "https://" with no host and anything the
// URL parser would reject, so parse it and check what came back.
function isHttpUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.hostname.length > 0;
}

export function makeUsersRouter({ sql, config, termsGate }) {
  const router = Router();

  function serializePublicUser(row, req) {
    const isOwner = req.auth?.user.namespace === row.namespace;
    const isAdmin = req.auth?.user.role === 'admin';
    if (isOwner || isAdmin) return userToObject(row, config);
    const { role: _role, termsAcceptedVersion: _terms, ...rest } = userToObject(row, config);
    return rest;
  }

  router.get('/', async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });

    const rows = await sql`
      SELECT * FROM users
      ${cursor ? sql`WHERE id < ${cursor.i}` : sql``}
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ i: Number(last.id) }) : null;

    res.json({
      data: page.map((user) => serializePublicUser(user, req)),
      pagination: { nextCursor, hasMore },
    });
  });

  router.get('/:namespace', async (req, res) => {
    if (!isValidNamespace(req.params.namespace)) throw notFound();
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${req.params.namespace}`;
    if (!user) throw notFound();
    res.json(serializePublicUser(user, req));
  });

  // One endpoint per image kind serves all three states in priority order: an
  // uploaded image is streamed from the blob store, an external reference is
  // redirected, and an avatar with neither falls back to the namespace
  // identicon. Serving the upload here rather than publishing a blob URL keeps
  // the URL stable across re-uploads, so an extension that cached it does not
  // break when the picture changes.
  const serveProfileImage = (kind, fallback) => async (req, res) => {
    if (!isValidNamespace(req.params.namespace)) throw notFound();
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${req.params.namespace}`;
    if (!user) throw notFound();
    // The upload is tried first because an account can hold both, and the file
    // it uploaded is the one the instance is responsible for serving.
    const stored = await resolveProfileImage(config, user, kind);
    if (stored) {
      // A URL carrying the digest names the exact bytes, so it can be cached
      // hard: a replacement upload is published under a new URL rather than
      // served behind the old one. The path without a version is the same
      // before and after a re-upload, so it revalidates instead, and a stale
      // version is sent to the current one rather than answered with bytes the
      // URL did not name.
      const asked = typeof req.query.v === 'string' ? req.query.v : null;
      if (asked !== null && asked !== stored.digest.slice(0, 16)) {
        res.redirect(
          302,
          `${req.baseUrl}/${user.namespace}/${kind}?v=${stored.digest.slice(0, 16)}`,
        );
        return;
      }
      if (asked === null) {
        res.set('Cache-Control', 'public, max-age=0, must-revalidate');
        res.set('ETag', `"${stored.digest}"`);
        if (req.headers['if-none-match'] === `"${stored.digest}"`) {
          res.status(304).end();
          return;
        }
      } else {
        res.set('Cache-Control', 'public, max-age=31536000, immutable');
      }
      res.set('Content-Type', stored.contentType);
      // The validator reads the leading signature only, so an upload can carry
      // anything after it. These bytes are served from the API origin, and
      // nosniff is what keeps a browser from reading past the declared type.
      res.set('X-Content-Type-Options', 'nosniff');
      if (stored.expectedSize !== null && stored.expectedSize !== stored.size) {
        // The row and the file disagree. Serving a truncated image is worse than
        // reporting the damage, so fail loudly instead of caching it.
        throw new HttpError(500, {
          title: 'Internal Server Error',
          detail: `Stored ${kind} image does not match its recorded size.`,
        });
      }
      res.set('Content-Length', String(stored.size));
      res.sendFile(stored.abs);
      return;
    }
    const external = kind === 'avatar' ? user.avatar_url : user.banner_url;
    if (external) {
      res.redirect(external);
      return;
    }
    if (!fallback) throw notFound('No banner has been set.');
    res.set('Cache-Control', 'public, max-age=3600');
    res.type('image/svg+xml').send(identiconSvg(user.namespace));
  };

  router.get('/:namespace/avatar', serveProfileImage('avatar', true));
  router.get('/:namespace/banner', serveProfileImage('banner', false));

  // Raw bodies rather than multipart: the account uploads one file, the file is
  // the entire payload, and parsing multipart here would mean accepting a
  // second content type that carries no extra meaning for this endpoint.
  const uploadProfileImage = (kind) => [
    requireSession,
    express.raw({
      type: ['image/*', 'application/octet-stream'],
      limit: config.limits?.maxProfileImageBytes ?? 2 * 1024 * 1024,
    }),
    async (req, res) => {
      const target = await loadUserOr404(sql, req.params.namespace);
      if (req.auth.user.namespace !== target.namespace) {
        throw forbidden('You can only change your own profile images.');
      }
      const declared = req.get('content-type');
      try {
        const stored = await storeProfileImage(sql, config, target, kind, req.body, declared);
        // The replaced image is only unlinked after the new pointer is
        // committed, and only when nothing else references those bytes.
        if (stored.previous && stored.previous !== stored.digest) {
          await removeProfileImageBlob(sql, config, stored.previous);
        }
        const [updated] = await sql`SELECT * FROM users WHERE id = ${target.id}`;
        res.json(userToObject(updated, config));
      } catch (error) {
        if (error?.type === 'entity.too.large') {
          throw payloadTooLarge(
            `Image is larger than the ${Math.floor((config.limits?.maxProfileImageBytes ?? 2 * 1024 * 1024) / 1024)} KiB limit.`,
          );
        }
        throw error;
      }
    },
  ];

  router.put('/:namespace/avatar', ...uploadProfileImage('avatar'));
  router.put('/:namespace/banner', ...uploadProfileImage('banner'));

  // Removes an upload. An external reference, if the account has one, becomes
  // the image again; otherwise the profile falls back to the identicon for an
  // avatar and to no banner at all.
  const deleteProfileImage = (kind) => [
    requireSession,
    async (req, res) => {
      const target = await loadUserOr404(sql, req.params.namespace);
      if (req.auth.user.namespace !== target.namespace) {
        throw forbidden('You can only change your own profile images.');
      }
      const { digest } = profileImagePointer(target, kind);
      const columns = PROFILE_IMAGES[kind];
      const [updated] = await sql`
        UPDATE users
        SET ${sql(columns.digestColumn)} = NULL,
            ${sql(columns.typeColumn)} = NULL,
            ${sql(columns.bytesColumn)} = NULL
        WHERE id = ${target.id}
        RETURNING *
      `;
      if (digest) await removeProfileImageBlob(sql, config, digest);
      res.json(userToObject(updated, config));
    },
  ];

  router.delete('/:namespace/avatar', ...deleteProfileImage('avatar'));
  router.delete('/:namespace/banner', ...deleteProfileImage('banner'));

  // A pure password change stays reachable when the terms have moved on, so an
  // account can still be secured. The old check read "any profile field is
  // present" and so was always false next to a password, which meant a password
  // field alone waved the whole request through: attaching one smuggled a
  // profile or role edit past the gate too. Only the password fields are exempt.
  function skipTermsForPasswordOnly(req, res, next) {
    const { password, currentPassword: _currentPassword, ...rest } = req.body ?? {};
    const onlyPassword =
      password !== undefined && Object.values(rest).every((value) => value === undefined);
    return onlyPassword ? next() : termsGate(req, res, next);
  }

  router.patch('/:namespace', requireSession, skipTermsForPasswordOnly, async (req, res) => {
    const target = await loadUserOr404(sql, req.params.namespace);
    if (req.auth.user.namespace !== target.namespace && req.auth.user.role !== 'admin') {
      throw forbidden('Only an admin can update another account.');
    }
    requireObjectBody(req);

    const { displayName, password, role, bio, website, github, avatarUrl, bannerUrl } = req.body;
    if (
      displayName === undefined &&
      password === undefined &&
      role === undefined &&
      bio === undefined &&
      website === undefined &&
      github === undefined &&
      avatarUrl === undefined &&
      bannerUrl === undefined
    ) {
      throw fieldErrors([{ field: 'body', message: 'Provide at least one field to update.' }]);
    }

    const errors = [];
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 80)) {
      errors.push({ field: 'displayName', message: 'Must be a string of at most 80 characters.' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      errors.push({ field: 'password', message: 'Password must be at least 8 characters.' });
    }
    if (role !== undefined && role !== 'admin' && role !== 'normal') {
      errors.push({ field: 'role', message: 'Role must be "admin" or "normal".' });
    }
    if (bio !== undefined && bio !== null && (typeof bio !== 'string' || bio.length > 280)) {
      errors.push({
        field: 'bio',
        message: 'Must be a string of at most 280 characters, or null.',
      });
    }
    for (const [field, value] of [
      ['website', website],
      ['avatarUrl', avatarUrl],
      ['bannerUrl', bannerUrl],
    ]) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || value.length > 400 || !isHttpUrl(value)) {
        errors.push({
          field,
          message: 'Must be an http(s) URL of at most 400 characters, or null to clear.',
        });
      }
    }
    if (github !== undefined && github !== null) {
      if (
        typeof github !== 'string' ||
        !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(github)
      ) {
        errors.push({
          field: 'github',
          message: 'Must be a GitHub username, or null to clear.',
        });
      }
    }
    if (errors.length > 0) throw fieldErrors(errors);

    if (role !== undefined && req.auth.user.role !== 'admin') {
      throw forbidden('Only an admin can change a role.');
    }

    const patch = {};
    const columns = [];
    if (displayName !== undefined) {
      patch.display_name = displayName;
      columns.push('display_name');
    }
    if (role !== undefined) {
      patch.role = role;
      columns.push('role');
    }
    if (bio !== undefined) {
      patch.bio = bio ?? '';
      columns.push('bio');
    }
    if (website !== undefined) {
      patch.website = website;
      columns.push('website');
    }
    if (github !== undefined) {
      patch.github = github;
      columns.push('github');
    }
    // A URL is recorded whether or not the account also has an upload. The
    // upload stays the face of the profile and this is the fallback, so
    // clearing the link later never silently discards a file the account
    // still serves, and uploading a file never discards a link.
    if (avatarUrl !== undefined) {
      patch.avatar_url = avatarUrl;
      columns.push('avatar_url');
    }
    if (bannerUrl !== undefined) {
      patch.banner_url = bannerUrl;
      columns.push('banner_url');
    }
    if (password !== undefined) {
      if (req.auth.user.role !== 'admin') {
        const currentPassword = req.body.currentPassword;
        if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
          throw fieldErrors([
            {
              field: 'currentPassword',
              message: 'Current password is required when changing your password.',
            },
          ]);
        }
        const valid = await verifyPassword(currentPassword, target.password_hash);
        if (!valid) throw forbidden('Current password is incorrect.');
      }
      patch.password_hash = await hashPassword(password, config.auth.scrypt);
      columns.push('password_hash');
    }

    const [updated] = await sql.begin(async (tx) => {
      await tx`UPDATE users SET ${sql(patch, columns)} WHERE id = ${target.id}`;
      if (password !== undefined) {
        await tx`DELETE FROM sessions WHERE user_id = ${target.id}`;
        await tx`DELETE FROM automation_tokens WHERE user_id = ${target.id}`;
        if (Number(req.auth.user.id) !== Number(target.id)) {
          await notifyUser(
            tx,
            target.id,
            'tokens.revoked',
            tokensRevokedMessage(req.auth.user.namespace),
            { actor: req.auth.user.namespace },
          );
        }
      }
      if (role !== undefined) {
        await notifyUser(tx, target.id, 'role.changed', roleChangedMessage(role), { role });
        await audit(
          tx,
          req.auth.user,
          'role.change',
          { namespace: target.namespace },
          {
            role,
            previousRole: target.role,
          },
        );
      }
      return tx`SELECT * FROM users WHERE id = ${target.id}`;
    });
    if (!updated) throw notFound();

    res.json(userToObject(updated, config));
  });

  router.delete('/:namespace', requireSession, async (req, res) => {
    const target = await loadUserOr404(sql, req.params.namespace);
    if (req.auth.user.namespace !== target.namespace && req.auth.user.role !== 'admin') {
      throw forbidden('Only an admin can delete another account.');
    }
    // Blobs and sources are content-addressed under blobs/<xx>/<rest> and
    // sources/<xx>/<rest>, not under a per-namespace directory, so the digests
    // have to be read before the DELETE: it cascades the version rows away and
    // they are the only record of which files this account put on disk.
    const owned = await sql`
      SELECT DISTINCT blob_digest, blob_path, source_digest
      FROM versions
      WHERE owner_id = ${target.id}
    `;
    // Uploaded images are named by the users row itself, so they have to be
    // read before the DELETE takes it away.
    const profileDigests = [target.avatar_blob_digest, target.banner_blob_digest].filter(Boolean);
    await sql`DELETE FROM users WHERE id = ${target.id}`;

    // Only after the commit: a failed DELETE leaves the rows, and the keeper
    // check keeps any digest another account's version still references.
    // A cleanup failure costs disk, not correctness -- the boot-time sweep in
    // db.js collects whatever is left unreferenced.
    // blob_path is set on digest-backed rows too, so the legacy unlink is
    // mutually exclusive with the digest path: doing both would delete a file
    // the keeper check had just decided to keep.
    const legacyPaths = [
      ...new Set(
        owned
          .filter((row) => !row.blob_digest)
          .map((row) => row.blob_path)
          .filter(Boolean),
      ),
    ];
    try {
      await Promise.all([
        ...owned
          .map((row) => (row.blob_digest ? removeBlobIfUnused(sql, config, row.blob_digest) : null))
          .filter(Boolean),
        ...legacyPaths.map((rel) => rm(path.join(config.dataDir, rel), { force: true })),
        // The row is already gone, so no user can still point at these digests.
        ...profileDigests.map((digest) => removeProfileImageBlob(sql, config, digest)),
      ]);
      await Promise.all(
        [...new Set(owned.map((row) => row.source_digest).filter(Boolean))].map((digest) =>
          removeSourceIfUnused(sql, config, digest),
        ),
      );
    } catch (error) {
      console.error(`blob cleanup deferred for ${target.namespace}: ${error.message}`);
    }
    res.status(204).end();
  });

  return router;
}

async function loadUserOr404(sql, namespace) {
  if (!isValidNamespace(namespace)) throw notFound();
  const [user] = await sql`SELECT * FROM users WHERE namespace = ${namespace}`;
  if (!user) throw notFound();
  return user;
}

// 8x8 horizontally-mirrored identicon: the left 4 columns are decided by the
// namespace's SHA-256, then mirrored. Two of the hash bytes pick one of six
// hue-rotated foreground colors on a fixed light background.
function identiconSvg(namespace) {
  const hash = createHash('sha256').update(namespace).digest();
  const cells = [];
  for (let y = 0; y < 8; y += 1) {
    const left = [];
    for (let x = 0; x < 4; x += 1) {
      left.push(hash[y * 4 + x] % 2 === 1);
    }
    cells.push([...left, ...left.toReversed()]);
  }
  const hue = hash[31] % 360;
  const rect = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      if (cells[y][x]) rect.push(`<rect x="${x * 12}" y="${y * 12}" width="12" height="12"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <rect width="96" height="96" fill="hsl(${hue}, 18%, 92%)"/>
  <g fill="hsl(${hue}, 55%, 45%)">${rect.join('')}</g>
</svg>
`;
}
