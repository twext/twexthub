import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signup, signupAccept } from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

test('login with correct password returns a session', async () => {
  const ns = uniqNs();
  const password = 'password123';
  await request(app).post('/v1/auth/signup').send({ namespace: ns, password }).expect(201);

  const login = await request(app)
    .post('/v1/auth/login')
    .send({ namespace: ns, password })
    .expect(200);
  assert.equal(login.body.user.namespace, ns);
  assert.equal(typeof login.body.token, 'string');

  await request(app)
    .post('/v1/auth/login')
    .send({ namespace: ns, password: 'wrong-password' })
    .expect(401);
});

test('login rate limit: failed attempts produce 429', async () => {
  const ns = uniqNs();
  await request(app)
    .post('/v1/auth/signup')
    .send({ namespace: ns, password: 'password123' })
    .expect(201);

  for (let i = 0; i < 5; i += 1) {
    await request(app)
      .post('/v1/auth/login')
      .send({ namespace: ns, password: 'nope-nope-nope' })
      .expect(401);
  }
  const limited = await request(app)
    .post('/v1/auth/login')
    .send({ namespace: ns, password: 'wrong-password' })
    .expect(429);
  assert.ok(limited.headers['retry-after']);
});

test('logout revokes the current session', async () => {
  const { user, token } = await signupAccept(app, uniqNs());
  await request(app).post('/v1/auth/logout').set(bearer(token)).expect(204);

  await request(app).get('/v1/auth/me').set(bearer(token)).expect(401);
  const login = await request(app)
    .post('/v1/auth/login')
    .send({ namespace: user.namespace, password: 'password123' })
    .expect(200);
  assert.ok(login.body.token);
});

test('logout works without accepting terms', async () => {
  const r = await request(app)
    .post('/v1/auth/signup')
    .send({ namespace: uniqNs(), password: 'password123' });
  assert.equal(r.status, 201);
  await request(app).post('/v1/auth/logout').set(bearer(r.body.token)).expect(204);
});

test('first user is admin', async () => {
  const u = await request(app)
    .post('/v1/auth/signup')
    .send({ namespace: uniqNs(), password: 'password123', displayName: 'First' })
    .expect(201);
  assert.equal(u.body.user.role, 'admin');
  const second = await request(app)
    .post('/v1/auth/signup')
    .send({ namespace: uniqNs(), password: 'password123' })
    .expect(201);
  assert.equal(second.body.user.role, 'normal');
});

test('duplicate namespace -> 409', async () => {
  const who = uniqNs();
  await request(app)
    .post('/v1/auth/signup')
    .send({ namespace: who, password: 'password123' })
    .expect(201);
  await request(app)
    .post('/v1/auth/signup')
    .send({ namespace: who, password: 'password123' })
    .expect(409);
});

test('short password -> 422', async () => {
  await request(app)
    .post('/v1/auth/signup')
    .send({ namespace: uniqNs(), password: 'short' })
    .expect(422);
});

test('me: valid token 200, garbage 401, none 401', async () => {
  const { token } = await signupAccept(app, uniqNs());
  await request(app).get('/v1/auth/me').set(bearer(token)).expect(200);
  await request(app).get('/v1/auth/me').set(bearer('garbage')).expect(401);
  await request(app).get('/v1/auth/me').expect(401);
});

test('terms gate: 403 until accept', async () => {
  const res = await signup(app, uniqNs());
  const { token } = res.body;
  const ns = res.body.user.namespace;
  await request(app).get('/v1/auth/me').set(bearer(token)).expect(200);
  await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({ displayName: 'Updated' })
    .expect(403);
  await request(app).post('/v1/terms/accept').set(bearer(token)).expect(204);
  await request(app)
    .patch(`/v1/users/${ns}`)
    .set(bearer(token))
    .send({ displayName: 'Updated' })
    .expect(200);
});
