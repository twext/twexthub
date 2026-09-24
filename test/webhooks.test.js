import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import request from 'supertest';
import { boot, resetDb, bearer, uniqNs, signupAndAccept } from './helpers.mjs';
import {
  attemptDelivery,
  makeWebhooks,
  signWebhookPayload,
  WEBHOOK_EVENTS,
} from '../src/webhooks.js';

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

// scheduleFor runs fire-and-forget; give it a tick to land its inserts.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

async function publishApproved(ns, token, adminToken, id, version) {
  await request(app)
    .post(`/v1/@${ns}/${id}/versions`)
    .set(bearer(token))
    .send({ manifest: manifest(id, version), code: `// ${id}@${version}` })
    .expect(201);
  await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' })
    .expect(200);
}

async function makeOwner() {
  const admin = await signupAndAccept(app, uniqNs());
  const owner = await signupAndAccept(app, uniqNs());
  const ns = owner.user.namespace;
  await publishApproved(ns, owner.token, admin.token, 'hooked', '1.0.0');
  return { admin, owner, ns };
}

// create() blocks loopback and unreachable URLs, so tests that exercise
// delivery insert the webhook row directly.
async function insertWebhook(ns, url, events) {
  const [row] = await sql`
    INSERT INTO webhooks (namespace, extension_id, url, secret, events)
    VALUES (${ns}, 'hooked', ${url}, 'test-secret-0123456789abcdef', ${events})
    RETURNING id
  `;
  return row.id;
}

// The sandbox resolver cannot resolve fake hosts, so create() calls in tests
// use a real, publicly-resolving name.
const PUBLIC_URL = 'https://example.com/twext-hook';

test('creating a webhook returns the secret once; listing never does', async () => {
  const { owner, ns } = await makeOwner();

  const created = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);
  assert.equal(created.body.secret.length, 32);
  assert.equal(created.body.active, true);
  assert.ok(created.body.id);

  const list = await request(app)
    .get(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].secret, undefined);
  assert.equal(list.body.data[0].url, PUBLIC_URL);
});

test('webhook validation rejects bad events, bad urls, and non-owners', async () => {
  const { owner, ns } = await makeOwner();
  const outsider = await signupAndAccept(app, uniqNs());

  await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(outsider.token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(403);

  const badEvents = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: ['nope'] });
  assert.equal(badEvents.status, 422);
  assert.equal(badEvents.body.errors[0].field, 'events');

  const missingUrl = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ events: ['version.published'] });
  assert.equal(missingUrl.status, 422);
  assert.equal(missingUrl.body.errors[0].field, 'url');

  const localhost = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: 'http://localhost:9911/hook', events: ['version.published'] });
  assert.equal(localhost.status, 422);
  assert.match(localhost.body.errors[0].message, /Localhost|public/);
});

