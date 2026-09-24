import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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

function manifest(obj = {}) {
  return { id: 'hello', version: '1.0.0', license: 'MIT', name: 'hello', description: 'd', ...obj };
}

function publish(app, ns, token, body) {
  return request(app).post(`/v1/@${ns}/hello/versions`).set(bearer(token)).send(body);
}

async function makeAdminAndOwner() {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  assert.equal(ab.user.role, 'admin');
  const ownerNs = uniqNs();
  const ob = await signupAndAccept(app, ownerNs);
  assert.equal(ob.user.role, 'normal');
  return { adminToken: ab.token, ownerToken: ob.token, adminNs, ownerNs };
}

test('first publish -> pending; list empty until approved', async () => {
  const ns = uniqNs();
  const { token } = await signupAndAccept(app, ns);
  const r = await publish(app, ns, token, { manifest: manifest(), code: 'console.log(1);' }).expect(
    201,
  );
  assert.equal(r.body.status, 'pending');

  const list = await request(app).get('/v1/extensions');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 0);
});

test('unauthenticated publish is 401', async () => {
  const ns = uniqNs();
  await request(app)
    .post(`/v1/@${ns}/hello/versions`)
    .send({ manifest: manifest(), code: 'x' })
    .expect(401);
});

test('one pending per owner: second publish conflicts', async () => {
  const ns = uniqNs();
  const { token } = await signupAndAccept(app, ns);
  const body = { manifest: manifest(), code: 'x' };
  await publish(app, ns, token, body).expect(201);
  const again = await publish(app, ns, token, body).expect(403);
  assert.match(again.body.detail, /awaiting review/i);
});

test('version must be strictly greater semver than published', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const post = (v) =>
    publish(app, ownerNs, ownerToken, { manifest: manifest({ version: v }), code: 'x' });
  const approve = async () => {
    const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
    const version = queue.body.data[0].version;
    await request(app)
      .patch(`/v1/@${ownerNs}/hello/versions/${version}`)
      .set(bearer(adminToken))
      .send({ status: 'approved' })
      .expect(200);
  };

  await post('1.0.0').expect(201);
  await post('1.0.0').expect(403); // pending slot
  await approve();
  await post('1.0.0').expect(422); // must be strictly greater
  await post('0.9.0').expect(422);
  await post('2.0.0').expect(201);
});

test('admin approves pending; subsequent publishes auto-published', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const first = await publish(app, ownerNs, ownerToken, { manifest: manifest(), code: 'x' }).expect(
    201,
  );
  assert.equal(first.body.status, 'pending');

  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
  assert.equal(queue.body.data.length, 1);
  const version = queue.body.data[0].version;

  const approve = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/${version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
  assert.equal(approve.body.status, 'published');

  const list = await request(app).get('/v1/extensions');
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].version, '1.0.0');

  const second = await publish(app, ownerNs, ownerToken, {
    manifest: manifest({ version: '2.0.0' }),
    code: 'y',
  }).expect(201);
  assert.equal(second.body.status, 'published');
  assert.equal(second.body.version, '2.0.0');
});

