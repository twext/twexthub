import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';

export const WEBHOOK_EVENTS = Object.freeze([
  'version.published',
  'version.yanked',
  'version.deprecated',
  'version.rejected',
  'owners.changed',
]);

// Index 0 is the initial attempt; the rest are retry delays.
const RETRY_DELAYS_MS = [0, 5_000, 30_000, 300_000];
const POLL_INTERVAL_MS = 15_000;
const DELIVERY_BATCH = 50;
const DELIVERY_TIMEOUT_MS = 10_000;

function isPrivateIp(ip) {
  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return a >= 224; // multicast and reserved
  }
  if (version !== 6) return true;
  const norm = ip.toLowerCase();
  if (norm === '::' || norm === '::1') return true;
  // Fail closed on v4-mapped addresses; the embedded v4 may be private.
  if (norm.includes(':ffff:')) return true;
  const first = norm.split(':')[0];
  if (first.startsWith('fc') || first.startsWith('fd')) return true; // unique local fc00::/7
  if (first.startsWith('fe')) return true; // link-local fe80::/10 and reserved
  if (first === '2002' || first === '64') return true; // deprecated 6to4, nat64
  if (norm.startsWith('2001:0:')) return true; // teredo
  return false;
}

// Validate a webhook URL and return it together with the address it resolved
// to. The address is what a delivery connects to: resolving the name and then
// connecting by name would leave room for a second answer to point somewhere
// else, so callers carry this one through instead of the name.
export async function resolvePublicWebhookTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid webhook URL.');
  }
  // Private destinations are already refused, so there is no local receiver for
  // plain http to serve: the scheme can be https and nothing else.
  if (url.protocol !== 'https:') {
    throw new Error('Webhook URL must use https.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') {
    throw new Error('Localhost is not a valid webhook target.');
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new Error('Webhook URL must resolve to a public (non-private) address.');
    }
    return { url, address: host, family: isIP(host) };
  }
  let addresses;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new Error('Webhook URL host could not be resolved.');
  }
  if (addresses.length === 0 || addresses.some((entry) => isPrivateIp(entry.address))) {
    throw new Error('Webhook URL must resolve to a public (non-private) address.');
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

export async function assertPublicWebhookUrl(rawUrl) {
  return (await resolvePublicWebhookTarget(rawUrl)).url;
}

export function newWebhookSecret() {
  return randomBytes(24).toString('base64url');
}

export function signWebhookPayload(secret, body) {
  // The secret is 24 random bytes from newWebhookSecret, so it is used as the
  // HMAC key directly; deriving it first would only slow every delivery down.
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

export function isValidWebhookEvent(event) {
  return typeof event === 'string' && WEBHOOK_EVENTS.includes(event);
}

export class WebhookInputError extends Error {
  constructor(fields) {
    super(fields.map((f) => f.message).join('; '));
    this.name = 'WebhookInputError';
    this.fields = fields;
  }
}

export function makeWebhooks({ sql }) {
  async function create(namespace, extensionId, input) {
    const errors = [];
    if (
      !Array.isArray(input.events) ||
      input.events.length === 0 ||
      !input.events.every(isValidWebhookEvent)
    ) {
      errors.push({
        field: 'events',
        message: 'Must be a non-empty array of supported events.',
      });
    }
    if (typeof input.url !== 'string' || input.url.length === 0) {
      errors.push({ field: 'url', message: 'URL is required.' });
    }
    if (errors.length > 0) throw new WebhookInputError(errors);
    try {
      await assertPublicWebhookUrl(input.url);
    } catch (error) {
      throw new WebhookInputError([{ field: 'url', message: error.message }]);
    }
    const secret = newWebhookSecret();
    const [row] = await sql`
      INSERT INTO webhooks (namespace, extension_id, url, secret, events, active)
      VALUES (${namespace}, ${extensionId}, ${input.url}, ${secret},
              ${input.events}, ${input.active !== false})
      RETURNING id, namespace, extension_id, url, events, active, created_at
    `;
    return { ...row, secret };
  }

  async function list(namespace, extensionId) {
    return await sql`
      SELECT id, namespace, extension_id, url, events, active,
             last_delivery_status, last_delivery_at, created_at
      FROM webhooks
      WHERE namespace = ${namespace} AND extension_id = ${extensionId}
      ORDER BY created_at DESC
    `;
  }

  async function remove(namespace, extensionId, id) {
    const [deleted] = await sql`
      DELETE FROM webhooks
      WHERE id = ${id} AND namespace = ${namespace} AND extension_id = ${extensionId}
      RETURNING 1
    `;
    return Boolean(deleted);
  }

  async function scheduleFor(namespace, extensionId, event, basePayload) {
    try {
      const hooks = await sql`
        SELECT * FROM webhooks
        WHERE namespace = ${namespace} AND extension_id = ${extensionId}
          AND active AND ${event} = ANY (events)
      `;
      for (const hook of hooks) {
        const payload = {
          event,
          namespace,
          id: extensionId,
          ...basePayload,
        };
        // Sign these exact bytes and store them with the delivery: jsonb
        // round-trips reorder keys, so re-serializing at delivery time would
        // produce a body that no longer matches the signature.
        const body = JSON.stringify(payload);
        const signature = signWebhookPayload(hook.secret, body);
        await sql`
          INSERT INTO webhook_deliveries (webhook_id, event, payload, body, signature)
          VALUES (${hook.id}, ${event}, ${sql.json(payload)}, ${body}, ${signature})
        `;
      }
    } catch (error) {
      console.error('webhook scheduling failed:', error);
    }
  }

  function worker() {
    let timer = null;
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await deliverDue(sql, Date.now());
      } catch (error) {
        console.error('webhook delivery worker failed:', error);
      } finally {
        running = false;
      }
    };
    return {
      start() {
        timer = setInterval(tick, POLL_INTERVAL_MS);
        timer.unref?.();
        void tick();
        return this;
      },
      async stop() {
        if (timer) clearInterval(timer);
        while (running) await new Promise((resolve) => setTimeout(resolve, 50));
      },
    };
  }

  return { create, list, remove, scheduleFor, worker };
}

