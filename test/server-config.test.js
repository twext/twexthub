import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname } from 'node:path';
import request from 'supertest';
import {
  applyServerConfig,
  configStorage,
  editableSettings,
  EDITABLE_SETTINGS,
} from '../src/server-config.js';
import { boot, bearer, resetDb, signupAndAccept, uniqNs } from './helpers.mjs';

let app;
let sql;
let config;
let configFile;
let originalConfigPath;

const CONFIG_YAML = `# Instance settings. Keep this file: it is mounted, not baked in.
port: 3000
publicBaseUrl: http://localhost:3000
limits:
  maxSourceBytes: 1048576
`;

before(async () => {
  ({ app, sql, config } = await boot());
  configFile = path.join(mkdtempSync(path.join(tmpdir(), 'twexthub-config-')), 'config.yaml');
  writeFileSync(configFile, CONFIG_YAML, 'utf8');
  originalConfigPath = config.configPath;
  config.configPath = configFile;
});
beforeEach(async () => {
  await resetDb();
  writeFileSync(configFile, CONFIG_YAML, 'utf8');
  config.pagination.defaultLimit = 20;
  config.pagination.maxLimit = 50;
});
after(async () => {
  config.configPath = originalConfigPath;
  await sql.end();
});

async function admin() {
  const account = await signupAndAccept(app, uniqNs());
  await sql`UPDATE users SET role = 'admin' WHERE namespace = ${account.user.namespace}`;
  return account;
}

// The first account on a fresh instance is made an admin, so a test that wants
// an ordinary account says so rather than depending on the signup order.
async function ordinary() {
  const account = await signupAndAccept(app, uniqNs());
  await sql`UPDATE users SET role = 'normal' WHERE namespace = ${account.user.namespace}`;
  return account;
}

// Mount tables are written by hand rather than read, so the test does not depend
// on where the checkout happens to live or on whether the host has /tmp mounted.
// A single mount at the root is what a container's own writable layer looks like
// from inside; the second table adds a bind mount over the temp directory, which
// is what an operator mounting the config into a volume gets.
const CONTAINER_MOUNT = '1 0 0:1 / / rw,relatime - overlay overlay rw\n';
const volumeMount = (dir) => `${CONTAINER_MOUNT}2 0 0:2 / ${dir} rw,relatime - ext4 /dev/sda1 rw\n`;

