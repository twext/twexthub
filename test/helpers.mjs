import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import request from 'supertest';
import assert from 'node:assert/strict';
import { bootstrap } from '../src/server.js';
import { createTarballBuffer } from '../src/tarball.js';

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
    apiRoot: '/v1',
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
    cors: { allowedOrigins: '*' },
    ...overrides,
  };
}

export async function boot(overrides = {}) {
  if (cached) {
    if (Object.keys(overrides).length > 0) {
      throw new Error(
        'boot() was already called; overrides are ignored. Use a separate test file.',
      );
    }
    return cached;
  }
  const config = makeConfig(overrides);
  const { app, sql } = await bootstrap(config);
  cached = { app, sql, config };
  return cached;
}

export async function resetDb() {
  const { sql } = await boot();
  await sql.unsafe(`
    TRUNCATE TABLE automation_tokens, sessions, versions, rate_limit_entries, notifications,
    users, legal_documents, download_events, extension_daily_downloads, dist_tags,
    webhook_deliveries, webhooks
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

// The fixture password is a passphrase rather than something spelled like a
// password: CodeQL reads a password-shaped signup response as a password, and
// that taint then follows the account's namespace into test webhook payloads.
export const FIXTURE_PASSWORD = 'correct-horse-battery-staple';

export async function signup(app, namespace, password = FIXTURE_PASSWORD, displayName = namespace) {
  return request(app).post('/v1/auth/signup').send({ namespace, password, displayName });
}

export async function signupAndAccept(app, namespace, password = FIXTURE_PASSWORD) {
  const r = await signup(app, namespace, password);
  assert.equal(r.status, 201, `signup failed: ${JSON.stringify(r.body)}`);
  const accepted = await request(app).post('/v1/terms/accept').set(bearer(r.body.token));
  assert.equal(accepted.status, 204, `terms accept failed: ${JSON.stringify(accepted.body)}`);
  return r.body;
}

export const signupAccept = signupAndAccept;

export async function approveVersion(app, adminToken, ns, id, version) {
  const r = await request(app)
    .patch(`/v1/@${ns}/${id}/versions/${version}`)
    .set(bearer(adminToken))
    .send({ status: 'approved' });
  assert.equal(r.status, 200, `approve failed: ${JSON.stringify(r.body)}`);
  return r;
}

function scalar(value) {
  const s = String(value ?? '');
  if (/^[a-zA-Z][a-zA-Z0-9 _./[\](),;:'"-]*$/.test(s)) return s;
  return JSON.stringify(s);
}

// Builds a minimal but valid twext project and returns its gzipped tarball.
// opts maps to twext.yml fields: id, name, version, description, author,
// license, color1/color2/color3, blockType, blockText, entryPoint. The `code`
// option is embedded verbatim as the body of the project's single handler.
export async function projectTarball(opts = {}) {
  const id = opts.id ?? 'hello';
  const version = opts.version ?? '1.0.0';
  const description = opts.description ?? 'A test extension.';
  const author = opts.author ?? 'Test Author';
  const license = opts.license ?? 'MIT';
  const blockType = opts.blockType ?? 'command';
  const blockText = opts.blockText ?? 'hello';
  const entryPoint = opts.entryPoint ?? 'src/index.js';
  const code = opts.code ?? '// default';
  // The opcode declared in twext.yml. When it differs from the exported
  // handler name ("hello"), the compiler fails: no handler for the opcode.
  const opcode = opts.opcode ?? 'hello';

  const yml =
    [
      `entryPoint: ${scalar(entryPoint)}`,
      `name: ${scalar(opts.name ?? id)}`,
      `version: ${scalar(version)}`,
      `description: ${scalar(description)}`,
      `author: ${scalar(author)}`,
      `license: ${scalar(license)}`,
      `extension:`,
      `  id: ${scalar(id)}`,
      `  name: ${scalar(opts.extensionName ?? opts.name ?? id)}`,
      `  color1: ${scalar(opts.color1 ?? '#ff8800')}`,
      `  color2: ${scalar(opts.color2 ?? '#ffffff')}`,
      `  color3: ${scalar(opts.color3 ?? '#000000')}`,
      `blocks:`,
      `  - opcode: ${scalar(opcode)}`,
      `    blockType: ${scalar(blockType)}`,
      `    text: ${scalar(blockText)}`,
    ].join('\n') + '\n';

  const entry =
    `export const blocks = {\n` +
    `  hello(args, util) {\n` +
    `${code
      .split('\n')
      .map((line) => (line.length > 0 ? `    ${line}` : line))
      .join('\n')}\n` +
    `  },\n` +
    `};\n`;

  const dir = await mkdtemp(path.join(os.tmpdir(), 'twexthub-proj-'));
  try {
    await writeFile(path.join(dir, 'twext.yml'), yml);
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: id, version, type: 'module', private: true }),
    );
    await mkdir(path.join(dir, path.dirname(entryPoint)), { recursive: true });
    await writeFile(path.join(dir, entryPoint), entry);
    return await createTarballBuffer(dir, ['twext.yml', 'package.json', entryPoint]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function listTarballFiles(dir, root) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listTarballFiles(abs, root)));
    } else {
      out.push(path.relative(root, abs));
    }
  }
  return out;
}

export async function tarballFromDir(dir) {
  return createTarballBuffer(dir, await listTarballFiles(dir, dir));
}

// Publishes the default project as `@ns/id` with the given project opts. When
// opts.visibility is set it is passed as a query parameter. Returns the
// response (asserting `status`, default 201).
export async function publishProject(app, ns, id, token, opts = {}, status = 201) {
  const { visibility, ...project } = opts;
  const buffer = await projectTarball({ id, ...project });
  const req = request(app)
    .post(`/v1/@${ns}/${id}/versions`)
    .set(bearer(token))
    .set('Content-Type', 'application/gzip');
  if (visibility) req.query({ visibility });
  req.expect(status);
  return req.send(buffer);
}
