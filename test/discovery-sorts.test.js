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

// Publishes several extensions under fresh namespaces. Returns their metadata
// for the assertions below.
async function seedExtensions() {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;

  const first = async (id, version, extra) => {
    await publishProject(app, ns, id, owner.token, {
      version,
      code: `// ${id}`,
      description: `desc ${id}`,
      ...extra,
    });
    const queue = await request(app)
      .get('/v1/versions?status=pending')
      .set(bearer(admin.token))
      .expect(200);
    const entry = queue.body.data.find((v) => v.namespace === ns && v.id === id);
    await request(app)
      .patch(`/v1/@${ns}/${id}/versions/${entry.version}`)
      .set(bearer(admin.token))
      .send({ status: 'approved' })
      .expect(200);
  };
  const rest = async (id, version, extra) => {
    await publishProject(app, ns, id, owner.token, {
      version,
      code: `// ${id}`,
      description: `desc ${id}`,
      ...extra,
    });
  };

  // Publish order: minterm (Apache), alpaca (MIT), zoo (MIT) — alphabetical
  // name order differs from recency order.
  await first('minterm', '1.0.0', { license: 'Apache-2.0' });
  await rest('alpaca', '1.0.0');
  await rest('zoo', '1.0.0');
  return { ns, owner, admin };
}

async function downloadNs(sqlClient, ns, id) {
  await sqlClient`
    INSERT INTO download_events (namespace, extension_id, version, user_agent, remote_addr)
    VALUES (${ns}, ${id}, '1.0.0', 'test', '10.0.0.9')
  `;
}

test('sort=downloads orders by cumulative downloads', async () => {
  const { ns } = await seedExtensions();
  // zoo gets the most downloads, alpaca none
  for (let i = 0; i < 3; i += 1) await downloadNs(sql, ns, 'zoo');
  await downloadNs(sql, ns, 'minterm');
  const { aggregateDayLoader } = await import('../src/metrics.js');
  await aggregateDayLoader(sql)(new Date());

  const r = await request(app).get('/v1/extensions?sort=downloads').expect(200);
  const ids = r.body.data.filter((e) => e.namespace === ns).map((e) => e.id);
  assert.deepEqual(ids, ['zoo', 'minterm', 'alpaca']);
  const zoo = r.body.data.find((e) => e.id === 'zoo');
  assert.equal(zoo.downloads, 3);
});

test('sort=name is alphabetical, sort=updated favors newest publication', async () => {
  const { ns } = await seedExtensions();

  const byName = await request(app).get('/v1/extensions?sort=name').expect(200);
  const nameIds = byName.body.data.filter((e) => e.namespace === ns).map((e) => e.id);
  assert.deepEqual(nameIds, ['alpaca', 'minterm', 'zoo']);

  // minterm was published first (pending approval), zoo last
  const byUpdated = await request(app).get('/v1/extensions?sort=updated').expect(200);
  const updatedIds = byUpdated.body.data.filter((e) => e.namespace === ns).map((e) => e.id);
  assert.deepEqual(updatedIds, ['zoo', 'alpaca', 'minterm']);
});

test('license filter narrows results and combines with search', async () => {
  await seedExtensions();

  const apache = await request(app).get('/v1/extensions?license=Apache-2.0').expect(200);
  assert.equal(apache.body.data.length, 1);
  assert.equal(apache.body.data[0].id, 'minterm');
  assert.equal(apache.body.data[0].license, undefined); // summaries carry no license field

  const mit = await request(app).get('/v1/search?query=desc&license=MIT').expect(200);
  assert.ok(mit.body.data.length >= 2);
  assert.ok(!mit.body.data.some((e) => e.id === 'minterm'));

  const both = await request(app).get('/v1/search?query=zoo&license=MIT').expect(200);
  assert.equal(both.body.data.length, 1);
  assert.equal(both.body.data[0].id, 'zoo');
});

test('unknown sort values are rejected with 400', async () => {
  const r = await request(app).get('/v1/extensions?sort=popular');
  assert.equal(r.status, 400);
});

test('paginating with sort=name walks every page', async () => {
  await seedExtensions();

  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const url =
      '/v1/extensions?sort=name&limit=2' + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const r = await request(app).get(url).expect(200);
    for (const e of r.body.data) seen.push(`${e.namespace}/${e.id}`);
    cursor = r.body.pagination.nextCursor;
    guard += 1;
    assert.ok(guard < 10, 'pagination did not terminate');
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
});

test('badge renders an SVG with version, downloads, and license', async () => {
  const { ns } = await seedExtensions();
  await downloadNs(sql, ns, 'zoo');
  const { aggregateDayLoader } = await import('../src/metrics.js');
  await aggregateDayLoader(sql)(new Date());

  const r = await request(app).get(`/v1/badge/@${ns}/zoo`).expect(200);
  assert.match(r.headers['content-type'], /image\/svg\+xml/);
  const svg = r.text ?? r.body.toString('utf8');
  assert.match(svg, /<svg /);
  assert.match(svg, /zoo/);
  assert.match(svg, /v1\.0\.0/);
  assert.match(svg, /1 download/);
  assert.match(svg, /MIT/);

  const missing = await request(app).get(`/v1/badge/@${ns}/nonexistent`);
  assert.equal(missing.status, 404);
});

test('feed.atom lists the latest publishes as entries', async () => {
  const { ns } = await seedExtensions();

  const r = await request(app).get('/v1/feed.atom').expect(200);
  assert.match(r.headers['content-type'], /application\/atom\+xml/);
  const xml = r.text ?? r.body.toString('utf8');
  assert.match(xml, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  // Entry ids are tag URIs, not feed titles; the feed title is the product name.
  assert.match(xml, /<title>TwextHub/);
  assert.match(xml, /<title>zoo v1\.0\.0<\/title>/);
  assert.match(xml, new RegExp(`tag:twexthub,\\d{4}-\\d{2}-\\d{2}:@${ns}/zoo-1.0.0`));
  assert.match(xml, /<updated>\d{4}-\d{2}-\d{2}T/);
  // one entry per extension, newest publish first
  const entries = xml.match(/<entry>/g) ?? [];
  assert.equal(entries.length, 3);
  const zooPos = xml.indexOf(`@${ns}/zoo-1.0.0`);
  const alpacaPos = xml.indexOf(`@${ns}/alpaca-1.0.0`);
  assert.ok(zooPos < alpacaPos, 'zoo published after alpaca so it comes first');
});
