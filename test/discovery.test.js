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

function manifest(id, version, extra = {}) {
  return { id, version, license: 'MIT', name: id, description: 'A test extension.', ...extra };
}

function publish(nsToken, ns, id, version, extra = {}) {
  return request(app)
    .post(`/v1/@${ns}/${id}/versions`)
    .set(bearer(nsToken))
    .send({ manifest: manifest(id, version, extra), code: '// ' + id + ' ' + version });
}

// First publish of an owner is pending; approve it to unlock auto-publishing.
async function approvePending(adminToken, ns, id) {
  const queue = await request(app)
    .get('/v1/versions?status=pending')
    .set(bearer(adminToken))
    .expect(200);
  const entry = queue.body.data.find((v) => v.namespace === ns && v.id === id);
  assert.ok(entry, 'pending entry present');
  const r = await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${entry.version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return entry.version;
}

test('extensions lists published extensions, newest first, latest version each', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const alpha10 = await publish(owner.token, ns, 'alpha', '1.0.0').expect(201);
  assert.equal(alpha10.body.status, 'pending');
  await approvePending(admin.token, ns, 'alpha');

  // Once approved, later publishes from the same owner skip review.
  await publish(owner.token, ns, 'beta', '1.0.0').expect(201);
  await publish(owner.token, ns, 'alpha', '1.1.0').expect(201);

  const r = await request(app).get('/v1/extensions').expect(200);
  assert.deepEqual(
    r.body.data.map((e) => e.id),
    ['alpha', 'beta'],
  );
  const byId = Object.fromEntries(r.body.data.map((e) => [e.id, e.version]));
  assert.deepEqual(Object.keys(byId).sort(), ['alpha', 'beta']);
  assert.equal(byId.alpha, '1.1.0');
  assert.equal(byId.beta, '1.0.0');
  assert.equal(r.body.pagination.hasMore, false);
});

test('search filters by name/id/namespace', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publish(owner.token, ns, 'banana', '1.0.0', {
    description: 'yellow fruit',
    name: 'Sweet Banana',
  }).expect(201);
  await approvePending(admin.token, ns, 'banana');
  await publish(owner.token, ns, 'grape', '1.0.0', { description: 'purple fruit' }).expect(201);

  const id = await request(app).get('/v1/search?query=banana').expect(200);
  assert.equal(id.body.data.length, 1);
  assert.equal(id.body.data[0].id, 'banana');

  const byName = await request(app).get('/v1/search?query=Sweet').expect(200);
  assert.equal(byName.body.data.length, 1);
  assert.equal(byName.body.data[0].id, 'banana');

  const byNs = await request(app).get(`/v1/search?query=${ns}`).expect(200);
  assert.deepEqual(byNs.body.data.map((e) => e.id).sort(), ['banana', 'grape']);

  const desc = await request(app).get('/v1/search?query=purple').expect(200);
  assert.equal(desc.body.data[0].id, 'grape');

  const none = await request(app).get('/v1/search?query=zzzz').expect(200);
  assert.equal(none.body.data.length, 0);
});

test('extensions pagination cursor walks all pages', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publish(owner.token, ns, 'ext0', '1.0.0').expect(201);
  await approvePending(admin.token, ns, 'ext0');
  for (let i = 1; i < 5; i += 1) {
    await publish(owner.token, ns, 'ext' + i, '1.0.0').expect(201);
  }

  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const url = '/v1/extensions?limit=2' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await request(app).get(url).expect(200);
    assert.ok(r.body.data.length <= 2);
    for (const e of r.body.data) seen.push(e.id);
    cursor = r.body.pagination.nextCursor;
    guard += 1;
    assert.ok(guard < 10, 'pagination did not terminate');
  } while (cursor);

  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5);
});

test('stats reports published count, pending, and authors', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await publish(owner.token, ns, 'aaa', '1.0.0').expect(201);
  let stats = await request(app).get('/v1/stats').expect(200);
  assert.equal(stats.body.published, 0);
  assert.equal(stats.body.pending, 1);

  await approvePending(admin.token, ns, 'aaa');
  await publish(owner.token, ns, 'bbb', '1.0.0').expect(201);

  stats = await request(app).get('/v1/stats').expect(200);
  assert.equal(stats.body.published, 2);
  assert.equal(stats.body.pending, 0);
  assert.equal(stats.body.authors, 1);
});

test('terms and privacy documents are public', async () => {
  const terms = await request(app).get('/v1/terms').expect(200);
  assert.equal(terms.body.version, 1);
  assert.equal(typeof terms.body.body, 'string');
  assert.equal(typeof terms.body.updatedAt, 'string');

  const privacy = await request(app).get('/v1/privacy').expect(200);
  assert.equal(privacy.body.version, 1);
});

test('terms/accept records acceptance for a session', async () => {
  const { token } = await signupAndAccept(app, uniqNs());
  const me = await request(app).get('/v1/auth/me').set(bearer(token)).expect(200);
  assert.equal(me.body.termsAcceptedVersion, 1);
});

test('publish without accepting terms is forbidden', async () => {
  const r = await request(app)
    .post('/v1/auth/signup')
    .send({ namespace: uniqNs(), password: 'password123', displayName: 'd' });
  const { token } = r.body;
  const pub = await publish(token, r.body.user.namespace, 'aaa', '1.0.0');
  assert.equal(pub.status, 403);
  assert.match(pub.body.detail, /Terms/i);
});
