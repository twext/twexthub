import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(moduleDir, '..', 'migrations');

export function createDb(config) {
  const sql = postgres(config.database.url, {
    max: config.database.maxConnections,
    connect_timeout: config.database.connectTimeoutSeconds,
    idle_timeout: config.database.idleTimeoutSeconds,
    onnotice: () => {},
  });
  return sql;
}

export async function runMigrations(sql, migrationsDir = MIGRATIONS_DIR) {
  const files = readdirSync(migrationsDir)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(32001)`;

    await tx.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const appliedRows = await tx`SELECT version FROM schema_migrations`;
    const applied = new Set(appliedRows.map((row) => row.version));

    for (const file of files) {
      if (applied.has(file)) continue;
      const body = readFileSync(path.join(migrationsDir, file), 'utf8');
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    }
  });
}

export async function reconcileOnBoot(sql, config) {
  const dataDir = config.dataDir;
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(32002)`;
    const staging = await tx`
      SELECT * FROM versions
      WHERE status = 'staging' AND created_at < now() - interval '1 hour'
    `;
    for (const row of staging) {
      const blobAbs = path.join(dataDir, row.blob_path);
      if (existsSync(blobAbs)) {
        const [owner] = await tx`SELECT has_published FROM users WHERE id = ${row.owner_id}`;
        const status = owner?.has_published ? 'published' : 'pending';
        await tx`
          UPDATE versions
          SET status = ${status}, published_at = ${status === 'published' ? new Date() : null}
          WHERE id = ${row.id}
        `;
        console.log(
          `reconciled staging version ${row.namespace}/${row.extension_id}@${row.version} -> ${status}`,
        );
      } else {
        await tx`DELETE FROM versions WHERE id = ${row.id}`;
        console.log(
          `removed staging version ${row.namespace}/${row.extension_id}@${row.version} (blob missing)`,
        );
      }
    }
  });

  const tmpDir = path.join(dataDir, 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const cutoff = Date.now() - 3600_000;
  for (const entry of readdirSync(tmpDir)) {
    const entryPath = path.join(tmpDir, entry);
    try {
      const st = statSync(entryPath);
      if (st.isFile() && st.mtimeMs < cutoff) unlinkSync(entryPath);
    } catch {
      // another process may have already removed it
    }
  }

  const quarantineDir = path.join(dataDir, 'quarantine');
  for (const entry of readdirSync(quarantineDir, { withFileTypes: true })) {
    const entryPath = path.join(quarantineDir, entry.name);
    try {
      const st = statSync(entryPath);
      if (st.isDirectory() && st.mtimeMs < cutoff) {
        rmSync(entryPath, { recursive: true, force: true });
      }
    } catch {
      // another process may have already removed it
    }
  }

  const maxWindow = Math.max(
    config.rateLimits.loginWindowMinutes,
    config.rateLimits.signupWindowMinutes,
  );
  const rateCutoff = new Date(Date.now() - maxWindow * 60_000);
  await sql`DELETE FROM rate_limit_entries WHERE window_start < ${rateCutoff}`;

  await sql`DELETE FROM sessions WHERE expires_at < now()`;
}

export function ensureDataDirs(dataDir) {
  mkdirSync(path.join(dataDir, 'blobs'), { recursive: true });
  mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
  mkdirSync(path.join(dataDir, 'quarantine'), { recursive: true });
}
