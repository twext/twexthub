import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishPayload } from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

test('admin can update terms and privacy; version bumps', async () => {
  const admin = await signupAndAccept(app, uniqNs());

  const terms = await request(app)
    .patch('/v1/admin/terms')
    .set(bearer(admin.token))
    .send({ body: 'New terms v2.' })
    .expect(200);
  assert.equal(terms.body.version, 2);
  assert.equal(terms.body.body, 'New terms v2.');

  await request(app).post('/v1/terms/accept').set(bearer(admin.token)).expect(204);

  const privacy = await request(app)
    .patch('/v1/admin/privacy')
    .set(bearer(admin.token))
    .send({ body: 'New privacy v2.' })
    .expect(200);
  assert.equal(privacy.body.version, 2);

  const pub = await request(app).get('/v1/terms').expect(200);
  assert.equal(pub.body.version, 2);
});

test('bumping terms forces re-acceptance for other users', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const { user: owner, token } = await signupAndAccept(app, uniqNs());
  const ns = owner.namespace;

  await request(app)
    .patch('/v1/admin/terms')
    .set(bearer(admin.token))
    .send({ body: 'Terms v2.' })
    .expect(200);

  const pub = await request(app)
    .post(`/v1/@${ns}/aaa/versions`)
    .set(bearer(token))
    .send(publishPayload({ id: 'aaa' }));
  assert.equal(pub.status, 403);
  assert.match(pub.body.detail, /Terms/i);

  await request(app).post('/v1/terms/accept').set(bearer(token)).expect(204);
  const after = await request(app)
    .post(`/v1/@${ns}/aaa/versions`)
    .set(bearer(token))
    .send(publishPayload({ id: 'aaa' }))
    .expect(201);
  assert.equal(after.body.status, 'pending');
});

test('non-admin cannot update legal documents', async () => {
  const _admin = await signupAndAccept(app, uniqNs());
  const { token } = await signupAndAccept(app, uniqNs());

  const r = await request(app).patch('/v1/admin/terms').set(bearer(token)).send({ body: 'Nope.' });
  assert.equal(r.status, 403);
});
