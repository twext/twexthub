import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { collectSources, validateProject, compileExtension, loadProduct } from '@twext/twext';
import { boot, resetDb, bearer, uniqNs, signupAndAccept } from './helpers.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures');

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

// Replicates the hub's build sandbox (compiler.js): writes the uploaded
// manifest and sources into a scratch dir and compiles with the same bundled
// twext library the server uses, so the download can be byte-compared.
async function compileLocal({ manifestYaml, sources }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twexthub-fixture-'));
  try {
    fs.writeFileSync(path.join(dir, 'twext.yml'), manifestYaml);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module","private":true}\n');
    for (const [rel, content] of Object.entries(sources)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const validation = await validateProject(path.join(dir, 'twext.yml'));
    assert.ok(validation.ok, validation.errors?.join(' '));
    return compileExtension(validation.project, loadProduct());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function publishSources(app, token, ns, id, body) {
  return request(app).post(`/v1/@${ns}/${id}/versions`).set(bearer(token)).send(body);
}

async function rejectEmptyPendingAndApprove(app, adminToken, ns, id) {
  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(adminToken))
    .expect(200);
  const entry = queue.body.data.find((v) => v.namespace === ns && v.id === id);
  assert.ok(entry, 'pending entry present');
  await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${entry.version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
  return entry.version;
}

test('fixture greeter round-trips byte-for-byte', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const fixtureDir = path.join(FIXTURES, 'greeter');
  const configPath = path.join(fixtureDir, 'twext.yml');
  const manifest = fs.readFileSync(configPath, 'utf8');
  const sources = collectSources(fixtureDir, {
    manifestPath: configPath,
    outputPath: 'dist/Greeter.js',
  });
  const id = 'greeter';
  const version = '1.0.0';

  const pub = await publishSources(app, owner.token, ns, id, {
    manifest,
    sources,
    twext: '1.0.0',
  }).expect(201);
  assert.equal(pub.body.status, 'pending');
  assert.equal(pub.body.id, id);
  assert.equal(pub.body.version, version);
  assert.equal(pub.body.name, 'Greetings');

  await rejectEmptyPendingAndApprove(app, admin.token, ns, id);

  const expected = await compileLocal({ manifestYaml: manifest, sources });
  const dl = await request(app).get(`/v1/@${ns}/${id}/versions/${version}/download`).expect(200);
  assert.match(dl.headers['content-type'], /javascript/);
  assert.deepEqual(
    Buffer.from(dl.text, 'utf8'),
    Buffer.from(expected, 'utf8'),
    'downloaded compiled output must match a local twext build',
  );

  // extension detail exposes colors and latest version
  const detail = await request(app).get(`/v1/@${ns}/${id}`).expect(200);
  assert.equal(detail.body.version, version);
  assert.equal(detail.body.color1, '#0094FF');
  assert.equal(detail.body.license, 'MIT');
});

test('fixture hello auto-publishes after first approval', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  const id = 'hello';

  const fixtureDir = path.join(FIXTURES, 'hello');
  const configPath = path.join(fixtureDir, 'twext.yml');
  const manifest = fs.readFileSync(configPath, 'utf8');
  const sources = collectSources(fixtureDir, {
    manifestPath: configPath,
    outputPath: 'dist/Hello.js',
  });

  await publishSources(app, owner.token, ns, id, {
    manifest,
    sources,
    twext: '1.0.0',
  }).expect(201);
  await rejectEmptyPendingAndApprove(app, admin.token, ns, id);

  // promise of owner.published -> later publishes skip review
  const replaced = sources['src/blocks/hello.js'].replace('hello, world', 'hello again');
  assert.notEqual(replaced, sources['src/blocks/hello.js']);
  const nextSources = { ...sources, 'src/blocks/hello.js': replaced };

  const pub2 = await publishSources(app, owner.token, ns, id, {
    manifest: manifest.replace("version: '0.1.0'", "version: '0.2.0'"),
    sources: nextSources,
    twext: '1.0.0',
  }).expect(201);
  assert.equal(pub2.body.status, 'published');

  const expected = await compileLocal({ manifestYaml: manifest, sources: nextSources });
  const dl = await request(app).get(`/v1/@${ns}/${id}/versions/0.2.0/download`).expect(200);
  assert.deepEqual(Buffer.from(dl.text, 'utf8'), Buffer.from(expected, 'utf8'));
});
