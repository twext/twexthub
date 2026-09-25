import { existsSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express, { Router } from 'express';
import semver from 'semver';
import { requireAuth, requireScope } from '../auth.js';
import { conflict, forbidden, HttpError, fieldErrors, notFound } from '../errors.js';
import {
  buildSearchText,
  compareSemver,
  isPlainObject,
  isValidExtensionId,
  isValidNamespace,
  maxVersionBySemver,
  normalizeSemver,
} from '../util.js';
import { extensionDetailFromRow, versionToObject } from '../serialize.js';
import {
  addedAsOwnerMessage,
  notifyUser,
  removedAsOwnerMessage,
  reviewApprovedMessage,
  reviewRejectedMessage,
} from '../notify.js';
import { requireObjectBody } from './shared.js';
import { blobPathFor, removeBlobIfUnused, sha256Hex, sha512Base64, storeBlob } from '../blobs.js';
import { totalDownloads } from '../metrics.js';
import { makeWebhooks, WebhookInputError } from '../webhooks.js';
import { audit, auditSoon } from '../audit.js';

export function makePackagesRouter({ sql, config, termsGate }) {
  const router = Router();
  const webhooks = makeWebhooks({ sql });

  const yankChain = [requireAuth, termsGate, requireScope('yank')];
  const ownerChain = [requireAuth, termsGate];
  const publishChain = [requireAuth, termsGate, requireScope('publish')];

  async function isExtensionOwner(user, namespace, id) {
    if (user.role === 'admin') return true;
    if (user.namespace === namespace) return true;
    const [row] = await sql`
      SELECT 1 FROM extension_owners
      WHERE owner_id = ${user.id} AND namespace = ${namespace} AND extension_id = ${id}
    `;
    return Boolean(row);
  }

  // Owners and admins see everything; a private extension is additionally
  // visible to accounts holding an explicit access grant.
  async function canSee(user, row) {
    if (row.visibility !== 'private') return true;
    if (!user) return false;
    if (user.role === 'admin' || user.namespace === row.namespace) return true;
    const [ownerRow] = await sql`
      SELECT 1 FROM extension_owners
      WHERE owner_id = ${user.id} AND namespace = ${row.namespace} AND extension_id = ${row.extension_id}
    `;
    if (ownerRow) return true;
    const [grant] = await sql`
      SELECT 1 FROM extension_access
      WHERE user_id = ${user.id} AND namespace = ${row.namespace} AND extension_id = ${row.extension_id}
    `;
    return Boolean(grant);
  }

  async function loadNamespaceAccount(namespace) {
    const [owner] = await sql`SELECT * FROM users WHERE namespace = ${namespace}`;
    return owner;
  }

  async function loadVersion(namespace, id, version) {
    const [row] = await sql`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id} AND version = ${version}
    `;
    return row;
  }

  // Most recent non-rejected row, enough to decide visibility without pulling
  // the whole version set. A direct status probe would miss extensions whose
  // only row was rejected.
  async function loadVisibility(namespace, id) {
    const [row] = await sql`
      SELECT namespace, extension_id, visibility FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id} AND status <> 'rejected'
      ORDER BY id DESC
      LIMIT 1
    `;
    return row;
  }

  async function loadLatestPublished(namespace, id) {
    const rows = await sql`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id}
        AND status IN ('published', 'deprecated')
    `;
    if (rows.length === 0) return null;
    const published = rows.filter((row) => row.status === 'published');
    const pool = published.length > 0 ? published : rows;
    const ceiling = maxVersionBySemver(pool.map((row) => row.version));
    return pool.find((row) => row.version === ceiling);
  }

  async function resolveVersion(params) {
    const { namespace, id, version } = params;
    const row =
      version === 'latest'
        ? await loadLatestPublished(namespace, id)
        : await loadVersion(namespace, id, version);
    if (row) return row;
    if (!/^[a-zA-Z0-9-]{1,30}$/.test(version)) throw notFound();
    const [tagRow] = await sql`
      SELECT version FROM dist_tags
      WHERE namespace = ${namespace} AND extension_id = ${id} AND tag = ${version}
    `;
    if (!tagRow) throw notFound();
    return await loadVersion(namespace, id, tagRow.version);
  }

  router.get('/@:namespace/:id/versions/resolve', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const range = typeof req.query.range === 'string' ? req.query.range.trim() : '';
    if (!range || !semver.validRange(range)) {
      throw fieldErrors([{ field: 'range', message: 'Must be a valid SemVer range.' }]);
    }
    const visibility = await loadVisibility(namespace, id);
    if (!visibility || !(await canSee(req.auth?.user, visibility))) throw notFound();
    const rows = await sql`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id}
        AND status IN ('published', 'deprecated')
    `;
    const candidates = rows
      .map((row) => ({ row, coerced: semver.valid(row.version) }))
      .filter(
        (entry) =>
          entry.coerced && semver.satisfies(entry.coerced, range, { includePrerelease: true }),
      );
    const best = maxVersionBySemver(candidates.map((entry) => entry.coerced));
    const match = candidates.find((entry) => entry.coerced === best);
    if (!match) throw notFound('No published version satisfies that range.');
    res.json(versionToObject(match.row, config));
  });

  router.post(
    '/@:namespace/:id/versions',
    requireAuth,
    express.json({ limit: '25mb' }),
    termsGate,
    requireScope('publish'),
    async (req, res) => {
      const { namespace, id } = req.params;
      requireObjectBody(req);
      if (!isValidExtensionId(id)) {
        throw fieldErrors([{ field: 'id', message: 'Invalid extension id.' }]);
      }

      const { manifest, code } = req.body;
      const errors = [];
      if (!isPlainObject(manifest)) {
        errors.push({ field: 'manifest', message: 'Manifest is required.' });
      } else {
        if (!isValidExtensionId(manifest.id)) {
          errors.push({
            field: 'manifest.id',
            message: 'Must match a-z and 0-9, up to 64 characters.',
          });
        }
        if (manifest.id !== id) {
          errors.push({
            field: 'manifest.id',
            message: `Must equal the id in the path ("${id}").`,
          });
        }
        if (!normalizeSemver(manifest.version)) {
          errors.push({ field: 'manifest.version', message: 'Must be a valid SemVer string.' });
        }
        if (typeof manifest.license !== 'string' || manifest.license.length === 0) {
          errors.push({
            field: 'manifest.license',
            message: 'License (SPDX identifier) is required.',
          });
        }
        if (typeof manifest.description !== 'string') {
          errors.push({ field: 'manifest.description', message: 'Description is required.' });
        }
        if (
          manifest.name !== undefined &&
          (typeof manifest.name !== 'string' || manifest.name.length === 0)
        ) {
          errors.push({
            field: 'manifest.name',
            message: 'Must be a non-empty string when provided.',
          });
        }
        if (manifest.author !== undefined && typeof manifest.author !== 'string') {
          errors.push({ field: 'manifest.author', message: 'Must be a string when provided.' });
        }
        for (const color of ['color1', 'color2', 'color3']) {
          if (
            manifest[color] !== undefined &&
            (typeof manifest[color] !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(manifest[color]))
          ) {
            errors.push({
              field: `manifest.${color}`,
              message: `Must be "#RRGGBB" when provided.`,
            });
          }
        }
      }
      if (typeof code !== 'string' || code.length === 0) {
        errors.push({ field: 'code', message: 'The compiled Twext output is required.' });
      }
      if (
        req.body.visibility !== undefined &&
        req.body.visibility !== 'public' &&
        req.body.visibility !== 'private'
      ) {
        errors.push({ field: 'visibility', message: 'Must be "public" or "private".' });
      }
      if (errors.length > 0) throw fieldErrors(errors);

      if (!isValidNamespace(namespace)) throw notFound();
      const owner = await loadNamespaceAccount(namespace);
      if (!owner) throw notFound('No such publishing account.');
      if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
        throw forbidden('You can only publish to an extension you own.');
      }

      // Size caps: per-blob, then the account's cumulative quota (their own
      // override when set, otherwise the configured default).
      const codeBytes = Buffer.byteLength(code, 'utf8');
      const maxBlob = config.limits?.maxBlobBytes ?? 2 * 1024 * 1024;
      if (codeBytes > maxBlob) {
        throw new HttpError(413, {
          title: 'Payload Too Large',
          detail: `Compiled output is ${codeBytes} bytes; the limit is ${maxBlob}.`,
        });
      }
      const quota = owner.max_blob_bytes ?? config.limits?.maxAccountBlobBytes ?? 64 * 1024 * 1024;
      if (Number(owner.blob_bytes ?? 0) + codeBytes > quota) {
        throw new HttpError(413, {
          title: 'Payload Too Large',
          detail: `Publishing ${codeBytes} bytes would exceed the ${quota}-byte storage quota for @${owner.namespace}.`,
        });
      }

      const row = await publishVersion(sql, config, owner, {
        id,
        manifest,
        code,
        visibility: req.body.visibility,
        stagedBy: req.auth.user,
      });
      auditSoon(
        sql,
        req.auth.user,
        'version.publish',
        { namespace, id, version: row.version },
        { status: row.status, visibility: row.visibility, bytes: codeBytes },
      );
      if (row.status === 'published') {
        void webhooks.scheduleFor(namespace, id, 'version.published', {
          version: row.version,
          occurredAt: new Date().toISOString(),
          actor: req.auth.user.namespace,
        });
      }
      res.status(201).json(versionToObject(row, config));
    },
  );

  router.get('/@:namespace/:id/webhooks', publishChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can list webhooks.');
    }
    res.json({ data: await webhooks.list(namespace, id) });
  });

  router.post('/@:namespace/:id/webhooks', publishChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can create webhooks.');
    }
    requireObjectBody(req);
    try {
      const created = await webhooks.create(namespace, id, req.body);
      res.status(201).json(created);
    } catch (error) {
      if (error instanceof WebhookInputError) {
        throw fieldErrors(error.fields);
      }
      throw error;
    }
  });

  router.delete('/@:namespace/:id/webhooks/:webhookId', publishChain, async (req, res) => {
    const { namespace, id, webhookId } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can delete webhooks.');
    }
    const removed = await webhooks.remove(namespace, id, Number(webhookId));
    if (!removed) throw notFound();
    res.status(204).end();
  });

  router.get('/@:namespace/:id/tags', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const visibility = await loadVisibility(namespace, id);
    if (!visibility || !(await canSee(req.auth?.user, visibility))) throw notFound();
    const rows = await sql`
      SELECT tag, version FROM dist_tags
      WHERE namespace = ${namespace} AND extension_id = ${id}
      ORDER BY tag
    `;
    const tags = Object.fromEntries(rows.map((row) => [row.tag, row.version]));
    if (Object.keys(tags).length === 0) throw notFound();
    res.json(tags);
  });

  router.put('/@:namespace/:id/tags/:tag', publishChain, async (req, res) => {
    const { namespace, id, tag } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (tag === 'latest' || !/^[a-zA-Z0-9-]{1,30}$/.test(tag)) {
      throw fieldErrors([
        {
          field: 'tag',
          message: 'Must be 1-30 letters, digits, or hyphens; "latest" is reserved.',
        },
      ]);
    }
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can set tags.');
    }
    requireObjectBody(req);
    const version = req.body.version;
    const normalized = normalizeSemver(version);
    if (!normalized) {
      throw fieldErrors([{ field: 'version', message: 'Must be a valid SemVer string.' }]);
    }
    const [exists] = await sql`
        SELECT 1 FROM versions
        WHERE namespace = ${namespace} AND extension_id = ${id}
          AND version = ${normalized} AND status = 'published'
      `;
    if (!exists) throw notFound('Tagged versions must be published.');
    await sql`
        INSERT INTO dist_tags (owner_id, namespace, extension_id, tag, version)
        VALUES (${req.auth.user.id}, ${namespace}, ${id}, ${tag}, ${normalized})
        ON CONFLICT (namespace, extension_id, tag)
        DO UPDATE SET version = EXCLUDED.version, owner_id = EXCLUDED.owner_id
      `;
    auditSoon(sql, req.auth.user, 'tag.set', { namespace, id, version: normalized }, { tag });
    res.status(204).end();
  });

  router.delete('/@:namespace/:id/tags/:tag', publishChain, async (req, res) => {
    const { namespace, id, tag } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (tag === 'latest') {
      throw fieldErrors([{ field: 'tag', message: '"latest" is reserved.' }]);
    }
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can remove tags.');
    }
    const [deleted] = await sql`
      DELETE FROM dist_tags
      WHERE namespace = ${namespace} AND extension_id = ${id} AND tag = ${tag}
      RETURNING 1
    `;
    if (!deleted) throw notFound();
    auditSoon(sql, req.auth.user, 'tag.remove', { namespace, id }, { tag });
    res.status(204).end();
  });

  router.get('/@:namespace/:id/versions/:version', async (req, res) => {
    const row = await resolveVersion(req.params);
    const isVisible =
      row.status === 'published' || row.status === 'yanked' || row.status === 'deprecated';
    if (!isVisible) {
      const isOwner = req.auth?.user.namespace === req.params.namespace;
      const isAdmin = req.auth?.user.role === 'admin';
      if (!isOwner && !isAdmin) throw notFound();
    }
    if (isVisible && !(await canSee(req.auth?.user, row))) throw notFound();
    res.json(versionToObject(row, config));
  });

  router.patch(
    '/@:namespace/:id/versions/:version/deprecate',
    requireAuth,
    termsGate,
    requireScope('publish'),
    async (req, res) => {
      const { namespace, id, version } = req.params;
      if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
      requireObjectBody(req);
      const message = req.body.message;
      if (
        message !== undefined &&
        message !== null &&
        (typeof message !== 'string' || message.trim().length === 0)
      ) {
        throw fieldErrors([
          { field: 'message', message: 'Must be a non-empty string, or null to clear.' },
        ]);
      }
      const [row] = await sql`
        SELECT * FROM versions
        WHERE namespace = ${namespace} AND extension_id = ${id} AND version = ${version}
      `;
      if (!row || (row.status !== 'published' && row.status !== 'deprecated')) throw notFound();
      const canManage = await isExtensionOwner(req.auth.user, namespace, id);
      if (!canManage) {
        throw forbidden('Only an owner or an admin can deprecate this version.');
      }
      const [updated] = await sql`
        UPDATE versions
        SET status = ${message === null ? 'published' : 'deprecated'},
            deprecation_message = ${message ?? null}
        WHERE id = ${row.id}
        RETURNING *
      `;
      auditSoon(
        sql,
        req.auth.user,
        message === null ? 'version.undeprecate' : 'version.deprecate',
        { namespace, id, version: updated.version },
        { message: message ?? null },
      );
      void webhooks.scheduleFor(namespace, id, 'version.deprecated', {
        version: updated.version,
        occurredAt: new Date().toISOString(),
        actor: req.auth.user.namespace,
      });
      res.json(versionToObject(updated, config));
    },
  );

  router.patch('/@:namespace/:id/versions/:version', requireAuth, termsGate, async (req, res) => {
    if (req.auth.user.role !== 'admin') throw forbidden('Admin privileges are required.');
    if (req.auth.tokenType !== 'session') {
      throw forbidden('Automation tokens cannot access this endpoint.');
    }
    const { namespace, id, version } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const [row] = await sql`
        SELECT * FROM versions
        WHERE namespace = ${namespace} AND extension_id = ${id} AND version = ${version}
          AND status = 'pending'
      `;
    if (!row) throw notFound('No pending version matches that address.');

    requireObjectBody(req);
    const status = req.body.status;
    if (status !== 'approved' && status !== 'rejected') {
      throw fieldErrors([{ field: 'status', message: 'Must be "approved" or "rejected".' }]);
    }

    if (status === 'rejected') {
      const reason = req.body.reason;
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw fieldErrors([{ field: 'reason', message: 'A reason is required when rejecting.' }]);
      }
      const updated = await sql.begin(async (tx) => {
        const rows = await tx`
          UPDATE versions SET status = 'rejected', rejection_reason = ${reason}
          WHERE id = ${row.id} AND status = 'pending'
          RETURNING *
        `;
        if (rows[0]) {
          await notifyUser(
            tx,
            row.owner_id,
            'review.rejected',
            reviewRejectedMessage(row.extension_id, row.version, reason),
            { namespace: row.namespace, id: row.extension_id, version: row.version, reason },
          );
          await audit(
            tx,
            req.auth.user,
            'version.reject',
            { namespace, id, version: row.version },
            { reason },
          );
        }
        return rows[0];
      });
      if (!updated) {
        throw conflict('That version is no longer pending review.');
      }
      void webhooks.scheduleFor(namespace, id, 'version.rejected', {
        version: updated.version,
        occurredAt: new Date().toISOString(),
        actor: req.auth.user.namespace,
      });
      return res.json(versionToObject(updated, config));
    }

    const updated = await sql.begin(async (tx) => {
      const rows = await tx`
        UPDATE versions SET status = 'published', published_at = now()
        WHERE id = ${row.id} AND status = 'pending'
        RETURNING *
      `;
      if (rows[0]) {
        await tx`UPDATE users SET has_published = true WHERE id = ${row.owner_id}`;
        await notifyUser(
          tx,
          row.owner_id,
          'review.approved',
          reviewApprovedMessage(row.namespace, row.extension_id, row.version),
          { namespace: row.namespace, id: row.extension_id, version: row.version },
        );
        await audit(tx, req.auth.user, 'version.approve', { namespace, id, version: row.version });
      }
      return rows[0];
    });
    if (!updated) {
      throw conflict('That version is no longer pending review.');
    }
    void webhooks.scheduleFor(namespace, id, 'version.published', {
      version: updated.version,
      occurredAt: new Date().toISOString(),
      actor: req.auth.user.namespace,
    });
    res.json(versionToObject(updated, config));
  });

  router.delete('/@:namespace/:id/versions/:version', yankChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await resolveVersion(req.params);
    if (row.status !== 'published' && row.status !== 'deprecated') throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('You can only yank your own extensions.');
    }
    await sql`UPDATE versions SET status = 'yanked' WHERE id = ${row.id}`;
    auditSoon(sql, req.auth.user, 'version.yank', { namespace, id, version: row.version });
    void webhooks.scheduleFor(namespace, id, 'version.yanked', {
      version: row.version,
      occurredAt: new Date().toISOString(),
      actor: req.auth.user.namespace,
    });
    res.status(204).end();
  });

  router.get('/@:namespace/:id/versions/:version/download', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await resolveVersion(req.params);
    const isPublished =
      row.status === 'published' || row.status === 'yanked' || row.status === 'deprecated';
    const isAdmin = req.auth?.user.role === 'admin' && req.auth.tokenType === 'session';
    if (!isPublished && !(row.status === 'pending' && isAdmin)) throw notFound();
    if (isPublished && !(await canSee(req.auth?.user, row))) throw notFound();
    const abs = row.blob_digest
      ? blobPathFor(config.dataDir, row.blob_digest)
      : path.join(config.dataDir, row.blob_path);
    if (existsSync(abs)) {
      res.type('application/javascript');
      res.sendFile(abs);
      void sql`
        INSERT INTO download_events (namespace, extension_id, version, user_agent, remote_addr)
        VALUES (${row.namespace}, ${row.extension_id}, ${row.version},
                ${String(req.headers['user-agent'] ?? '').slice(0, 250)},
                ${req.ip})
      `.catch(() => {});
    } else {
      throw notFound('Compiled output is missing.');
    }
  });

  router.get('/@:namespace/:id/owners', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const visibility = await loadVisibility(namespace, id);
    if (!visibility || !(await canSee(req.auth?.user, visibility))) throw notFound();
    const rows = await sql`
      SELECT u.namespace, u.display_name, u.role, u.created_at, o.added_at
      FROM extension_owners o
      JOIN users u ON u.id = o.owner_id
      WHERE o.namespace = ${namespace} AND o.extension_id = ${id}
      ORDER BY o.added_at
    `;
    res.json({ data: rows });
  });

  router.put('/@:namespace/:id/owners/:ownerNamespace', ownerChain, async (req, res) => {
    const { namespace: targetNamespace, id, ownerNamespace: candidate } = req.params;
    if (req.auth.user.namespace !== targetNamespace && req.auth.user.role !== 'admin') {
      throw forbidden('Only an existing owner or an admin can add owners.');
    }
    if (
      !isValidNamespace(targetNamespace) ||
      !isValidNamespace(candidate) ||
      !isValidExtensionId(id)
    ) {
      throw notFound();
    }
    const [existing] = await sql`
        SELECT 1 FROM versions
        WHERE namespace = ${targetNamespace} AND extension_id = ${id} AND status <> 'rejected'
      `;
    if (!existing) throw notFound();
    const [candidateUser] = await sql`
        SELECT * FROM users WHERE namespace = ${candidate}
      `;
    if (!candidateUser) throw notFound('No such account to add.');
    await sql.begin(async (tx) => {
      await tx`
          INSERT INTO extension_owners (owner_id, namespace, extension_id, added_by)
          VALUES (${candidateUser.id}, ${targetNamespace}, ${id}, ${req.auth.user.id})
          ON CONFLICT (namespace, extension_id, owner_id) DO NOTHING
        `;
      if (candidateUser.id !== req.auth.user.id) {
        await notifyUser(
          tx,
          candidateUser.id,
          'extension.owner.added',
          addedAsOwnerMessage(req.auth.user.namespace, targetNamespace, id),
          { namespace: targetNamespace, id },
        );
      }
      await audit(
        tx,
        req.auth.user,
        'owner.add',
        { namespace: targetNamespace, id },
        { added: candidateUser.namespace },
      );
    });
    void webhooks.scheduleFor(targetNamespace, id, 'owners.changed', {
      actor: req.auth.user.namespace,
      added: candidateUser.namespace,
      occurredAt: new Date().toISOString(),
    });
    res.status(204).end();
  });

  router.delete('/@:namespace/:id/owners/:ownerNamespace', ownerChain, async (req, res) => {
    const { namespace: targetNamespace, id, ownerNamespace: target } = req.params;
    if (
      !isValidNamespace(targetNamespace) ||
      !isValidNamespace(target) ||
      !isValidExtensionId(id)
    ) {
      throw notFound();
    }
    if (req.auth.user.namespace !== targetNamespace && req.auth.user.role !== 'admin') {
      throw forbidden('Only an owner or an admin can remove owners.');
    }
    const [account] = await sql`
        SELECT 1 FROM versions
        WHERE namespace = ${targetNamespace} AND extension_id = ${id} AND status <> 'rejected'
      `;
    if (!account) throw notFound();
    if (target === targetNamespace) {
      throw fieldErrors([
        {
          field: 'namespace',
          message: 'The namespace account owns the published address and cannot be removed.',
        },
      ]);
    }
    const [candidateUser] = await sql`
        SELECT * FROM users WHERE namespace = ${target}
      `;
    if (!candidateUser) throw notFound('No such account.');
    const [deleted] = await sql.begin(async (tx) => {
      const [r] = await tx`
          DELETE FROM extension_owners
          WHERE owner_id = ${candidateUser.id} AND namespace = ${targetNamespace} AND extension_id = ${id}
          RETURNING 1
        `;
      if (r) {
        await notifyUser(
          tx,
          candidateUser.id,
          'extension.owner.removed',
          removedAsOwnerMessage(req.auth.user.namespace, targetNamespace, id),
          { namespace: targetNamespace, id },
        );
        await audit(
          tx,
          req.auth.user,
          'owner.remove',
          { namespace: targetNamespace, id },
          { removed: candidateUser.namespace },
        );
      }
      return [r].filter(Boolean);
    });
    if (!deleted) throw notFound('That account is not an owner.');
    void webhooks.scheduleFor(targetNamespace, id, 'owners.changed', {
      actor: req.auth.user.namespace,
      removed: target,
      occurredAt: new Date().toISOString(),
    });
    res.status(204).end();
  });

  // Access grants for private extensions. Only meaningful on private
  // extensions, but recorded either way so a later flip to private keeps
  // grants intact.
  router.put('/@:namespace/:id/access/:granteeNamespace', ownerChain, async (req, res) => {
    const { namespace: targetNamespace, id, granteeNamespace: grantee } = req.params;
    if (
      !isValidNamespace(targetNamespace) ||
      !isValidNamespace(grantee) ||
      !isValidExtensionId(id)
    ) {
      throw notFound();
    }
    if (req.auth.user.namespace !== targetNamespace && req.auth.user.role !== 'admin') {
      throw forbidden('Only an owner or an admin can grant access.');
    }
    const [existing] = await sql`
      SELECT 1 FROM versions
      WHERE namespace = ${targetNamespace} AND extension_id = ${id} AND status <> 'rejected'
    `;
    if (!existing) throw notFound();
    const [granteeUser] = await sql`SELECT * FROM users WHERE namespace = ${grantee}`;
    if (!granteeUser) throw notFound('No such account to grant.');
    if (granteeUser.namespace === targetNamespace) {
      throw fieldErrors([
        { field: 'namespace', message: 'The namespace account always has access.' },
      ]);
    }
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO extension_access (user_id, namespace, extension_id, granted_by)
        VALUES (${granteeUser.id}, ${targetNamespace}, ${id}, ${req.auth.user.id})
        ON CONFLICT (user_id, namespace, extension_id) DO NOTHING
      `;
      await audit(
        tx,
        req.auth.user,
        'access.grant',
        { namespace: targetNamespace, id },
        { granted: granteeUser.namespace },
      );
    });
    res.status(204).end();
  });

  router.delete('/@:namespace/:id/access/:granteeNamespace', ownerChain, async (req, res) => {
    const { namespace: targetNamespace, id, granteeNamespace: grantee } = req.params;
    if (
      !isValidNamespace(targetNamespace) ||
      !isValidNamespace(grantee) ||
      !isValidExtensionId(id)
    ) {
      throw notFound();
    }
    if (req.auth.user.namespace !== targetNamespace && req.auth.user.role !== 'admin') {
      throw forbidden('Only an owner or an admin can revoke access.');
    }
    const [granteeUser] = await sql`SELECT * FROM users WHERE namespace = ${grantee}`;
    if (!granteeUser) throw notFound('No such account.');
    const [revoked] = await sql.begin(async (tx) => {
      const [r] = await tx`
        DELETE FROM extension_access
        WHERE user_id = ${granteeUser.id} AND namespace = ${targetNamespace} AND extension_id = ${id}
        RETURNING 1
      `;
      if (r) {
        await audit(
          tx,
          req.auth.user,
          'access.revoke',
          { namespace: targetNamespace, id },
          { revoked: granteeUser.namespace },
        );
      }
      return [r].filter(Boolean);
    });
    if (!revoked) throw notFound('That account has no access grant.');
    res.status(204).end();
  });

  router.get('/@:namespace/:id/access', publishChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
      throw forbidden('Only an owner or an admin can list access grants.');
    }
    const rows = await sql`
      SELECT u.namespace, u.display_name, a.created_at
      FROM extension_access a
      JOIN users u ON u.id = a.user_id
      WHERE a.namespace = ${namespace} AND a.extension_id = ${id}
      ORDER BY a.created_at
    `;
    res.json({ data: rows });
  });

  router.get('/@:namespace/:id', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const rows = await sql`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id}
        AND status IN ('published', 'deprecated')
      ORDER BY
        CASE WHEN status = 'published' THEN 0 ELSE 1 END,
        created_at DESC
    `;
    if (rows.length === 0) throw notFound();
    if (!(await canSee(req.auth?.user, rows[0]))) throw notFound();
    const sorted = [...rows].sort((a, b) => compareSemver(b.version, a.version));
    const top = sorted.find((row) => row.status === 'published') ?? sorted[0];
    const summary = extensionDetailFromRow(
      top,
      sorted.map((row) => versionToObject(row, config)),
    );
    summary.downloads = await totalDownloads(sql, namespace, id);
    res.json(summary);
  });

  router.delete('/@:namespace/:id', ownerChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const lockKey = `${namespace}/${id}`;
    const reserved = await sql.reserve();
    try {
      // Hold a session-scoped lock for the same key publishVersion uses so the
      // per-extension exclusion also covers blob cleanup. If it were released
      // with the delete transaction, a concurrent publish could reuse a blob
      // path and have its freshly written bytes removed by this cleanup.
      await reserved`SELECT pg_advisory_lock(hashtextextended(${lockKey}, 0))`;
      let rows;
      await reserved`BEGIN`;
      try {
        if (!(await isExtensionOwner(req.auth.user, namespace, id))) {
          throw forbidden('You can only delete your own extensions.');
        }
        rows = await reserved`
          SELECT blob_digest, blob_path, status, blob_size, visibility FROM versions
          WHERE namespace = ${namespace} AND extension_id = ${id}
        `;
        if (rows.length === 0) throw notFound();
        if (rows.some((row) => row.status === 'staging')) {
          throw conflict('A publish is in progress for this extension.');
        }
        await reserved`DELETE FROM versions WHERE namespace = ${namespace} AND extension_id = ${id}`;
        // Refund the account's quota for every byte this extension charged.
        const charged = rows.reduce((sum, row) => sum + Number(row.blob_size ?? 0), 0);
        if (charged > 0) {
          const [account] = await reserved`SELECT id FROM users WHERE namespace = ${namespace}`;
          if (account) {
            await reserved`
              UPDATE users SET blob_bytes = GREATEST(blob_bytes - ${charged}, 0)
              WHERE id = ${account.id}
            `;
          }
        }
        await reserved`COMMIT`;
      } catch (error) {
        try {
          await reserved`ROLLBACK`;
        } catch {
          // surface the original error
        }
        throw error;
      }
      await Promise.all(
        rows.map(async (version) => {
          if (version.blob_digest) {
            await removeBlobIfUnused(sql, config, version.blob_digest, null);
          } else if (version.blob_path) {
            await rm(path.join(config.dataDir, version.blob_path), { force: true });
          }
        }),
      );
      auditSoon(
        sql,
        req.auth.user,
        'extension.delete',
        { namespace, id },
        {
          versions: rows.length,
          bytesRefunded: rows.reduce((sum, row) => sum + Number(row.blob_size ?? 0), 0),
        },
      );
      res.status(204).end();
    } finally {
      try {
        await reserved`SELECT pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
      } finally {
        reserved.release();
      }
    }
  });

  return router;
}

