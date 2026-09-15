import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { bootstrap } from '../src/server.js';

export const TEST_DATABASE_URL =
  process.env.TWEXTHUB_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/twexthub_test';

let cached = null;
let seq = 0;

export function uniqNs() {
  seq += 1;
  return 'ns' + seq + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function makeConfig(overrides = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'twexthub-test-'));
  return {
    port: 0,
    dataDir,
    apiRoot: '/v0',
    publicBaseUrl: 'http://hub.test:8080',
    requireHttps: false,
    database: { url: TEST_DATABASE_URL, maxConnections: 6 },
    auth: { sessionTtlDays: 7, scrypt: { N: 16384, r: 8, p: 1 } },
    rateLimits: {
      loginAttemptsPerWindow: 5,
      loginWindowMinutes: 15,
      signupsPerIpPerWindow: 5,
      signupWindowMinutes: 15,
    },
    pagination: { defaultLimit: 20, maxLimit: 50 },
    ...overrides,
  };
}

export async function boot(overrides = {}) {
  if (cached) return cached;
  const config = makeConfig(overrides);
  const { app, sql } = await bootstrap(config);
  cached = { app, sql, config };
  return cached;
}

export async function resetDb() {
  const { sql } = await boot();
  await sql.unsafe(`
    TRUNCATE TABLE automation_tokens, sessions, versions, rate_limit_entries, users, legal_documents
    RESTART IDENTITY CASCADE
  `);
  await sql`
    INSERT INTO legal_documents (kind, version, body)
    VALUES ('terms', 1, 'Placeholder terms.'), ('privacy', 1, 'Placeholder privacy.')
  `;
}

export function bearer(token) {
  return { Authorization: 'Bearer ' + token };
}

export async function signup(app, namespace, password = 'password123', displayName = namespace) {
  return request(app).post('/v0/auth/signup').send({ namespace, password, displayName });
}

export async function signupAndAccept(app, namespace, password = 'password123') {
  const r = await signup(app, namespace, password);
  if (r.status !== 201) return r;
  await request(app).post('/v0/terms/accept').set(bearer(r.body.token));
  return r.body;
}

export const signupAccept = signupAndAccept;
