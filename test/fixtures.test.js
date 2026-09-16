import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import YAML from 'yaml';
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

test('fixture greeter round-trips byte-for-byte', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const manifest = YAML.parse(fs.readFileSync(path.join(FIXTURES, 'greeter', 'twext.yml'), 'utf8'));
  const compiled = fs.readFileSync(path.join(FIXTURES, 'greeter', 'dist', 'Greeter.js'));
  const code = compiled.toString('utf8');
  const id = manifest.extension.id;
  const version = manifest.version;

  const publishBody = {
    id: manifest.extension.id,
    version,
    license: manifest.license,
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    color1: manifest.extension.color1,
    color2: manifest.extension.color2,
    color3: manifest.extension.color3,
  };

  const pub = await request(app)
    .post(`/v0/@${ns}/${id}/versions`)
    .set(bearer(owner.token))
    .send({ manifest: publishBody, code })
    .expect(201);
  assert.equal(pub.body.status, 'pending');
  assert.equal(pub.body.id, id);
  assert.equal(pub.body.version, version);
  assert.equal(pub.body.name, 'Greetings');

  // approve so the fixture becomes downloadable
  const queue = await request(app)
    .get('/v0/versions?status=pending')
    .set(bearer(admin.token))
    .expect(200);
  const entry = queue.body.data.find((v) => v.namespace === ns && v.id === id);
  assert.ok(entry);
  await request(app)
    .patch(`/v0/@${ns}/${id}/versions/${version}`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  const dl = await request(app).get(`/v0/@${ns}/${id}/versions/${version}/download`).expect(200);
  assert.match(dl.headers['content-type'], /javascript/);
  assert.deepEqual(
    Buffer.from(dl.text, 'utf8'),
    compiled,
    'downloaded bytes must match the compiled fixture exactly',
  );

  // extension detail exposes colors and latest version
  const detail = await request(app).get(`/v0/@${ns}/${id}`).expect(200);
  assert.equal(detail.body.version, version);
  assert.equal(detail.body.color1, '#0094FF');
  assert.equal(detail.body.license, 'MIT');
});

test('fixture hello auto-publishes after first approval', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const manifest = YAML.parse(fs.readFileSync(path.join(FIXTURES, 'hello', 'twext.yml'), 'utf8'));
  const compiled = fs.readFileSync(path.join(FIXTURES, 'hello', 'dist', 'Hello.js'));
  const code = compiled.toString('utf8');
  const replaced = code.replace('hello, world', 'hello again');
  const id = manifest.extension.id;
  const version = manifest.version;

  const publishBody = {
    id: manifest.extension.id,
    version,
    license: manifest.license,
    name: manifest.name,
    description: manifest.description,
    color1: manifest.extension.color1,
  };

  await request(app)
    .post(`/v0/@${ns}/${id}/versions`)
    .set(bearer(owner.token))
    .send({ manifest: publishBody, code })
    .expect(201);

  const queue = await request(app)
    .get('/v0/versions?status=pending')
    .set(bearer(admin.token))
    .expect(200);
  const entry = queue.body.data.find((v) => v.namespace === ns && v.id === id);
  assert.ok(entry);
  await request(app)
    .patch(`/v0/@${ns}/${id}/versions/${version}`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  // promise of owner.published -> later publishes skip review
  const pub2 = await request(app)
    .post(`/v0/@${ns}/${id}/versions`)
    .set(bearer(owner.token))
    .send({
      manifest: { ...publishBody, version: '0.2.0' },
      code: replaced,
    })
    .expect(201);
  assert.equal(pub2.body.status, 'published');

  const dl = await request(app).get(`/v0/@${ns}/${id}/versions/0.2.0/download`).expect(200);
  assert.deepEqual(Buffer.from(dl.text, 'utf8'), Buffer.from(replaced, 'utf8'));
});
