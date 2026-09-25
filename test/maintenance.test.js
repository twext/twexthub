import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';
import { gcBlobs, scrubBlobs, getIntegrityErrors } from '../src/maintenance.js';
import { blobPathFor } from '../src/blobs.js';

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
