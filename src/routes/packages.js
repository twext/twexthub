import { existsSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express, { Router } from 'express';
import semver from 'semver';
import { requireAuth, requireScope } from '../auth.js';
import { forbidden, HttpError, fieldErrors, notFound } from '../errors.js';
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
import { requireObjectBody } from './shared.js';

export function makePackagesRouter({ sql, config, termsGate }) {
  const router = Router();

  const yankChain = [requireAuth, termsGate, requireScope('yank')];
  const ownerChain = [requireAuth, termsGate];

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
      if (errors.length > 0) throw fieldErrors(errors);

      if (!isValidNamespace(namespace)) throw notFound();
      const [owner] = await sql`SELECT * FROM users WHERE namespace = ${namespace}`;
      if (!owner) throw notFound('No such publishing account.');
      if (req.auth.user.namespace !== namespace && req.auth.user.role !== 'admin') {
        throw forbidden('You can only publish to your own namespace.');
      }

      const row = await publishVersion(sql, config, owner, { id, manifest, code });
      res.status(201).json(versionToObject(row, config));
    },
  );

  router.get('/@:namespace/:id/versions/:version', async (req, res) => {
    const row = await resolveVersion(req.params);
    const isVisible = row.status === 'published' || row.status === 'yanked';
    const isOwner = req.auth?.user.namespace === req.params.namespace;
    const isAdmin = req.auth?.user.role === 'admin';
    if (!isVisible && !isOwner && !isAdmin) throw notFound();
    res.json(versionToObject(row, config));
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
      const [updated] = await sql`
          UPDATE versions SET status = 'rejected', rejection_reason = ${reason}
          WHERE id = ${row.id}
          RETURNING *
        `;
      return res.json(versionToObject(updated, config));
    }

    const [updated] = await sql`
        UPDATE versions SET status = 'published', published_at = now()
        WHERE id = ${row.id}
        RETURNING *
      `;
    await sql`UPDATE users SET has_published = true WHERE id = ${row.owner_id}`;
    res.json(versionToObject(updated, config));
  });

  router.delete('/@:namespace/:id/versions/:version', yankChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const row = await resolveVersion(req.params);
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
    if (row.status !== 'published' && row.status !== 'yanked') throw notFound();
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
    res.json(
      extensionDetailFromRow(
        rows[0],
        rows.map((row) => versionToObject(row, config)),
      ),
    );
  });

  router.delete('/@:namespace/:id', ownerChain, async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const rows = await sql`
      SELECT blob_path FROM versions
      WHERE namespace = ${namespace} AND extension_id = ${id}
    `;
    if (rows.length === 0) throw notFound();
    if (req.auth.user.namespace !== namespace && req.auth.user.role !== 'admin') {
      throw forbidden('You can only delete your own extensions.');
    }
    await sql`DELETE FROM versions WHERE namespace = ${namespace} AND extension_id = ${id}`;
    await Promise.all(
      rows.map((version) => rm(path.join(config.dataDir, version.blob_path), { force: true })),
    );
    res.status(204).end();
  });

  return router;
}

async function publishVersion(sql, config, owner, { id, manifest, code }) {
  const version = normalizeSemver(manifest.version);
  const name = typeof manifest.name === 'string' && manifest.name.length > 0 ? manifest.name : id;
  const blobRelative = path.join('blobs', owner.namespace, id, `${version}.js`);
  const blobAbs = path.join(config.dataDir, blobRelative);
  const tmpDir = path.join(config.dataDir, 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmpPath = path.join(tmpDir, `upload-${randomBytes(8).toString('hex')}.tmp`);

  const searchText = buildSearchText({
    name,
    id,
    namespace: owner.namespace,
    description: manifest.description,
  });

  const finalStatus = owner.has_published ? 'published' : 'pending';

  try {
    await writeFile(tmpPath, code);

    const row = await sql.begin(async (tx) => {
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
          owner_id, namespace, extension_id, version, status,
          name, license, description, author, color1, color2, color3,
          blob_path, search_text
        ) VALUES (
          ${owner.id}, ${owner.namespace}, ${id}, ${version}, 'staging',
          ${name}, ${manifest.license}, ${manifest.description}, ${manifest.author ?? null},
          ${manifest.color1 ?? null}, ${manifest.color2 ?? null}, ${manifest.color3 ?? null},
          ${blobRelative}, ${searchText}
        )
        RETURNING *
      `;

      const [row] = await tx`
        UPDATE versions
        SET status = ${finalStatus},
            published_at = ${finalStatus === 'published' ? new Date() : null}
        WHERE id = ${staged.id}
        RETURNING *
      `;
      return row;
    });

    await mkdir(path.dirname(blobAbs), { recursive: true });
    await rename(tmpPath, blobAbs);
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
