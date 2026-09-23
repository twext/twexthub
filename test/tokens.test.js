import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishPayload } from './helpers.mjs';

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

  await request(app).get('/v1/auth/me').set(bearer(created.body.token)).expect(401);
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

  const pub = await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set(bearer(auto))
    .send(publishPayload());
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

  const me = await request(app).get('/v1/auth/me').set(bearer(auto)).expect(200);
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

  const pub = await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set(bearer(token))
    .send(publishPayload())
    .expect(201);
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
