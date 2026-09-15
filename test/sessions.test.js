import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept } from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  (await boot()).sql.end();
});

test('sessions lists only the current session for a user', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const list = await request(app).get('/v0/sessions').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].id, String(1));
  assert.equal(typeof list.body.data[0].createdAt, 'string');
  assert.equal(typeof list.body.data[0].expiresAt, 'string');

  // a second session appears for the same user
  const r = await request(app)
    .post('/v0/auth/login')
    .send({ namespace: ns, password: 'password123' })
    .expect(200);
  const secondToken = r.body.token;

  const again = await request(app).get('/v0/sessions').set(bearer(secondToken)).expect(200);
  assert.equal(again.body.data.length, 2);
});

test('deleting a session revokes it', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  await request(app)
    .post('/v0/auth/login')
    .send({ namespace: ns, password: 'password123' })
    .expect(200);

  const list = await request(app).get('/v0/sessions').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 2);

  const otherId = list.body.data.find((s) => s.id !== String(1)).id;
  await request(app).delete(`/v0/sessions/${otherId}`).set(bearer(token)).expect(204);

  const after = await request(app).get('/v0/sessions').set(bearer(token)).expect(200);
  assert.equal(after.body.data.length, 1);
});

test('automation tokens cannot list sessions', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v0/tokens')
    .set(bearer(token))
    .send({ name: 'auto', scopes: ['publish'] })
    .expect(201);

  const r = await request(app).get('/v0/sessions').set(bearer(created.body.token)).expect(403);
  assert.match(r.body.detail, /Automation tokens/i);
});

test('admin can inspect another account sessions', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: other } = await signupAndAccept(app, uniqNs());

  const list = await request(app)
    .get(`/v0/sessions?namespace=${other.namespace}`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(typeof list.body.data[0].id, 'string');
});

test('non-admin cannot inspect another account sessions', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { token } = await signupAndAccept(app, uniqNs());

  const r = await request(app)
    .get(`/v0/sessions?namespace=${admin.user.namespace}`)
    .set(bearer(token))
    .expect(403);
  assert.match(r.body.detail, /Only an admin/i);
});
