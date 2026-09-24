import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept } from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

function manifest(id, version) {
  return { id, version, license: 'MIT', name: id, description: 'd' };
}

async function makeSetup() {
  const admin = await signupAndAccept(app, uniqNs());
  const ownerA = await signupAndAccept(app, uniqNs());
  const coowner = await signupAndAccept(app, uniqNs());
  const outsider = await signupAndAccept(app, uniqNs());

  await request(app)
    .post(`/v1/@${ownerA.user.namespace}/hello/versions`)
    .set(bearer(ownerA.token))
    .send({ manifest: manifest('hello', '1.0.0'), code: '// hello@1.0.0' })
    .expect(201);
  await request(app)
    .patch(`/v1/@${ownerA.user.namespace}/hello/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  return {
    admin,
    ownerA,
    coowner,
    outsider,
    ns: ownerA.user.namespace,
  };
}

test('adding an owner grants publish/yank/tag access and notifies them', async () => {
  const { admin, ownerA, coowner, outsider, ns } = await makeSetup();

  // outsider cannot add owners
  await request(app).put(`/v1/@${ns}/hello/owners/coowner`).set(bearer(outsider.token)).expect(403);

  // owner grants co-owner
  await request(app)
    .put(`/v1/@${ns}/hello/owners/${coowner.user.namespace}`)
    .set(bearer(ownerA.token))
    .expect(204);

  const list = await request(app).get(`/v1/@${ns}/hello/owners`).expect(200);
  const namespaces = list.body.data.map((u) => u.namespace);
  assert.ok(namespaces.includes(ns));
  assert.ok(namespaces.includes(coowner.user.namespace));

  // co-owner receives a notification
  const notes = await request(app).get('/v1/notifications').set(bearer(coowner.token)).expect(200);
  assert.equal(notes.body.data.length, 1);
  assert.match(notes.body.data[0].message, /manage @.*\/hello/);

  // co-owner publishes and yanks
  await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set(bearer(coowner.token))
    .send({ manifest: manifest('hello', '2.0.0'), code: '// hello@2.0.0' })
    .expect(201);
  await request(app)
    .delete(`/v1/@${ns}/hello/versions/2.0.0`)
    .set(bearer(coowner.token))
    .expect(204);

  // co-owner can set dist-tags
  await request(app)
    .put(`/v1/@${ns}/hello/tags/stable`)
    .set(bearer(coowner.token))
    .send({ version: '1.0.0' })
    .expect(204);

  // ...but a fresh outsider still cannot
  await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set(bearer(outsider.token))
    .send({ manifest: manifest('hello', '3.0.0'), code: '// x' })
    .expect(403);

  // removing an owner revokes the grant and notifies
  await request(app)
    .delete(`/v1/@${ns}/hello/owners/${coowner.user.namespace}`)
    .set(bearer(ownerA.token))
    .expect(204);

  const after = await request(app).get(`/v1/@${ns}/hello/owners`).expect(200);
  assert.ok(!after.body.data.some((u) => u.namespace === coowner.user.namespace));

  await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .set(bearer(coowner.token))
    .send({ manifest: manifest('hello', '3.0.0'), code: '// x' })
    .expect(403);

  // admin can still hand management around (transfer: grant then remove)
  await request(app)
    .put(`/v1/@${ns}/hello/owners/${coowner.user.namespace}`)
    .set(bearer(admin.token))
    .expect(204);
});

test('the namespace account is a permanent owner', async () => {
  const { ownerA, ns } = await makeSetup();

  const remove = await request(app)
    .delete(`/v1/@${ns}/hello/owners/${ns}`)
    .set(bearer(ownerA.token));
  assert.equal(remove.status, 422);

  const list = await request(app).get(`/v1/@${ns}/hello/owners`).expect(200);
  assert.ok(list.body.data.some((u) => u.namespace === ns));
});
