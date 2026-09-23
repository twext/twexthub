import { existsSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express, { Router } from 'express';
import semver from 'semver';
import YAML from 'yaml';
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
import { notifyUser, reviewApprovedMessage, reviewRejectedMessage } from '../notify.js';
import { compileProject, resolveSourcePath } from '../compiler.js';
import { requireObjectBody } from './shared.js';

const VISIBILITIES = new Set(['public', 'unlisted', 'private']);
const README_FALLBACKS = ['readme.md', 'readme.markdown', 'readme.mkd', 'readme.txt', 'readme'];

export function makePackagesRouter({ sql, config, rateLimiter, termsGate }) {
  const router = Router();

  const yankChain = [requireAuth, termsGate, requireScope('yank')];
  const ownerChain = [requireAuth, termsGate];
  const publishRateLimit =
    rateLimiter?.publish?.((req) => (req.auth?.user ? `publish:${req.auth.user.id}` : 'publish')) ??
    ((_req, _res, next) => next());

  async function loadVersion(namespace, id, version) {
    const [row] = await sql`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id} AND version = ${version}
    `;
    return row;
  }

  async function loadLatestPublished(namespace, id) {
    const rows = await sql`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id} AND status = 'published'
    `;
    if (rows.length === 0) return null;
    const ceiling = maxVersionBySemver(rows.map((row) => row.version));
    return rows.find((row) => row.version === ceiling);
  }

  async function resolveVersion(params) {
    const { namespace, id, version } = params;
    const row =
      version === 'latest'
        ? await loadLatestPublished(namespace, id)
        : await loadVersion(namespace, id, version);
    if (!row) throw notFound();
    return row;
  }

  function canReadVersion(row, req) {
    const isOwner = req.auth?.user.namespace === row.namespace;
    const isAdmin = req.auth?.user.role === 'admin';
    if (isOwner || isAdmin) return true;
    if (row.status !== 'published' && row.status !== 'yanked') return false;
    return row.visibility !== 'private';
  }

  router.post(
    '/@:namespace/:id/versions',
    requireAuth,
    express.json({ limit: '25mb' }),
    termsGate,
    requireScope('publish'),
    publishRateLimit,
    async (req, res) => {
      const { namespace, id } = req.params;
      requireObjectBody(req);
      if (!isValidExtensionId(id)) {
        throw fieldErrors([{ field: 'id', message: 'Invalid extension id.' }]);
      }
      if (!isValidNamespace(namespace)) throw notFound();
      const [owner] = await sql`SELECT * FROM users WHERE namespace = ${namespace}`;
      if (!owner) throw notFound('No such publishing account.');
      if (req.auth.user.namespace !== namespace && req.auth.user.role !== 'admin') {
        throw forbidden('You can only publish to your own namespace.');
      }

      const { manifest, sources, twext, visibility } = req.body;
      const m = parseManifestField(manifest, id);
      const sourcesObj = validateSources(sources);

      if (
        visibility !== undefined &&
        (typeof visibility !== 'string' || !VISIBILITIES.has(visibility))
      ) {
        throw fieldErrors([
          { field: 'visibility', message: 'Must be "public", "unlisted", or "private".' },
        ]);
      }
      if (twext !== undefined && typeof twext !== 'string') {
        throw fieldErrors([{ field: 'twext', message: 'Must be a string when provided.' }]);
      }

      let compiled;
      try {
        compiled = await compileProject(config, {
          manifestSource: req.body.manifest,
          sources: sourcesObj,
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(502, { detail: `Build failed: ${error.message}` });
      }

      const readme = extractReadme(m.readme, sourcesObj);

      const row = await publishVersion(sql, config, owner, {
        id,
        manifest: m,
        manifestSource: req.body.manifest,
        sources: sourcesObj,
        twextVersion: twext ?? null,
        visibility: visibility ?? 'public',
        readme,
        output: compiled.output,
      });
      res.status(201).json(versionToObject(row, config, { includeSources: true }));
    },
  );

  router.get('/@:namespace/:id/versions/:version', async (req, res) => {
    const row = await resolveVersion(req.params);
    if (!canReadVersion(row, req)) throw notFound();
    const isOwner = req.auth?.user.namespace === row.namespace;
    const isAdmin = req.auth?.user.role === 'admin';
    res.json(versionToObject(row, config, { includeSources: isOwner || isAdmin }));
  });

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
        }
        return rows[0];
      });
      if (!updated) {
        throw conflict('That version is no longer pending review.');
      }
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
      }
      return rows[0];
    });
    if (!updated) {
      throw conflict('That version is no longer pending review.');
    }
    res.json(versionToObject(updated, config));
  });

  router.delete('/@:namespace/:id/versions/:version', yankChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await resolveVersion(req.params);
    if (row.status !== 'published') throw notFound();
    if (req.auth.user.namespace !== namespace && req.auth.user.role !== 'admin') {
      throw forbidden('You can only yank your own extensions.');
    }
    await sql`UPDATE versions SET status = 'yanked' WHERE id = ${row.id}`;
    res.status(204).end();
  });

  router.get('/@:namespace/:id/versions/:version/download', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await resolveVersion(req.params);
    const isOwner = req.auth?.user.namespace === row.namespace;
    const isAdmin = req.auth?.user.role === 'admin';
    const isPublished = row.status === 'published' || row.status === 'yanked';
    const canReviewBlob = row.status === 'pending' && isAdmin && req.auth.tokenType === 'session';
    if (!canDownload(row, { isPublished, isOwner, isAdmin, canReviewBlob })) throw notFound();
    const abs = path.join(config.dataDir, row.blob_path);
    if (!existsSync(abs)) throw notFound('Compiled output is missing.');
    res.type('application/javascript');
    res.sendFile(abs);
  });

  router.get('/@:namespace/:id', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const rows = await sql`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id} AND status = 'published'
    `;
    if (rows.length === 0) throw notFound();
    rows.sort((a, b) => compareSemver(b.version, a.version));
    const latest = rows[0];
    const isOwner = req.auth?.user.namespace === namespace;
    const isAdmin = req.auth?.user.role === 'admin';
    if (latest.visibility === 'private' && !isOwner && !isAdmin) throw notFound();
    res.json(
      extensionDetailFromRow(
        rows[0],
        rows.filter((row) => canReadVersion(row, req)).map((row) => versionToObject(row, config)),
      ),
    );
  });

  router.patch('/@:namespace/:id', ownerChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    requireObjectBody(req);
    const { visibility } = req.body;
    if (typeof visibility !== 'string' || !VISIBILITIES.has(visibility)) {
      throw fieldErrors([
        { field: 'visibility', message: 'Must be "public", "unlisted", or "private".' },
      ]);
    }
    const rows = await sql`
      SELECT * FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id} AND status = 'published'
    `;
    if (rows.length === 0) throw notFound();
    if (req.auth.user.namespace !== namespace && req.auth.user.role !== 'admin') {
      throw forbidden('You can only change your own extensions.');
    }
    const updated = await sql`
      UPDATE versions SET visibility = ${visibility}
      WHERE namespace = ${namespace} AND extension_id = ${id} AND status = 'published'
      RETURNING *
    `;
    const ceiling = maxVersionBySemver(updated.map((row) => row.version));
    const latest = updated.find((row) => row.version === ceiling);
    res.json(versionToObject(latest, config));
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
        if (req.auth.user.namespace !== namespace && req.auth.user.role !== 'admin') {
          throw forbidden('You can only delete your own extensions.');
        }
        rows = await reserved`
          SELECT blob_path, status, visibility FROM versions
          WHERE namespace = ${namespace} AND extension_id = ${id}
        `;
        if (rows.length === 0) throw notFound();
        if (rows.some((row) => row.status === 'staging')) {
          throw conflict('A publish is in progress for this extension.');
        }
        await reserved`DELETE FROM versions WHERE namespace = ${namespace} AND extension_id = ${id}`;
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
        rows.map((version) => rm(path.join(config.dataDir, version.blob_path), { force: true })),
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

function canDownload(row, { isPublished, isOwner, isAdmin, canReviewBlob }) {
  if (isOwner || isAdmin) return isPublished || canReviewBlob;
  if (!isPublished) return false;
  return row.visibility !== 'private';
}

function parseManifestField(manifestField, pathId) {
  if (typeof manifestField !== 'string' || manifestField.trim().length === 0) {
    throw fieldErrors([{ field: 'manifest', message: 'Manifest (twext.yml) is required.' }]);
  }
  let manifest;
  try {
    manifest = YAML.parse(manifestField);
  } catch (error) {
    throw fieldErrors([{ field: 'manifest', message: `Not valid YAML: ${error.message}` }]);
  }
  if (!isPlainObject(manifest)) {
    throw fieldErrors([{ field: 'manifest', message: 'Must be a YAML mapping.' }]);
  }

  const errors = [];
  const ext = manifest.extension;
  if (!isPlainObject(ext)) {
    errors.push({ field: 'manifest.extension', message: 'An "extension" section is required.' });
  } else {
    if (!isValidExtensionId(ext.id)) {
      errors.push({
        field: 'manifest.extension.id',
        message: 'Must match a-z and 0-9, up to 64 characters.',
      });
    }
    if (ext.id !== pathId) {
      errors.push({
        field: 'manifest.extension.id',
        message: `Must equal the id in the path ("${pathId}").`,
      });
    }
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
  if (
    manifest.readme !== undefined &&
    (typeof manifest.readme !== 'string' || manifest.readme.length === 0)
  ) {
    errors.push({
      field: 'manifest.readme',
      message: 'Must be a source path when provided.',
    });
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
  if (errors.length > 0) throw fieldErrors(errors);
  return manifest;
}

function validateSources(sources) {
  if (!isPlainObject(sources)) {
    throw fieldErrors([
      { field: 'sources', message: 'A sources map of paths to file contents is required.' },
    ]);
  }
  const entries = Object.entries(sources);
  if (entries.length === 0) {
    throw fieldErrors([{ field: 'sources', message: 'At least one source file is required.' }]);
  }
  const normalized = {};
  for (const [rel, content] of entries) {
    const safe = resolveSourcePath(rel);
    if (typeof content !== 'string') {
      throw fieldErrors([
        { field: 'sources', message: `Source ${JSON.stringify(rel)} must be a string.` },
      ]);
    }
    if (Object.hasOwn(normalized, safe)) {
      throw fieldErrors([
        { field: 'sources', message: `Duplicate source path ${JSON.stringify(rel)}.` },
      ]);
    }
    normalized[safe] = content;
  }
  return normalized;
}

function extractReadme(configuredPath, sources) {
  if (configuredPath !== undefined) {
    const key = resolveSourcePath(configuredPath);
    if (!Object.hasOwn(sources, key)) {
      throw fieldErrors([
        {
          field: 'manifest.readme',
          message: `Source path ${JSON.stringify(configuredPath)} not found among uploaded sources.`,
        },
      ]);
    }
    return sources[key];
  }
  const target = Object.keys(sources).find(
    (key) => key.split('/').length === 1 && README_FALLBACKS.includes(key.toLowerCase()),
  );
  return target ? sources[target] : null;
}

async function publishVersion(
  sql,
  config,
  owner,
  { id, manifest, manifestSource, sources, twextVersion, visibility, readme, output },
) {
  const version = normalizeSemver(manifest.version);
  const name =
    typeof manifest.name === 'string' && manifest.name.length > 0
      ? manifest.name
      : (manifest.extension?.name ?? id);
  const blobRelative = path.join('blobs', owner.namespace, id, `${version}.js`);
  const blobAbs = path.join(config.dataDir, blobRelative);
  const tmpDir = path.join(config.dataDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `upload-${randomBytes(8).toString('hex')}.tmp`);
  const lockKey = `${owner.namespace}/${id}`;
  const color1 = manifest.color1 ?? manifest.extension?.color1 ?? null;
  const color2 = manifest.color2 ?? manifest.extension?.color2 ?? null;
  const color3 = manifest.color3 ?? manifest.extension?.color3 ?? null;

  const searchText = buildSearchText({
    name,
    id,
    namespace: owner.namespace,
    description: manifest.description,
  });

  const finalStatus = owner.has_published ? 'published' : 'pending';

  try {
    await writeFile(tmpPath, output);

    const staged = await sql.begin(async (tx) => {
      // Serialize per namespace/extension so concurrent publishes cannot both
      // validate against the same ceiling snapshot.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;

      const [pending] = await tx`
        SELECT 1 FROM versions
        WHERE owner_id = ${owner.id} AND status IN ('staging', 'pending')
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
          owner_id, namespace, extension_id, version, status, visibility,
          name, license, description, author, color1, color2, color3,
          blob_path, search_text, manifest_source, sources, twext_version, readme
        ) VALUES (
          ${owner.id}, ${owner.namespace}, ${id}, ${version}, 'staging', ${visibility},
          ${name}, ${manifest.license}, ${manifest.description}, ${manifest.author ?? null},
          ${color1}, ${color2}, ${color3},
          ${blobRelative}, ${searchText}, ${manifestSource}, ${JSON.stringify(sources)}, ${twextVersion}, ${readme}
        )
        RETURNING *
      `;
      return staged;
    });

    // The staging row commits before the blob is placed: uniqueness checks in
    // the transaction reject duplicate/lower-version publishes, so only the
    // committed version may write blobAbs. A crash before blob placement
    // leaves a staging row that reconcileOnBoot promotes once its blob exists
    // or removes when the blob is missing; promoting before the rename would
    // let a rolled-back request leave its bytes at a concurrently committed
    // version's blob path.
    await mkdir(path.dirname(blobAbs), { recursive: true });
    await rename(tmpPath, blobAbs);

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