describe('configStorage', () => {
  test('calls a file under the root mount read-only inside a container', () => {
    const storage = configStorage(configFile, { mountInfo: CONTAINER_MOUNT, container: true });
    assert.equal(storage.writable, true);
    assert.equal(storage.persistent, false);
    assert.match(storage.reason, /volume/i);
  });

  test('accepts a file on the host filesystem, which a recreate does not discard', () => {
    // A host install writing to its own root filesystem keeps the file, so
    // refusing the change there would refuse one that is safe to make.
    const storage = configStorage(configFile, { mountInfo: CONTAINER_MOUNT, container: false });
    assert.equal(storage.persistent, true);
    assert.equal(storage.reason, null);
  });

  test('calls a file under a bind mount persistent', () => {
    const storage = configStorage(configFile, {
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.equal(storage.writable, true);
    assert.equal(storage.persistent, true);
    assert.equal(storage.reason, null);
  });

  test('reports a missing or unwritable file as read-only', () => {
    const storage = configStorage('/nonexistent/twexthub/config.yaml', {
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.equal(storage.writable, false);
    assert.equal(storage.persistent, false);
    assert.match(storage.reason, /not writable/i);
  });
});

describe('applyServerConfig', () => {
  test('refuses to write a config that would not survive a restart', () => {
    assert.throws(
      () =>
        applyServerConfig({
          config,
          configPath: configFile,
          patch: { 'pagination.defaultLimit': 10 },
          mountInfo: CONTAINER_MOUNT,
          container: true,
        }),
      (err) => err.status === 409 && /volume/i.test(err.detail),
    );
    assert.match(readFileSync(configFile, 'utf8'), /maxSourceBytes: 1048576/);
  });

  test('edits the file without disturbing the comments around it', () => {
    const result = applyServerConfig({
      config,
      configPath: configFile,
      patch: { 'pagination.defaultLimit': 25 },
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.deepEqual(result.changes['pagination.defaultLimit'], { before: 20, after: 25 });
    const written = readFileSync(configFile, 'utf8');
    assert.match(written, /^# Instance settings\./m);
    assert.match(written, /maxSourceBytes: 1048576/);
    assert.match(written, /defaultLimit: 25/);
  });

  test('applies a hot setting to the running config', () => {
    applyServerConfig({
      config,
      configPath: configFile,
      patch: { 'pagination.maxLimit': 120 },
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.equal(config.pagination.maxLimit, 120);
  });

  test('reports a setting that is already at that value as no change', () => {
    const result = applyServerConfig({
      config,
      configPath: configFile,
      patch: { 'pagination.defaultLimit': 20 },
      mountInfo: volumeMount(dirname(configFile)),
      container: true,
    });
    assert.deepEqual(result.changes, {});
  });

  test('rejects a value outside the allowed range without writing', () => {
    assert.throws(
      () =>
        applyServerConfig({
          config,
          configPath: configFile,
          patch: { 'pagination.maxLimit': 100000 },
          mountInfo: volumeMount(dirname(configFile)),
          container: true,
        }),
      (err) => err.status === 422 && err.errors[0].field === 'pagination.maxLimit',
    );
    assert.doesNotMatch(readFileSync(configFile, 'utf8'), /maxLimit/);
  });

  test('rejects a base URL that is not one', () => {
    assert.throws(
      () =>
        applyServerConfig({
          config,
          configPath: configFile,
          patch: { publicBaseUrl: 'not a url' },
          mountInfo: volumeMount(dirname(configFile)),
          container: true,
        }),
      (err) => err.status === 422 && err.errors[0].field === 'publicBaseUrl',
    );
  });

  test('collects every bad field rather than stopping at the first', () => {
    try {
      applyServerConfig({
        config,
        configPath: configFile,
        patch: { 'pagination.maxLimit': 0, 'compiler.memoryMb': 0 },
        mountInfo: volumeMount(dirname(configFile)),
        container: true,
      });
      assert.fail('expected a validation error');
    } catch (err) {
      assert.equal(err.status, 422);
      assert.deepEqual(err.errors.map((e) => e.field).sort(), [
        'compiler.memoryMb',
        'pagination.maxLimit',
      ]);
    }
  });
});

describe('editable settings', () => {
  test('never offers the settings that would stop the instance answering', () => {
    const keys = EDITABLE_SETTINGS.map((setting) => setting.key);
    for (const denied of ['database.url', 'apiRoot', 'port', 'dataDir', 'compiler.command']) {
      assert.ok(!keys.includes(denied), `${denied} must not be editable`);
    }
  });

  test('reports the current value of each setting', () => {
    const settings = editableSettings(config);
    const limit = settings.find((s) => s.key === 'limits.maxProfileImageBytes');
    assert.equal(limit.type, 'bytes');
    assert.equal(limit.min, 1024);
    // The harness boots without a limits block, so a setting the config never
    // set reads as unset rather than as a default the operator cannot see.
    assert.equal(limit.value, config.limits?.maxProfileImageBytes ?? null);

    const pageSize = settings.find((s) => s.key === 'pagination.maxLimit');
    assert.equal(pageSize.value, config.pagination.maxLimit);
  });

  test('describes every setting with a label and a type', () => {
    for (const setting of editableSettings(config)) {
      assert.ok(setting.label, `${setting.key} needs a label`);
      assert.ok(setting.type, `${setting.key} needs a type`);
      assert.equal(typeof setting.restartRequired, 'boolean');
    }
  });
});

describe('GET /admin/config', () => {
  test('refuses an unauthenticated caller', async () => {
    await request(app).get('/v1/admin/config').expect(401);
  });

  test('refuses an account that is not an admin', async () => {
    const account = await ordinary();
    await request(app).get('/v1/admin/config').set(bearer(account.token)).expect(403);
  });

  test('refuses an automation token', async () => {
    const account = await admin();
    const res = await request(app)
      .post('/v1/tokens')
      .set(bearer(account.token))
      .send({ name: 'ci', scopes: ['publish'] })
      .expect(201);
    await request(app).get('/v1/admin/config').set(bearer(res.body.token)).expect(403);
  });

  test('reports the settings and whether the file can hold a change', async () => {
    const account = await admin();
    const res = await request(app).get('/v1/admin/config').set(bearer(account.token)).expect(200);
    assert.equal(typeof res.body.editable, 'boolean');
    assert.equal(res.body.configPath, configFile);
    assert.ok(Array.isArray(res.body.settings));
    assert.ok(res.body.settings.length > 0);
    // Whatever the host looks like, the body must not carry the connection
    // details that the file also holds.
    assert.doesNotMatch(JSON.stringify(res.body), /postgres:\/\//);
  });
});

describe('PUT /admin/config', () => {
  test('refuses an account that is not an admin', async () => {
    const account = await ordinary();
    await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: { 'pagination.maxLimit': 60 } })
      .expect(403);
  });

  test('writes the setting to the file and reports the change', async () => {
    const account = await admin();
    const res = await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: { 'pagination.maxLimit': 60 } })
      .expect(200);
    assert.deepEqual(res.body.changed['pagination.maxLimit'], { before: 50, after: 60 });
    assert.deepEqual(res.body.restartRequired, []);
  });

  test('refuses a setting the interface does not offer, by name', async () => {
    const account = await admin();
    const res = await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: { 'database.url': 'postgres://elsewhere/db' } })
      .expect(422);
    assert.equal(res.body.errors[0].field, 'database.url');
    assert.equal(config.database.url.includes('elsewhere'), false);
  });

  test('rejects a body that is not a settings object', async () => {
    const account = await admin();
    await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: 'pagination.maxLimit=60' })
      .expect(422);
  });

  test('writes an audit row naming the settings that changed', async () => {
    const account = await admin();
    await request(app)
      .put('/v1/admin/config')
      .set(bearer(account.token))
      .send({ settings: { 'pagination.maxLimit': 60 } })
      .expect(200);

    let row;
    for (let attempt = 0; attempt < 40 && !row; attempt += 1) {
      [row] = await sql`
        SELECT action, detail FROM audit_log WHERE action = 'config.update'
      `;
      if (!row) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(row, 'expected a config.update audit row');
    assert.equal(row.detail.changed['pagination.maxLimit'].after, 60);
  });
});
