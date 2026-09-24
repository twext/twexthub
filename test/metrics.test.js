import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept } from './helpers.mjs';
import { aggregateDayLoader } from '../src/metrics.js';

let app;
let sql;
let aggregateDay;
before(async () => {
  ({ app, sql } = await boot());
  aggregateDay = aggregateDayLoader(sql);
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

async function publishAs(ns, nsToken, adminToken, id, version, code) {
  await request(app)
    .post(`/v1/@${ns}/${id}/versions`)
    .set(bearer(nsToken))
    .send({ manifest: { id, version, license: 'MIT', name: id, description: 'd' }, code })
    .expect(201);
  await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
}

async function makePublished() {
  const adminNs = uniqNs();
  const ab = await signupAndAccept(app, adminNs);
  const ownerNs = uniqNs();
  const ob = await signupAndAccept(app, ownerNs);
  await publishAs(ownerNs, ob.token, ab.token, 'hello', '1.0.0', '// v1.0.0');
  return { ownerNs, adminToken: ab.token };
}

test('downloads are counted, surfaced, and feed trending', async () => {
  const { ownerNs, adminToken } = await makePublished();
  const w = await signupAndAccept(app, uniqNs());
  await publishAs(w.user.namespace, w.token, adminToken, 'widget', '1.0.0', '// widget');

  await request(app).get(`/v1/@${ownerNs}/hello/versions/latest/download`).expect(200);
  await request(app).get(`/v1/@${ownerNs}/hello/versions/latest/download`).expect(200);

  await sql.unsafe(`
    INSERT INTO download_events (namespace, extension_id, version, user_agent, remote_addr, created_at)
    SELECT e.namespace, e.extension_id, '1.0.0', 'x', '10.0.0.1',
           now() - INTERVAL '3 days'
    FROM versions e
    WHERE e.extension_id = 'widget'
    UNION ALL
    SELECT e.namespace, e.extension_id, '2.0.0', 'y', '10.0.0.2',
           now() - INTERVAL '8 days'
    FROM versions e
    WHERE e.extension_id = 'gizmo'
  `);
  for (const days of [3, 8]) {
    await aggregateDay(new Date(Date.now() - days * 86400000));
  }

  // the published extension's daily bucket only counts aggregations run so far
  await aggregateDay(new Date());
  const [bucket] = await sql`
    SELECT * FROM extension_daily_downloads
    WHERE namespace = ${ownerNs} AND extension_id = 'hello'
  `;
  assert.ok(Number(bucket.total_downloads) >= 2);

  const detail = await request(app).get(`/v1/@${ownerNs}/hello`).expect(200);
  assert.ok(Number(detail.body.downloads) >= 2);

  // widget (3 days ago) makes trending; gizmo (8 days) does not
  const trending = await request(app).get('/v1/extensions/trending').expect(200);
  const entries = trending.body.data.map((e) => `${e.namespace}/${e.id}`);
  const trendingId = (id) => entries.find((key) => key.endsWith('/' + id));
  assert.ok(trendingId('widget'), `widget missing from ${entries.join(', ')}`);
  assert.ok(!trendingId('gizmo'), 'gizmo should not trend');

  const stats = await request(app).get('/v1/stats').expect(200);
  assert.ok(Number(stats.body.downloads) >= 2);
});
