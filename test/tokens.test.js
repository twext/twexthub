import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';

let app;
before(async () => {
  ({ app } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await (await boot()).sql.end();
});

test('create/list/update/delete automation tokens', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);
  assert.ok(created.body.token);
  assert.equal(created.body.scopes.join(','), 'publish');

  const list = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 1);

  const id = created.body.id;
  await request(app)
    .patch(`/v1/tokens/${id}`)
    .set(bearer(token))
    .send({ scopes: ['publish', 'yank'] })
    .expect(200);

  const updated = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.equal(updated.body.data[0].scopes.includes('yank'), true);

  await request(app).delete(`/v1/tokens/${id}`).set(bearer(token)).expect(204);
  const after = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.equal(after.body.data.length, 0);

  await request(app).get('/v1/me').set(bearer(created.body.token)).expect(401);
});

test('automation token can publish with publish scope', async () => {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  assert.equal(ab.user.role, 'admin');

  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'auto', scopes: ['publish'] })
    .expect(201);
  const auto = created.body.token;

  const pub = await publishProject(app, ns, 'hello', auto);
  assert.equal(pub.status, 201);

  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(ab.token))
    .expect(200);
  const version = queue.body.data[0].version;
  await request(app)
    .patch(`/v1/@${ns}/hello/versions/${version}`)
    .set(bearer(ab.token))
    .send({ status: 'approved' })
    .expect(200);
});

test('automation tokens cannot access session-only endpoints', async () => {
  const { user, token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'auto', scopes: ['publish'] })
    .expect(201);
  const auto = created.body.token;

  const me = await request(app).get('/v1/me').set(bearer(auto)).expect(200);
  assert.equal(me.body.namespace, user.namespace);

  const sessions = await request(app).get('/v1/sessions').set(bearer(auto)).expect(403);
  assert.match(sessions.body.detail, /Automation tokens/i);

  const tokens = await request(app).get('/v1/tokens').set(bearer(auto)).expect(403);
  assert.match(tokens.body.detail, /Automation tokens/i);
});

test('yank scope: yank own version once approved', async () => {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  const { user, token } = await signupAndAccept(app, uniqNs());
  const ns = user.namespace;

  const pub = await publishProject(app, ns, 'hello', token);
  const version = pub.body.version;

  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(ab.token))
    .expect(200);
  await request(app)
    .patch(`/v1/@${ns}/hello/versions/${queue.body.data[0].version}`)
    .set(bearer(ab.token))
    .send({ status: 'approved' })
    .expect(200);

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'yankbot', scopes: ['yank'] })
    .expect(201);
  const yankToken = created.body.token;

  await request(app)
    .delete(`/v1/@${ns}/hello/versions/${version}`)
    .set(bearer(yankToken))
    .expect(204);

  const entry = await request(app).get(`/v1/@${ns}/hello/versions/${version}`);
  assert.equal(entry.status, 200);
  assert.equal(entry.body.status, 'yanked');
});

test('a token revokes itself, and only itself', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const first = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'one', scopes: ['publish'] })
    .expect(201);
  const second = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'two', scopes: ['publish'] })
    .expect(201);

  await request(app).delete('/v1/tokens/current').set(bearer(first.body.token)).expect(204);

  // The revoked token is dead; the session and the other token are not.
  await request(app).get('/v1/me').set(bearer(first.body.token)).expect(401);
  await request(app).get('/v1/me').set(bearer(second.body.token)).expect(200);
  await request(app).get('/v1/me').set(bearer(token)).expect(200);
  const list = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.deepEqual(
    list.body.data.map((t) => t.name),
    ['two'],
  );
});

test('a session cannot revoke a token it does not have, and vice versa', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(token))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  // A session has no automation token of its own, so there is nothing to delete.
  const wrong = await request(app).delete('/v1/tokens/current').set(bearer(token)).expect(403);
  assert.match(wrong.body.detail, /session/i);

  // An automation token cannot end a session, including its caller's.
  const denied = await request(app).delete('/v1/sessions/current').set(bearer(created.body.token));
  assert.equal(denied.status, 403);

  // Neither of those attempts took the token away.
  const list = await request(app).get('/v1/tokens').set(bearer(token)).expect(200);
  assert.equal(list.body.data.length, 1);
  await request(app).delete(`/v1/tokens/${created.body.id}`).set(bearer(token)).expect(204);
});
