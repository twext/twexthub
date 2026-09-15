import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(moduleDir, '..', 'migrations');

export function createDb(config) {
  const sql = postgres(config.database.url, {
    max: config.database.maxConnections,
    onnotice: () => {},
  });
  return sql;
}

export async function runMigrations(sql, migrationsDir = MIGRATIONS_DIR) {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();

  const appliedRows = await sql`SELECT version FROM schema_migrations`;
  const applied = new Set(appliedRows.map((row) => row.version));

  for (const file of files) {
    if (applied.has(file)) continue;
    const body = readFileSync(path.join(migrationsDir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
    });
  }
}

export async function seedLegalDocuments(sql) {
  await sql`
    INSERT INTO legal_documents (kind, version, body)
    VALUES ('terms', 1, 'Placeholder terms of service.'),
           ('privacy', 1, 'Placeholder privacy policy.')
    ON CONFLICT (kind) DO NOTHING
  `;
}

export async function reconcileOnBoot(sql, dataDir) {
  const staging = await sql`SELECT * FROM versions WHERE status = 'staging'`;
  for (const row of staging) {
    const blobAbs = path.join(dataDir, row.blob_path);
    if (existsSync(blobAbs)) {
      const [owner] = await sql`SELECT has_published FROM users WHERE id = ${row.owner_id}`;
      const status = owner?.has_published ? 'published' : 'pending';
      await sql`
        UPDATE versions
        SET status = ${status}, published_at = ${status === 'published' ? new Date() : null}
        WHERE id = ${row.id}
      `;
      console.log(
        `reconciled staging version ${row.namespace}/${row.extension_id}@${row.version} -> ${status}`,
      );
    } else {
      await sql`DELETE FROM versions WHERE id = ${row.id}`;
      console.log(
        `removed staging version ${row.namespace}/${row.extension_id}@${row.version} (blob missing)`,
      );
    }
  }

  const tmpDir = path.join(dataDir, 'tmp');
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
}

export function ensureDataDirs(dataDir) {
  mkdirSync(path.join(dataDir, 'blobs'), { recursive: true });
  mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
}
