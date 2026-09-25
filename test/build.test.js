import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  signupAndAccept,
  publishProject,
  listTarballFiles,
} from './helpers.mjs';

let app;
let sql;
let _config;
before(async () => {
  ({ app, sql, config: _config } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

test('a successful build surfaces buildLog and sourceUrl on the pending version', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const pub = await publishProject(app, ns, 'hello', owner.token, {
    code: 'console.log("GREETING");',
  });
  assert.equal(pub.status, 201);
  assert.equal(pub.body.status, 'pending');
  assert.ok(pub.body.buildLog, 'the publish response carries the successful build log');
  assert.match(pub.body.sourceUrl, /\/versions\/1\.0\.0\/source$/);

  // The moderation queue carries the build log and a source URL for review.
  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(admin.token));
  assert.equal(queue.status, 200);
  assert.equal(queue.body.data.length, 1);
  const [entry] = queue.body.data;
  assert.equal(entry.id, 'hello');
  assert.ok(entry.buildLog, 'queue entries include the build log');
  assert.match(entry.sourceUrl, /\/versions\/1\.0\.0\/source$/);

  // Owner can collect their source tarball for local rebuilds.
  const src = await request(app)
    .get(`/v1/@${ns}/hello/versions/1.0.0/source`)
    .set(bearer(owner.token))
    .expect(200);
  assert.match(src.headers['content-type'], /gzip/);
  assert.ok(src.body.length > 0);
});

test('a failing build rejects the publish with buildLog and buildError', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // The project declares a block whose opcode has no exported handler: the
  // compiler fails with a clear message.
  const { projectTarball } = await import('./helpers.mjs');
  const tarball = await projectTarball({
    id: 'broken',
    blockType: 'command',
    blockText: 'ghost',
    opcode: 'ghost',
    code: '// never used',
  });

  const res = await request(app)
    .post(`/v1/@${ns}/broken/versions`)
    .set(bearer(owner.token))
    .set('Content-Type', 'application/gzip')
    .send(tarball);
  assert.equal(res.status, 422);
  assert.equal(res.body.status, 422);
  assert.ok(res.body.buildError, 'buildError is reported');
  assert.ok(res.body.buildLog, 'buildLog is reported');
  assert.match(res.body.detail, /exited with code|failed|error/i);

  // Nothing was staged.
  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(admin.token));
  assert.equal(queue.body.data.length, 0);
});

test('derived manifest validation rejects bad metadata', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  const { projectTarball } = await import('./helpers.mjs');

  // twext.yml extension.id must match the route id.
  const mismatched = await projectTarball({ id: 'other', version: '1.0.0' });
  const bad = await request(app)
    .post(`/v1/@${ns}/expected/versions`)
    .set(bearer(owner.token))
    .set('Content-Type', 'application/gzip')
    .send(mismatched);
  assert.equal(bad.status, 422);
  assert.match(bad.body.errors[0].message, /id/i);

  const badVersion = await projectTarball({ id: 'hello', version: 'not-semver' });
  const v = await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set(bearer(owner.token))
    .set('Content-Type', 'application/gzip')
    .send(badVersion);
  assert.equal(v.status, 422);
  assert.match(v.body.errors[0].field, /version/i);
});

test('legacy JSON publishes are rejected with 415, and missing twext.yml with 422', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const legacy = await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set(bearer(owner.token))
    .send({ manifest: { id: 'hello', version: '1.0.0', license: 'MIT' }, code: 'x' });
  assert.equal(legacy.status, 415);
  assert.match(legacy.body.detail, /gzip tarball/);

  // Build a tar without twext.yml.
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const os = await import('node:os');
  const { createTarballBuffer } = await import('../src/tarball.js');
  const dir = await mkdtemp(join(os.tmpdir(), 'twexthub-tar-'));
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
    await writeFile(join(dir, 'src', 'index.js'), 'export const blocks = {};');
    const tarball = await createTarballBuffer(dir, ['package.json', 'src/index.js']);
    const res = await request(app)
      .post(`/v1/@${ns}/hello/versions`)
      .set(bearer(owner.token))
      .set('Content-Type', 'application/gzip')
      .send(tarball);
    assert.equal(res.status, 422);
    assert.ok(res.body.errors.some((e) => e.field === 'twext.yml'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('source tarballs over the byte cap are refused with 413', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // Gzip would crush a repetitive pad, so the source includes a real chunk of
  // incompressible bytes that keeps the packed tarball over the 1 MiB cap.
  const { mkdir, mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { randomBytes } = await import('node:crypto');
  const os = await import('node:os');
  const { createTarballBuffer } = await import('../src/tarball.js');
  const dir = await mkdtemp(join(os.tmpdir(), 'twexthub-limit-'));
  try {
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'twext.yml'),
      'entryPoint: src/index.js\nname: big\nversion: 1.0.0\nlicense: MIT\ndescription: big\n' +
        'extension:\n  id: big\n  name: Big\n  color1: "#000000"\n' +
        'blocks:\n  - opcode: hello\n    blockType: command\n    text: hi\n',
    );
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'x', type: 'module' }));
    await writeFile(
      join(dir, 'src', 'index.js'),
      'export const blocks = { hello(args, util) {} };\n',
    );
    await writeFile(join(dir, 'payload.bin'), randomBytes(2 * 1024 * 1024));
    const tarball = await createTarballBuffer(dir, await listTarballFiles(dir, dir));
    assert.ok(tarball.length > 1024 * 1024, 'tarball exceeds the cap');
    const res = await request(app)
      .post(`/v1/@${ns}/big/versions`)
      .set(bearer(owner.token))
      .set('Content-Type', 'application/gzip')
      .send(tarball);
    assert.equal(res.status, 413);
    assert.match(res.body.title, /Payload Too Large/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an invalid or corrupt gzip payload is a 422, and a bad visibility a 422', async () => {
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const corrupt = await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set(bearer(owner.token))
    .set('Content-Type', 'application/gzip')
    .send(Buffer.from('this is not a gzip archive at all, just bytes'));
  assert.equal(corrupt.status, 422);

  const { projectTarball } = await import('./helpers.mjs');
  const tarball = await projectTarball({ id: 'hello', version: '1.0.0' });
  const vis = await request(app)
    .post(`/v1/@${ns}/hello/versions?visibility=secret`)
    .set(bearer(owner.token))
    .set('Content-Type', 'application/gzip')
    .send(tarball);
  assert.equal(vis.status, 422);
  assert.equal(vis.body.errors[0].field, 'visibility');
});

test('identical sources produce identical compiled blobs and share a source file', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const _first = await publishProject(app, ns, 'echo', owner.token, {
    version: '1.0.0',
    code: 'const ECHO = true;',
  });
  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(admin.token));
  await request(app)
    .patch(`/v1/@${ns}/echo/versions/${queue.body.data[0].version}`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  // Same source (byte-for-byte packed the same way), new version: the server
  // rebuilds deterministically, so the blob digest stays identical.
  const second = await publishProject(app, ns, 'echo', owner.token, {
    version: '2.0.0',
    code: 'const ECHO = true;',
  });
  assert.equal(second.body.status, 'published');

  const firstDetail = await request(app).get(`/v1/@${ns}/echo/versions/1.0.0`).expect(200);
  const secondDetail = await request(app).get(`/v1/@${ns}/echo/versions/2.0.0`).expect(200);
  assert.match(firstDetail.body.dist.digest, /^sha256:/);
  assert.equal(firstDetail.body.dist.digest, secondDetail.body.dist.digest);
});
