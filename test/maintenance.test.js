import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';
import { gcBlobs, scrubBlobs, getIntegrityErrors } from '../src/maintenance.js';
import { createDb, reconcileOnBoot } from '../src/db.js';
import { blobPathFor, sha256Hex } from '../src/blobs.js';

let app;
let sql;
let config;
before(async () => {
  ({ app, sql, config } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function publishAndApprove(adminToken, owner, id, code = `// ${id}`) {
  const ns = owner.user.namespace;
  await publishProject(app, ns, id, owner.token, { code });
  await request(app)
    .patch(`/v1/@${ns}/${id}/versions/1.0.0`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
}

test('gc removes blobs no version references and keeps live ones', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  await publishAndApprove(admin.token, owner, 'keeper', '// keeper bytes');

  const [row] = await sql`
    SELECT blob_digest FROM versions
    WHERE extension_id = 'keeper' AND blob_digest IS NOT NULL
  `;
  assert.ok(row, 'published version carries a digest');
  const liveAbs = blobPathFor(config.dataDir, row.blob_digest);
  assert.ok(fs.existsSync(liveAbs));

  // An orphan: correct shape, never referenced by any row. Backdated, because
  // the sweep leaves anything under an hour old alone in case a publish is
  // still in flight between the file write and its versions row.
  const orphanDigest = 'f'.repeat(64);
  const orphanAbs = blobPathFor(config.dataDir, orphanDigest);
  fs.mkdirSync(path.dirname(orphanAbs), { recursive: true });
  fs.writeFileSync(orphanAbs, 'orphaned bytes');
  const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(orphanAbs, stale, stale);

  // A second orphan, still fresh.
  const freshDigest = 'e'.repeat(64);
  const freshAbs = blobPathFor(config.dataDir, freshDigest);
  fs.mkdirSync(path.dirname(freshAbs), { recursive: true });
  fs.writeFileSync(freshAbs, 'in flight bytes');

  const removed = await gcBlobs(sql, config.dataDir);
  assert.equal(removed, 1);
  assert.ok(fs.existsSync(liveAbs), 'referenced blob survives');
  assert.ok(!fs.existsSync(orphanAbs), 'stale orphan is gone');
  assert.ok(fs.existsSync(freshAbs), 'fresh orphan is left for the next pass');
});

test('scrub reports missing and corrupted blobs and updates the error gauge', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  await publishAndApprove(admin.token, owner, 'watched', '// watched bytes');

  const [row] = await sql`
    SELECT blob_digest FROM versions
    WHERE extension_id = 'watched' AND blob_digest IS NOT NULL
  `;
  const abs = blobPathFor(config.dataDir, row.blob_digest);

  // Clean disk: no problems, gauge zeroed.
  assert.deepEqual(await scrubBlobs(sql, config.dataDir), []);
  assert.equal(getIntegrityErrors(), 0);

  // Corrupt the stored blob in place.
  fs.writeFileSync(abs, 'totally different bytes');
  const corrupt = await scrubBlobs(sql, config.dataDir);
  assert.equal(corrupt.length, 1);
  assert.equal(corrupt[0].problem, 'mismatch');
  assert.equal(getIntegrityErrors(), 1);

  // Missing file reports as missing.
  fs.rmSync(abs);
  const missing = await scrubBlobs(sql, config.dataDir);
  assert.equal(missing.length, 1);
  assert.equal(missing[0].problem, 'missing');
  assert.equal(getIntegrityErrors(), 1);

  // The scrub only reports; the download endpoint and rows are untouched.
  const dl = await request(app)
    .get(`/v1/@${owner.user.namespace}/watched/versions/1.0.0/download`)
    .expect(404);
  assert.equal(dl.status, 404);
});

// A staging row is what a publish interrupted mid-write leaves behind: the
// digest is already known and the blob already sits where it belongs, because
// the row commits before the file is written.
async function insertStaging(namespace, publisherId, id, bytes, { keepBlob }) {
  const content = `// ${id}`;
  const digest = sha256Hex(content);
  const rel = path.join('blobs', digest.slice(0, 2), digest.slice(2));
  const abs = path.join(config.dataDir, rel);
  if (keepBlob) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const [row] = await sql`
    INSERT INTO versions
      (owner_id, namespace, extension_id, version, status, name, license,
       description, blob_path, blob_digest, blob_size, created_at)
    VALUES (${publisherId}, ${namespace}, ${id}, '1.0.0', 'staging', ${id},
            'MIT', '', ${rel}, ${digest}, ${bytes}, now() - interval '2 hours')
    RETURNING id, status
  `;
  return { ...row, rel, abs, content, digest };
}

test('boot reconciliation decides the status from the namespace account', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const helper = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  const [{ id: helperId }] =
    await sql`SELECT id FROM users WHERE namespace = ${helper.user.namespace}`;
  // The namespace account is past its first publish, so new work skips review.
  await sql`UPDATE users SET has_published = true WHERE namespace = ${ns}`;

  const staging = await insertStaging(ns, helperId, 'crashed', 0, { keepBlob: true });
  await reconcileOnBoot(sql, config);

  const [row] = await sql`SELECT status, published_at FROM versions WHERE id = ${staging.id}`;
  assert.equal(row.status, 'published', 'the namespace account, not the publisher, owns the gate');
  assert.ok(row.published_at, 'a promoted version gets a published_at');

  // The promotion is only real if the row is serviceable afterwards.
  const download = await request(app).get(`/v1/@${ns}/crashed/versions/1.0.0/download`).expect(200);
  assert.equal(download.text, staging.content);
  fs.rmSync(staging.abs);
});

test('boot reconciliation refunds the charge when the staging row is dropped', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  const [{ id: ownerId }] = await sql`SELECT id FROM users WHERE namespace = ${ns}`;
  await sql`UPDATE users SET blob_bytes = 900 WHERE namespace = ${ns}`;

  const staging = await insertStaging(ns, ownerId, 'lost', 900, { keepBlob: false });
  await reconcileOnBoot(sql, config);

  const rows = await sql`SELECT id FROM versions WHERE id = ${staging.id}`;
  assert.equal(rows.length, 0, 'an unrecoverable staging row is removed');
  const [after] = await sql`SELECT blob_bytes FROM users WHERE namespace = ${ns}`;
  assert.equal(Number(after.blob_bytes), 0, 'the charged bytes come back');
});