test('registry events schedule deliveries for subscribed hooks', async () => {
  const { owner, ns } = await makeOwner();
  await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: WEBHOOK_EVENTS })
    .expect(201);

  // 2.0.0 publishes straight to 'published' since the owner's first version
  // was approved; no admin call needed.
  await request(app)
    .post(`/v1/@${ns}/hooked/versions`)
    .set(bearer(owner.token))
    .send({ manifest: manifest('hooked', '2.0.0'), code: '// hooked@2.0.0' })
    .expect(201);
  await request(app)
    .patch(`/v1/@${ns}/hooked/versions/2.0.0/deprecate`)
    .set(bearer(owner.token))
    .send({ message: 'old' })
    .expect(200);
  await request(app)
    .delete(`/v1/@${ns}/hooked/versions/2.0.0`)
    .set(bearer(owner.token))
    .expect(204);
  const other = await signupAndAccept(app, uniqNs());
  await request(app)
    .put(`/v1/@${ns}/hooked/owners/${other.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .delete(`/v1/@${ns}/hooked/owners/${other.user.namespace}`)
    .set(bearer(owner.token))
    .expect(204);

  await settle();
  const events = await sql`SELECT event, payload FROM webhook_deliveries ORDER BY id`;
  const seen = events.map((row) => row.event);
  for (const event of [
    'version.published',
    'version.deprecated',
    'version.yanked',
    'owners.changed',
  ]) {
    assert.ok(seen.includes(event), `${event} should schedule a delivery`);
  }
  const [published] = events.filter((row) => row.event === 'version.published');
  assert.equal(published.payload.version, '2.0.0');
  assert.equal(published.payload.namespace, ns);
  assert.ok(published.payload.occurredAt);
});

test('version.rejected fires from the review endpoint', async () => {
  const admin = await signupAndAccept(app, uniqNs());
  const newcomer = await signupAndAccept(app, uniqNs());
  const newcomerNs = newcomer.user.namespace;

  // A webhook on an extension that has no versions yet is allowed; the first
  // publish is then held as pending and rejected by an admin.
  await request(app)
    .post(`/v1/@${newcomerNs}/fresh/webhooks`)
    .set(bearer(newcomer.token))
    .send({ url: PUBLIC_URL, events: ['version.rejected'] })
    .expect(201);
  await request(app)
    .post(`/v1/@${newcomerNs}/fresh/versions`)
    .set(bearer(newcomer.token))
    .send({ manifest: manifest('fresh', '1.0.0'), code: '// x' })
    .expect(201);
  await request(app)
    .patch(`/v1/@${newcomerNs}/fresh/versions/1.0.0`)
    .set(bearer(admin.token))
    .send({ status: 'rejected', reason: 'nope' })
    .expect(200);
  await settle();

  const [delivery] = await sql`
    SELECT event, payload FROM webhook_deliveries WHERE event = 'version.rejected'
  `;
  assert.ok(delivery, 'a rejection should schedule a delivery');
  assert.equal(delivery.payload.id, 'fresh');
  assert.equal(delivery.payload.actor, admin.user.namespace);
});

test('delivery posts the signed payload and records status', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        event: req.headers['x-twexthub-event'],
        signature: req.headers['x-twexthub-signature'],
        delivery: req.headers['x-twexthub-delivery'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { owner, ns } = await makeOwner();
    const created = await request(app)
      .post(`/v1/@${ns}/hooked/webhooks`)
      .set(bearer(owner.token))
      .send({ url: PUBLIC_URL, events: ['version.published'] })
      .expect(201);
    const { secret, id: webhookId } = created.body;
    const url = `http://127.0.0.1:${port}/hook`;
    await sql`UPDATE webhooks SET url = ${url} WHERE id = ${webhookId}`;

    const payload = {
      event: 'version.published',
      namespace: ns,
      id: 'hooked',
      version: '1.0.0',
      occurredAt: new Date().toISOString(),
      actor: ns,
    };
    const body = JSON.stringify(payload);
    const signature = signWebhookPayload(secret, body);
    const [delivery] = await sql`
      INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
      VALUES (${webhookId}, 'version.published', ${sql.json(payload)}, ${body}, ${signature})
      RETURNING *
    `;

    const result = await attemptDelivery(sql, { ...delivery, url });
    assert.equal(result.ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].event, 'version.published');
    assert.equal(received[0].signature, signature);
    assert.deepEqual(JSON.parse(received[0].body), payload);

    const [after] =
      await sql`SELECT status, attempt FROM webhook_deliveries WHERE id = ${delivery.id}`;
    assert.equal(after.status, 'delivered');
    const [hook] = await sql`SELECT last_delivery_status FROM webhooks WHERE id = ${webhookId}`;
    assert.equal(hook.last_delivery_status, 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('failed deliveries retry with backoff then mark failed', async () => {
  const { owner, ns } = await makeOwner();
  const rejected = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: 'https://never.invalid/hook', events: ['version.published'] });
  assert.equal(rejected.status, 422, 'unresolvable hosts are rejected at create time');

  const webhookId = await insertWebhook(ns, 'https://172.31.255.7/hook', ['version.published']);
  const secret = 'test-secret-0123456789abcdef';

  const payload = { event: 'version.published', namespace: ns, id: 'hooked', version: '1.0.0' };
  const body = JSON.stringify(payload);
  const [delivery] = await sql`
    INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
    VALUES (${webhookId}, 'version.published', ${sql.json(payload)}, ${body},
            ${signWebhookPayload(secret, body)})
    RETURNING *
  `;

  // DNS for .test fails in the sandbox, so the fetch errors and the retry
  // bookkeeping runs without a live receiver.
  const first = await attemptDelivery(sql, delivery);
  assert.equal(first.ok, false);
  const [afterFirst] =
    await sql`SELECT status, attempt, next_attempt_at FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(afterFirst.status, 'retrying');
  assert.equal(afterFirst.attempt, 1);
  assert.ok(afterFirst.next_attempt_at, 'retrying rows must carry a next_attempt_at');

  await sql`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = ${delivery.id}`;
  await attemptDelivery(sql, { ...delivery, attempt: 1 });
  const [afterSecond] =
    await sql`SELECT status, attempt FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(afterSecond.status, 'retrying');
  await sql`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = ${delivery.id}`;
  await attemptDelivery(sql, { ...delivery, attempt: 2 });
  const [afterThird] =
    await sql`SELECT status, attempt FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(afterThird.status, 'retrying');
  await sql`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE id = ${delivery.id}`;
  await attemptDelivery(sql, { ...delivery, attempt: 3 });
  const [afterFourth] =
    await sql`SELECT status, attempt, next_attempt_at FROM webhook_deliveries WHERE id = ${delivery.id}`;
  assert.equal(afterFourth.status, 'failed');
  assert.equal(afterFourth.attempt, 4);
  assert.equal(afterFourth.next_attempt_at, null);

  const [hook] = await sql`SELECT last_delivery_status FROM webhooks WHERE id = ${webhookId}`;
  assert.equal(hook.last_delivery_status, 'error');
});

test('deleting a webhook removes its pending deliveries', async () => {
  const { owner, ns } = await makeOwner();
  const created = await request(app)
    .post(`/v1/@${ns}/hooked/webhooks`)
    .set(bearer(owner.token))
    .send({ url: PUBLIC_URL, events: ['version.published'] })
    .expect(201);

  const webhooks = makeWebhooks({ sql });
  await webhooks.scheduleFor(ns, 'hooked', 'version.published', { version: '1.0.0' });
  await settle();
  const count =
    await sql`SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${created.body.id}`;
  assert.equal(count[0].n, 1);

  await request(app)
    .delete(`/v1/@${ns}/hooked/webhooks/${created.body.id}`)
    .set(bearer(owner.token))
    .expect(204);
  await request(app)
    .delete(`/v1/@${ns}/hooked/webhooks/${created.body.id}`)
    .set(bearer(owner.token))
    .expect(404);

  const after =
    await sql`SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE webhook_id = ${created.body.id}`;
  assert.equal(after[0].n, 0);
});

test('ssrf guard rejects loopback hosts and non-http schemes', async () => {
  const { assertPublicWebhookUrl } = await import('../src/webhooks.js');

  await assert.rejects(() => assertPublicWebhookUrl('http://localhost:8080/'), /Localhost/);
  await assert.rejects(() => assertPublicWebhookUrl('http://127.0.0.1:8080/'), /public/);
  await assert.rejects(() => assertPublicWebhookUrl('ftp://hooks.example.test/'), /http or https/);
});
