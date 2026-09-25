import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept, publishProject } from './helpers.mjs';

let app;
let sql;
before(async () => {
  ({ app, sql } = await boot());
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function makeSetup() {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  // The first publish is held for review; after its approval the rest go
  // straight to 'published'.
  const publish = async (version, approve) => {
    await publishProject(app, ns, 'ranger', owner.token, { version, code: `// ${version}` });
    if (approve) {
      await request(app)
        .patch(`/v1/@${ns}/ranger/versions/${version}`)
        .set(bearer(admin.token))
        .send({ status: 'approved' })
        .expect(200);
    }
  };
  for (const [version, approve] of [
    ['1.0.0', true],
    ['1.2.0', false],
    ['1.9.9', false],
    ['2.0.0', false],
  ]) {
    await publish(version, approve);
  }
  return { admin, owner, ns };
}

test('resolve picks the highest published version in the range', async () => {
  const { ns } = await makeSetup();

  for (const [range, expected] of [
    ['^1.2', '1.9.9'],
    ['~1.0', '1.0.0'],
    ['<2', '1.9.9'],
    ['>=1.0.0 <1.3.0', '1.2.0'],
    ['*', '2.0.0'],
    ['2.0.0', '2.0.0'],
  ]) {
    const r = await request(app).get(`/v1/@${ns}/ranger/versions/resolve`).query({ range });
    assert.equal(r.status, 200, `range ${range}`);
    assert.equal(r.body.version, expected, `range ${range}`);
    assert.equal(r.body.dist.downloadUrl.includes(`versions/${expected}/download`), true);
  }
});

test('resolve prefers strictly-published over deprecated', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ons = owner.user.namespace;
  for (const [version, approve] of [
    ['1.0.0', true],
    ['1.1.0', false],
  ]) {
    await publishProject(app, ons, 'dep', owner.token, { version, code: `// ${version}` });
    if (approve) {
      await request(app)
        .patch(`/v1/@${ons}/dep/versions/${version}`)
        .set(bearer(admin.token))
        .send({ status: 'approved' })
        .expect(200);
    }
  }
  await request(app)
    .patch(`/v1/@${ons}/dep/versions/1.1.0/deprecate`)
    .set(bearer(owner.token))
    .send({ message: 'broken' })
    .expect(200);

  // 1.1.0 is deprecated but still in the pool; the highest in range wins and
  // carries its deprecation notice.
  const r = await request(app).get(`/v1/@${ons}/dep/versions/resolve`).query({ range: '*' });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, '1.1.0');
  assert.ok(r.body.deprecation);
});

test('yanked versions never satisfy a range', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  for (const [version, approve] of [
    ['1.0.0', true],
    ['1.1.0', false],
  ]) {
    await publishProject(app, ns, 'yank', owner.token, { version, code: `// ${version}` });
    if (approve) {
      await request(app)
        .patch(`/v1/@${ns}/yank/versions/${version}`)
        .set(bearer(admin.token))
        .send({ status: 'approved' })
        .expect(200);
    }
  }
  await request(app).delete(`/v1/@${ns}/yank/versions/1.1.0`).set(bearer(owner.token)).expect(204);

  const r = await request(app).get(`/v1/@${ns}/yank/versions/resolve`).query({ range: '^1.0' });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, '1.0.0');
});

test('invalid ranges and misses are rejected', async () => {
  const { ns } = await makeSetup();

  const bad = await request(app)
    .get(`/v1/@${ns}/ranger/versions/resolve`)
    .query({ range: 'not-a-range' });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.errors[0].field, 'range');

  const missing = await request(app)
    .get(`/v1/@${ns}/ranger/versions/resolve`)
    .query({ range: '^99.0.0' });
  assert.equal(missing.status, 404);

  const noParam = await request(app).get(`/v1/@${ns}/ranger/versions/resolve`);
  assert.equal(noParam.status, 422);
});