export async function deliverDue(sql, now = Date.now()) {
  const due = await sql`
    SELECT d.*, w.url, w.active
    FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id
    WHERE d.status IN ('pending', 'retrying')
      AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ${new Date(now).toISOString()})
    ORDER BY d.next_attempt_at NULLS FIRST
    LIMIT ${DELIVERY_BATCH}
  `;
  const results = [];
  for (const delivery of due) {
    results.push(await attemptDelivery(sql, delivery, now));
  }
  return results;
}

// POST the body to an address that has already been checked. The socket is
// pinned with `lookup`, so the request goes to the address the check approved
// and TLS still validates the hostname it was registered under.
function postToTarget(target, delivery) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      target.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-TwextHub-Event': delivery.event,
          'X-TwextHub-Signature': delivery.signature,
          'X-TwextHub-Delivery': String(delivery.id),
          'Content-Length': Buffer.byteLength(delivery.body),
        },
        // Undefined outside the test receiver, which supplies the CA for its
        // self-signed certificate; the default trust store applies otherwise.
        ca: target.ca,
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [{ address: target.address, family: target.family }]);
          else callback(null, target.address, target.family);
        },
      },
      (res) => {
        res.resume();
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode });
      },
    );
    req.setTimeout(DELIVERY_TIMEOUT_MS, () => {
      req.destroy(new Error(`Delivery timed out after ${DELIVERY_TIMEOUT_MS} ms.`));
    });
    req.on('error', reject);
    req.end(delivery.body);
  });
}

// `resolveTarget` is a seam for the test receiver, which listens on loopback;
// the worker always resolves and validates for real.
export async function attemptDelivery(
  sql,
  delivery,
  now = Date.now(),
  resolveTarget = resolvePublicWebhookTarget,
) {
  const attempt = delivery.attempt + 1;
  let error = null;
  let ok = false;
  try {
    // The name passed the check at registration, but DNS answers change, so
    // every attempt resolves it again and connects to the address that answer
    // produced.
    const target = await resolveTarget(delivery.url);
    const res = await postToTarget(target, delivery);
    ok = res.ok;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e.message;
  }

  const retrying = !ok && attempt < delivery.max_attempts;
  const delay = ok ? 0 : (RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1));
  await sql`
    UPDATE webhook_deliveries
    SET status = ${ok ? 'delivered' : retrying ? 'retrying' : 'failed'},
        attempt = ${attempt},
        last_error = ${ok ? null : error},
        next_attempt_at = ${retrying ? new Date(now + delay).toISOString() : null},
        updated_at = now()
    WHERE id = ${delivery.id}
  `.catch(() => {});
  if (ok || retrying) {
    await sql`
      UPDATE webhooks
      SET last_delivery_status = ${ok ? 'ok' : 'error'},
          last_delivery_at = now()
      WHERE id = ${delivery.webhook_id}
    `.catch(() => {});
  }
  return { id: delivery.id, ok, retrying, error };
}