test('latest resolves by SemVer across a yank/re-publish sequence', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();

  const post = (v, code) =>
    publish(app, ownerNs, ownerToken, { manifest: manifest({ version: v }), code });
  const latest = () => request(app).get(`/v1/@${ownerNs}/hello/versions/latest`).expect(200);
  const approveFirst = async () => {
    const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
    await request(app)
      .patch(`/v1/@${ownerNs}/hello/versions/${queue.body.data[0].version}`)
      .set(bearer(adminToken))
      .send({ status: 'approved' })
      .expect(200);
  };

  await post('1.0.0', 'console.log(1)').expect(201);
  await approveFirst();
  await post('2.0.0', 'console.log(2)').expect(201);

  assert.equal((await latest()).body.version, '2.0.0');

  // yank the newest version; latest must fall back to the next-highest published
  await request(app)
    .delete(`/v1/@${ownerNs}/hello/versions/2.0.0`)
    .set(bearer(ownerToken))
    .expect(204);
  assert.equal((await latest()).body.version, '1.0.0');

  // the yanked blob stays downloadable
  const yankedDownload = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/2.0.0/download`)
    .expect(200);
  assert.equal(yankedDownload.text, 'console.log(2)');

  // yanked versions still count toward the version ceiling
  const rePublishYanked = await post('2.0.0', 'console.log(2again)');
  assert.equal(rePublishYanked.status, 422);

  // a strictly greater version publishes past the yanked one
  await post('2.0.1', 'console.log(2.1)').expect(201);
  assert.equal((await latest()).body.version, '2.0.1');

  // extensions listing must not surface yanked versions
  const listing = await request(app).get('/v1/extensions').expect(200);
  assert.equal(listing.body.data.length, 1);
  assert.equal(listing.body.data[0].version, '2.0.1');
});

test('non-admin cannot review', async () => {
  const ns = uniqNs();
  const { token } = await signupAndAccept(app, ns);
  await publish(app, ns, token, { manifest: manifest(), code: 'x' }).expect(201);
  const normNs = uniqNs();
  const nb = await signupAndAccept(app, normNs);
  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(nb.token));
  assert.equal(queue.status, 403);
});

test('download serves approved code with javascript content type', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const code = 'console.log("DOWNLOAD_SPECIAL");';
  await publish(app, ownerNs, ownerToken, {
    manifest: manifest({ version: '1.0.0' }),
    code,
  }).expect(201);
  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
  await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/${queue.body.data[0].version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);

  const dl = await request(app).get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-type'], /javascript/);
  assert.match(dl.text, /DOWNLOAD_SPECIAL/);
});

test('admin can download a pending version source for review', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const code = 'console.log("PENDING_REVIEW_CODE");';
  await publish(app, ownerNs, ownerToken, {
    manifest: manifest({ version: '1.0.0' }),
    code,
  }).expect(201);

  const dl = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`)
    .set(bearer(adminToken));
  assert.equal(dl.status, 200);
  assert.match(dl.headers['content-type'], /javascript/);
  assert.match(dl.text, /PENDING_REVIEW_CODE/);
});

test('pending version source is hidden from non-admins', async () => {
  const { ownerToken, ownerNs } = await makeAdminAndOwner();
  await publish(app, ownerNs, ownerToken, {
    manifest: manifest({ version: '1.0.0' }),
    code: 'console.log("SECRET_PENDING_CODE");',
  }).expect(201);

  const anonymous = await request(app).get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`);
  assert.equal(anonymous.status, 404);

  const owner = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`)
    .set(bearer(ownerToken));
  assert.equal(owner.status, 404);
});

test('automation tokens cannot read pending version source', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  await publish(app, ownerNs, ownerToken, {
    manifest: manifest({ version: '1.0.0' }),
    code: 'console.log("REVIEW_ONLY");',
  }).expect(201);

  const created = await request(app)
    .post('/v1/tokens')
    .set(bearer(adminToken))
    .send({ name: 'ci', scopes: ['publish'] })
    .expect(201);

  const dl = await request(app)
    .get(`/v1/@${ownerNs}/hello/versions/1.0.0/download`)
    .set(bearer(created.body.token));
  assert.equal(dl.status, 404);
});

test('published versions expose digest and integrity, served from /blobs/:digest', async () => {
  const { adminToken, ownerToken, ownerNs } = await makeAdminAndOwner();
  const code = 'const DIGESTY = 42;';
  const pub = await publish(app, ownerNs, ownerToken, {
    manifest: manifest({ version: '1.0.0' }),
    code,
  }).expect(201);
  assert.equal(pub.body.status, 'pending');
  assert.equal(pub.body.dist, undefined);

  const queue = await request(app).get('/v1/versions?status=pending').set(bearer(adminToken));
  const approved = await request(app)
    .patch(`/v1/@${ownerNs}/hello/versions/${queue.body.data[0].version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
  assert.match(approved.body.dist.digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(approved.body.dist.integrity, /^sha512-[A-Za-z0-9+/=]+$/);

  const byDigest = await request(app)
    .get(`/v1/blobs/${approved.body.dist.digest.slice(7)}`)
    .expect(200);
  assert.equal(byDigest.text, code);
  assert.match(byDigest.headers['cache-control'], /immutable/);

  // identical code under a new version shares one blob file on disk
  const second = await publish(app, ownerNs, ownerToken, {
    manifest: manifest({ version: '2.0.0' }),
    code,
  }).expect(201);
  assert.equal(second.body.status, 'published');
  assert.equal(second.body.dist.digest, approved.body.dist.digest);
  assert.equal(second.body.dist.integrity, approved.body.dist.integrity);

  const dir = (await boot()).config.dataDir;
  const digest = approved.body.dist.digest.slice(7);
  const blobFile = fs.readFileSync(
    path.join(dir, 'blobs', digest.slice(0, 2), digest.slice(2)),
    'utf8',
  );
  assert.equal(blobFile, code);
});