async function publishVersion(sql, config, owner, { id, manifest, code, visibility, stagedBy }) {
  const version = normalizeSemver(manifest.version);
  const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : id;
  const codeBuffer = Buffer.from(code, 'utf8');
  const digest = sha256Hex(codeBuffer);
  const sha512 = sha512Base64(codeBuffer);
  const blobRelative = path.join('blobs', digest.slice(0, 2), digest.slice(2));
  const tmpDir = path.join(config.dataDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `upload-${randomBytes(8).toString('hex')}.tmp`);
  const lockKey = `${owner.namespace}/${id}`;
  const credentialOwner = stagedBy ?? owner;

  const searchText = buildSearchText({
    name,
    id,
    namespace: owner.namespace,
    description: manifest.description,
  });

  const finalStatus = owner.has_published ? 'published' : 'pending';

  try {
    await writeFile(tmpPath, codeBuffer);

    const staged = await sql.begin(async (tx) => {
      // Serialize per namespace/extension so concurrent publishes cannot both
      // validate against the same ceiling snapshot.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

      const [pending] = await tx`
        SELECT 1 FROM versions
        WHERE owner_id = ${credentialOwner.id} AND status IN ('staging', 'pending')
      `;
      if (pending) {
        throw forbidden('The owner already has a version awaiting review.');
      }

      const existing = await tx`
        SELECT version FROM versions
        WHERE namespace = ${owner.namespace} AND extension_id = ${id}
      `;
      const ceiling = maxVersionBySemver(existing.map((row) => row.version));
      if (ceiling && !semver.gt(version, ceiling)) {
        throw new HttpError(422, {
          detail: `Version ${version} is not strictly greater than the current highest version (${ceiling}).`,
        });
      }

      const [staged] = await tx`
        INSERT INTO versions (
          owner_id, namespace, extension_id, version, status,
          name, license, description, author, color1, color2, color3,
          blob_path, blob_digest, blob_size, blob_sha512, search_text, visibility
        ) VALUES (
          ${credentialOwner.id}, ${owner.namespace}, ${id}, ${version}, 'staging',
          ${name}, ${manifest.license}, ${manifest.description}, ${manifest.author ?? null},
          ${manifest.color1 ?? null}, ${manifest.color2 ?? null}, ${manifest.color3 ?? null},
          ${blobRelative}, ${digest}, ${codeBuffer.length}, ${sha512}, ${searchText},
          ${visibility === 'private' ? 'private' : 'public'}
        )
        RETURNING *
      `;
      await tx`
        INSERT INTO extension_owners (owner_id, namespace, extension_id, added_by)
        VALUES (${owner.id}, ${owner.namespace}, ${id}, ${owner.id})
        ON CONFLICT (namespace, extension_id, owner_id) DO NOTHING
      `;
      // Charge the blob bytes to the namespace account. Identical content is
      // re-charged per version row; deleting a version refunds its bytes.
      await tx`
        UPDATE users SET blob_bytes = blob_bytes + ${codeBuffer.length}
        WHERE id = ${owner.id}
      `;
      return staged;
    });

    // The staging row commits before the blob is placed: uniqueness checks in
    // the transaction reject duplicate/lower-version publishes, so only the
    // committed version may write its blob. A crash before blob placement
    // leaves a staging row that reconcileOnBoot promotes once its blob exists
    // or removes when the blob is missing; promoting before storing the blob
    // would let a rolled-back request reach a later status.
    await storeBlob(config.dataDir, tmpPath, codeBuffer);

    const row = await sql.begin(async (tx) => {
      const promoted = await tx`
        UPDATE versions
        SET status = ${finalStatus},
            published_at = ${finalStatus === 'published' ? new Date() : null}
        WHERE id = ${staged.id}
        RETURNING *
      `;
      return promoted[0];
    });
    if (!row) {
      throw new HttpError(409, { detail: 'Version row disappeared before promotion.' });
    }
    return row;
  } catch (error) {
    rmSync(tmpPath, { force: true });
    if (error.code === '23505') {
      if (error.constraint === 'versions_one_pending_idx') {
        throw forbidden('The owner already has a version awaiting review.');
      }
      throw new HttpError(409, { detail: `Version ${version} already exists for this extension.` });
    }
    throw error;
  }
}
