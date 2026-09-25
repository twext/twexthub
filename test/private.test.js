import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot({
    limits: { maxBlobBytes: 5000, maxAccountBlobBytes: 8000 },
  }));
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function publishPrivate(
  { owner, id = 'secret', version = '1.0.0', code = 'const answer = 42;' },
  status = 201,
) {
  return publishProject(
    app,
    owner.user.namespace,
    id,
    owner.token,
    {
      visibility: 'private',
      version,
      code,
    },
    status,
  );
}

async function expectStatus(promise, status) {
  const res = await promise;
  assert.equal(res.status, status, JSON.stringify(res.body));
  return res;
}

test('private extensions are hidden from public surfaces but visible to the owner', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const published = await publishPrivate({ owner, code: '// secret@1.0.0' });
  assert.equal(published.status, 201);
  assert.equal(published.body.visibility, 'private');
  await request(app)
    .patch(`/v1/@${ns}/secret/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  // Public discovery and detail surfaces all come back empty or 404.
  const list = await request(app).get('/v1/extensions').expect(200);
  assert.ok(!list.body.data.some((e) => e.id === 'secret'));

  const search = await request(app).get('/v1/search?query=secret').expect(200);
  assert.equal(search.body.data.length, 0);

  const feed = await request(app).get('/v1/feed.atom').expect(200);
  assert.ok(!feed.text.includes('secret'));

  await request(app)
    .get('/v1/badge/@' + ns + '/secret')
    .expect(404);
  await request(app).get(`/v1/@${ns}/secret`).expect(404);
  await request(app).get(`/v1/@${ns}/secret/versions/1.0.0`).expect(404);
  await request(app).get(`/v1/@${ns}/secret/versions/resolve?range=^1.0`).expect(404);
  await request(app).get(`/v1/@${ns}/secret/versions/1.0.0/download`).expect(404);
  await request(app).get(`/v1/@${ns}/secret/versions/1.0.0/source`).expect(401);
  await request(app).get(`/v1/@${ns}/secret/tags`).expect(404);
  await request(app).get(`/v1/@${ns}/secret/owners`).expect(404);
  await request(app).get('/v1/extensions/trending').expect(200);

  // The namespace account reads its own private extension, downloads the
  // compiled blob, and fetches the source tarball.
  const detail = await request(app).get(`/v1/@${ns}/secret`).set(bearer(owner.token)).expect(200);
  assert.equal(detail.body.id, 'secret');
  await request(app)
    .get(`/v1/@${ns}/secret/versions/1.0.0/download`)
    .set(bearer(owner.token))
    .expect(200);
  const src = await request(app)
    .get(`/v1/@${ns}/secret/versions/1.0.0/source`)
    .set(bearer(owner.token))
    .expect(200);
  assert.match(src.headers['content-type'], /gzip/);
});

test('access grants open private detail/download to the grantee and revoke cleanly', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const grantee = await signupAndAccept(app, uniqNs());
  const outsider = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await expectStatus(publishPrivate({ owner, code: '// secret@1.0.0' }), 201);
  await request(app)
    .patch(`/v1/@${ns}/secret/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);

  // Only an owner or admin can grant.
  await request(app)
    .put(`/v1/@${ns}/secret/access/${outsider.user.namespace}`)
    .set(bearer(outsider.token))
    .expect(403);
  await request(app)
    .put(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);

  // The grantee can now see and download, and shows up in the access list.
  await request(app).get(`/v1/@${ns}/secret`).set(bearer(grantee.token)).expect(200);
  await request(app)
    .get(`/v1/@${ns}/secret/versions/1.0.0/download`)
    .set(bearer(grantee.token))
    .expect(200);
  const grants = await request(app)
    .get(`/v1/@${ns}/secret/access`)
    .set(bearer(owner.token))
    .expect(200);
  assert.ok(grants.body.data.some((g) => g.namespace === grantee.user.namespace));

  // The namespace account cannot be granted to itself.
  await request(app).put(`/v1/@${ns}/secret/access/${ns}`).set(bearer(owner.token)).expect(422);

  // Revoking hides it again.
  await request(app)
    .delete(`/v1/@${ns}/secret/access/${grantee.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app).get(`/v1/@${ns}/secret`).set(bearer(grantee.token)).expect(404);
  await request(app)
    .get(`/v1/@${ns}/secret/versions/1.0.0/download`)
    .set(bearer(grantee.token))
    .expect(404);

  // A co-owner sees it without a grant.
  const coowner = await signupAndAccept(app, uniqNs());
  await request(app)
    .put(`/v1/@${ns}/secret/owners/${coowner.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app).get(`/v1/@${ns}/secret`).set(bearer(coowner.token)).expect(200);
});