test('boot reconciliation preserves a legacy blob on rollback and re-keys it on retry', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  const content = '// legacy bytes';
  const digest = sha256Hex(content);
  const legacyRel = path.join('blobs', 'legacy', 'ancient.js');
  const legacyAbs = path.join(config.dataDir, legacyRel);
  fs.mkdirSync(path.dirname(legacyAbs), { recursive: true });
  fs.writeFileSync(legacyAbs, content);

  const [{ id: ownerId }] = await sql`SELECT id FROM users WHERE namespace = ${ns}`;
  const [row] = await sql`
    INSERT INTO versions
      (owner_id, namespace, extension_id, version, status, name, license,
       description, blob_path, created_at, published_at)
    VALUES (${ownerId}, ${ns}, 'ancient', '1.0.0', 'published', 'ancient', 'MIT',
            '', ${legacyRel}, now() - interval '2 days', now() - interval '2 days')
    RETURNING id
  `;

  let transactions = 0;
  const failingSql = (...args) => sql(...args);
  failingSql.begin = (callback) =>
    sql.begin(async (tx) => {
      await callback(tx);
      if (++transactions === 2) throw new Error('migration failed before commit');
    });
  await assert.rejects(reconcileOnBoot(failingSql, config), /migration failed before commit/);
  assert.equal(fs.readFileSync(legacyAbs, 'utf8'), content);
  const [rolledBack] = await sql`
    SELECT blob_digest, blob_path FROM versions WHERE id = ${row.id}
  `;
  assert.equal(rolledBack.blob_digest, null);
  assert.equal(rolledBack.blob_path, legacyRel);

  await reconcileOnBoot(sql, config);

  const [after] = await sql`
    SELECT blob_digest, blob_path, blob_size FROM versions WHERE id = ${row.id}
  `;
  assert.equal(after.blob_digest, digest);
  assert.equal(after.blob_path, path.join('blobs', digest.slice(0, 2), digest.slice(2)));
  assert.equal(Number(after.blob_size), content.length);
  assert.ok(!fs.existsSync(legacyAbs), 'the legacy file is removed after commit');
  // The digest is only useful if the copy landed where the download looks.
  const download = await request(app).get(`/v1/@${ns}/ancient/versions/1.0.0/download`).expect(200);
  assert.equal(download.text, content);
});

test('two instances reconciling the same legacy blob do not race each other', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  // Big enough that the copy and the unlink cannot land inside one another's
  // window, which is the interleaving that breaks an unlocked pass.
  const content = `// contested legacy bytes\n${'x'.repeat(8 * 1024 * 1024)}`;
  const digest = sha256Hex(content);
  const legacyRel = path.join('blobs', 'legacy', 'contested.js');
  const legacyAbs = path.join(config.dataDir, legacyRel);
  fs.mkdirSync(path.dirname(legacyAbs), { recursive: true });
  fs.writeFileSync(legacyAbs, content);

  const [{ id: ownerId }] = await sql`SELECT id FROM users WHERE namespace = ${ns}`;
  const [row] = await sql`
    INSERT INTO versions
      (owner_id, namespace, extension_id, version, status, name, license,
       description, blob_path, created_at, published_at)
    VALUES (${ownerId}, ${ns}, 'contested', '1.0.0', 'published', 'contested', 'MIT',
            '', ${legacyRel}, now() - interval '2 days', now() - interval '2 days')
    RETURNING id
  `;

  // The second connection stands in for a second instance sharing the database
  // and the data directory, which is what hosting.md allows behind a balancer.
  const peer = createDb(config);
  try {
    await Promise.all([reconcileOnBoot(sql, config), reconcileOnBoot(peer, config)]);
  } finally {
    await peer.end();
  }

  const [after] = await sql`SELECT blob_digest, blob_path FROM versions WHERE id = ${row.id}`;
  assert.equal(after.blob_digest, digest);
  assert.equal(after.blob_path, path.join('blobs', digest.slice(0, 2), digest.slice(2)));
  assert.ok(!fs.existsSync(legacyAbs), 'the legacy file is removed exactly once');
  const download = await request(app)
    .get(`/v1/@${ns}/contested/versions/1.0.0/download`)
    .expect(200);
  assert.equal(download.text, content);
});
