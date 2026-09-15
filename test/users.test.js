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
  await (await boot()).sql.end();
});

test('users list is public and includes created users', async () => {
  const first = await signupAndAccept(app, uniqNs());
  const second = await signupAndAccept(app, uniqNs());

  const list = await request(app).get('/v0/users').expect(200);
  const namespaces = list.body.data.map((u) => u.namespace);
  assert.ok(namespaces.includes(first.user.namespace));
  assert.ok(namespaces.includes(second.user.namespace));
  const firstUser = list.body.data.find((u) => u.namespace === first.user.namespace);
  assert.equal(firstUser.role, 'admin');
});

test('user lookup by namespace returns profile', async () => {
  const { user } = await signupAndAccept(app, uniqNs());
  const r = await request(app).get(`/v0/users/${user.namespace}`).expect(200);
  assert.equal(r.body.namespace, user.namespace);
  assert.equal(r.body.hasPublished, false);
});

test('owner can update their own displayName', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const r = await request(app)
    .patch(`/v0/users/${user.namespace}`)
    .set(bearer(token))
    .send({ displayName: 'Fresh Handle' })
    .expect(200);
  assert.equal(r.body.displayName, 'Fresh Handle');
});

test('changing password revokes existing sessions and tokens', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const created = await request(app)
    .post('/v0/tokens')
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  await request(app)
    .patch(`/v0/users/${ns}`)
    .set(bearer(token))
    .send({ password: 'newpassword9' })
    .expect(200);

  await request(app).get('/v0/auth/me').set(bearer(token)).expect(401);
  await request(app).get('/v0/tokens').set(bearer(created.body.token)).expect(401);

  const login = await request(app)
    .post('/v0/auth/login')
    .send({ namespace: ns, password: 'newpassword9' })
    .expect(200);
  assert.ok(login.body.token);
});

test('non-owner cannot update another user', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { token } = await signupAndAccept(app, uniqNs());

  const r = await request(app)
    .patch(`/v0/users/${admin.user.namespace}`)
    .set(bearer(token))
    .send({ displayName: 'Nope' });
  assert.equal(r.status, 403);
});

test('only admin can change a role', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: other, token } = await signupAndAccept(app, uniqNs());

  const denied = await request(app)
    .patch(`/v0/users/${other.namespace}`)
    .set(bearer(token))
    .send({ role: 'admin' });
  assert.equal(denied.status, 403);

  const granted = await request(app)
    .patch(`/v0/users/${other.namespace}`)
    .set(bearer(admin.token))
    .send({ role: 'admin' })
    .expect(200);
  assert.equal(granted.body.role, 'admin');
});