test('blob size caps and the account quota are enforced on publish', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // A single compiled output over maxBlobBytes is rejected outright. The
  // default project compiles to ~500 bytes, so a large embedded literal pushes
  // the build past the 5000-byte cap.
  const oversized = await expectStatus(
    publishPrivate(
      {
        owner,
        id: 'big',
        code: `util.log(${JSON.stringify('x'.repeat(6000))});`,
      },
      413,
    ),
    413,
  );
  assert.match(oversized.body.detail, /limit is 5000/);

  // First publish is pending and must clear review before the next one,
  // because an owner can only have one version awaiting review at a time.
  const first = await publishPrivate({ owner, id: 'batch' });
  assert.equal(first.status, 201);
  await request(app)
    .patch(`/v1/@${ns}/batch/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'approved' })
    .expect(200);
  const second = await publishPrivate({
    owner,
    id: 'batch',
    version: '2.0.0',
    code: '// second',
  });
  assert.equal(second.status, 201);

  // Force the account near its quota; the charge covers both the compiled blob
  // and the retained source tarball, so even a small publish must be refused.
  await sql`UPDATE users SET blob_bytes = 7990 WHERE namespace = ${ns}`;
  const overflowing = await expectStatus(
    publishPrivate(
      {
        owner,
        id: 'batch',
        version: '3.0.0',
        code: '// overflow',
      },
      413,
    ),
    413,
  );
  assert.match(overflowing.body.detail, /quota/);
});

test('admins can read and tune per-account quota, and only admins view the audit log', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const peer = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  // Quota defaults to the configured value, then tracks every publish byte.
  const initial = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(initial.body.maxBlobBytes, null);

  await expectStatus(publishPrivate({ owner, code: '// secret@1.0.0' }), 201);
  const afterPublish = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.ok(Number(afterPublish.body.blobBytes) > 0, 'publish bytes are tracked');

  // A per-account override replaces the default; non-admins cannot set it.
  await request(app)
    .patch(`/v1/admin/users/${ns}/quota`)
    .set(bearer(peer.token))
    .send({ maxBlobBytes: 999 })
    .expect(403);
  await request(app)
    .patch(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .send({ maxBlobBytes: 999 })
    .expect(200);
  const tuned = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(tuned.body.maxBlobBytes, 999);

  // Audit the whole flow: publish, owner add, quota change, role change.
  const roleTarget = await signupAndAccept(app, uniqNs());
  await request(app)
    .put(`/v1/@${ns}/secret/owners/${peer.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .patch(`/v1/users/${roleTarget.user.namespace}`)
    .set(bearer(admin.token))
    .send({ role: 'admin' })
    .expect(200);

  const asPeer = await request(app).get('/v1/admin/audit').set(bearer(peer.token));
  assert.equal(asPeer.status, 403);

  const audit = await request(app).get('/v1/admin/audit').set(bearer(admin.token)).expect(200);
  const actions = audit.body.data.map((entry) => entry.action);
  for (const expected of ['version.publish', 'owner.add', 'quota.set', 'role.change']) {
    assert.ok(actions.includes(expected), `expected audit action ${expected}, got ${actions}`);
  }
  const ownerAdd = audit.body.data.find((entry) => entry.action === 'owner.add');
  assert.equal(ownerAdd.target.namespace, ns);
  assert.equal(ownerAdd.detail.added, peer.user.namespace);
  const roleChange = audit.body.data.find((entry) => entry.action === 'role.change');
  assert.equal(roleChange.detail.role, 'admin');
  assert.equal(roleChange.detail.previousRole, 'normal');

  // Pagination walks the cursor without repeating rows.
  const page1 = await request(app)
    .get('/v1/admin/audit?limit=2')
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(page1.body.data.length, 2);
  assert.ok(page1.body.pagination.hasMore);
  const page2 = await request(app)
    .get(`/v1/admin/audit?limit=2&cursor=${page1.body.pagination.nextCursor}`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(page2.body.data.length, 2);
  const seen = new Set([...page1.body.data, ...page2.body.data].map((e) => e.id));
  assert.equal(seen.size, 4);
});

test('deleting the extension refunds the account quota including source bytes', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  await expectStatus(publishPrivate({ owner, id: 'temp', code: '// temp' }), 201);
  const charged = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.ok(Number(charged.body.blobBytes) > 0);

  await request(app).delete(`/v1/@${ns}/temp`).set(bearer(owner.token)).expect(204);
  const refunded = await request(app)
    .get(`/v1/admin/users/${ns}/quota`)
    .set(bearer(admin.token))
    .expect(200);
  assert.equal(Number(refunded.body.blobBytes), 0);
});
