import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import {
  boot,
  resetDb,
  bearer,
  uniqNs,
  signupAndAccept,
  publishProject,
  FIXTURE_PASSWORD,
} from './helpers.mjs';
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

test('users list is public and includes created users', async () => {
  const first = await signupAndAccept(app, uniqNs());
  const second = await signupAndAccept(app, uniqNs());

  const list = await request(app).get('/v1/users').expect(200);
  const namespaces = list.body.data.map((u) => u.namespace);
  assert.ok(namespaces.includes(first.user.namespace));
  assert.ok(namespaces.includes(second.user.namespace));
  const firstUser = list.body.data.find((u) => u.namespace === first.user.namespace);
  assert.equal('role' in firstUser, false);
  assert.equal('termsAcceptedVersion' in firstUser, false);
  assert.equal(typeof firstUser.hasPublished, 'boolean');

  const mine = await request(app).get('/v1/users').set(bearer(first.token)).expect(200);
  const me = mine.body.data.find((u) => u.namespace === first.user.namespace);
  assert.equal(me.role, 'admin');
});

test('user lookup by namespace returns profile', async () => {
  const { user } = await signupAndAccept(app, uniqNs());
  const r = await request(app).get(`/v1/users/${user.namespace}`).expect(200);
  assert.equal(r.body.namespace, user.namespace);
  assert.equal(r.body.hasPublished, false);
});

test('owner can update their own displayName', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const r = await request(app)
    .patch(`/v1/users/${user.namespace}`)
    .set(bearer(token))
    .send({ displayName: 'Fresh Handle' })
    .expect(200);
  assert.equal(r.body.displayName, 'Fresh Handle');
});

test('changing password revokes existing sessions and tokens', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({ password: 'newpassword9', currentPassword: FIXTURE_PASSWORD })
    .expect(200);

  await request(app).get('/v1/me').set(bearer(token)).expect(401);
  await request(app).get('/v1/tokens').set(bearer(created.body.token)).expect(401);

  const login = await request(app)
    .post('/v1/sessions')
    .send({ namespace: ns, password: 'newpassword9' })
    .expect(201);
  assert.ok(login.body.token);
});

test('password rotation bypasses terms re-acceptance', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());

  await request(app)
    .patch('/v1/admin/terms')
    .set(bearer(admin.token))
    .send({ body: 'Terms v2.' })
    .expect(200);

  const r = await request(app)
    .patch(`/v1/users/${user.namespace}`)
    .set(bearer(token))
    .send({ password: 'newpassword9', currentPassword: FIXTURE_PASSWORD });
  assert.equal(r.status, 200);

  const login = await request(app)
    .post('/v1/sessions')
    .send({ namespace: user.namespace, password: 'newpassword9' })
    .expect(201);
  assert.ok(login.body.token);
});

test('account deletion bypasses terms re-acceptance', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user, token } = await signupAndAccept(app, uniqNs());

  await request(app)
    .patch('/v1/admin/terms')
    .set(bearer(admin.token))
    .send({ body: 'Terms v2.' })
    .expect(200);

  await request(app).delete(`/v1/users/${user.namespace}`).set(bearer(token)).expect(204);
  await request(app).get(`/v1/users/${user.namespace}`).expect(404);
});

test('account deletion still removes sources when blob cleanup fails', async () => {
  await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishProject(app, ns, 'cleanup', owner.token);
  const [version] = await sql`
    SELECT blob_digest, source_path FROM versions
    WHERE namespace = ${ns} AND extension_id = 'cleanup'
  `;
  const blobPath = blobPathFor(config.dataDir, version.blob_digest);
  const sourcePath = path.join(config.dataDir, version.source_path);
  await fs.rm(blobPath);
  await fs.mkdir(blobPath);
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);
  try {
    await request(app).delete(`/v1/users/${ns}`).set(bearer(owner.token)).expect(204);
  } finally {
    console.error = originalError;
    await fs.rm(blobPath, { recursive: true, force: true });
  }
  assert.ok(errors.some((message) => message.includes(`blob cleanup deferred for ${ns}`)));
  await assert.rejects(fs.stat(sourcePath), { code: 'ENOENT' });
});

test('non-owner cannot update another user', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { token } = await signupAndAccept(app, uniqNs());

  const r = await request(app)
    .patch(`/v1/users/${admin.user.namespace}`)
    .set(bearer(token))
    .send({ displayName: 'Nope' });
  assert.equal(r.status, 403);
});

test('only admin can change a role', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: other, token } = await signupAndAccept(app, uniqNs());

  const denied = await request(app)
    .patch(`/v1/users/${other.namespace}`)
    .set(bearer(token))
    .send({ role: 'admin' });
  assert.equal(denied.status, 403);

  const granted = await request(app)
    .patch(`/v1/users/${other.namespace}`)
    .set(bearer(admin.token))
    .send({ role: 'admin' })
    .expect(200);
  assert.equal(granted.body.role, 'admin');
});
