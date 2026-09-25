import { readdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { blobPathFor, sha256Hex } from './blobs.js';

// Blob garbage collection: a file under blobs/ whose digest no version row
// references is deleted. Sources are handled by removeSourceIfUnused at the
// call sites that already know the digest; this sweep only covers blobs so a
// crash between the DB delete and the file removal cannot strand bytes.
export async function gcBlobs(sql, dataDir) {
  const blobsDir = path.join(dataDir, 'blobs');
  const known = await sql`SELECT DISTINCT blob_digest FROM versions WHERE blob_digest IS NOT NULL`;
  const referenced = new Set(known.map((row) => row.blob_digest));

  let removed = 0;
  for (const prefix of await readdir(blobsDir)) {
    const prefixDir = path.join(blobsDir, prefix);
    for (const rest of await readdir(prefixDir)) {
      const digest = prefix + rest;
      if (referenced.has(digest)) continue;
      await unlink(path.join(prefixDir, rest)).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

// Verify every referenced blob against its stored digest. Missing or
// mismatched files are reported, not deleted: the database row is the source
// of truth for what should exist, so the operator decides what to do.
// Registered integrity failures are exported through
// twexthub_storage_integrity_errors.
let integrityErrorCount = 0;

export function getIntegrityErrors() {
  return integrityErrorCount;
}

export async function scrubBlobs(sql, dataDir) {
  const rows = await sql`
    SELECT DISTINCT ON (blob_digest) namespace, extension_id, version, blob_digest
    FROM versions
    WHERE blob_digest IS NOT NULL AND status <> 'staging'
    ORDER BY blob_digest, id DESC
  `;

  integrityErrorCount = 0;
  const problems = [];
  for (const row of rows) {
    const abs = blobPathFor(dataDir, row.blob_digest);
    let actual;
    try {
      actual = sha256Hex(await readFile(abs));
    } catch {
      integrityErrorCount += 1;
      problems.push({ ...row, problem: 'missing' });
      continue;
    }
    if (actual !== row.blob_digest) {
      integrityErrorCount = integrityErrorCount + 1;
      problems.push({ ...row, problem: 'mismatch' });
    }
  }
  return problems;
}

export function makeMaintenanceJob({ sql, config }) {
  let timer = null;
  let running = false;

  const gcIntervalMs = 6 * 60 * 60 * 1000;
  const scrubIntervalMs = 24 * 60 * 60 * 1000;
  let lastScrub = 0;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const removed = await gcBlobs(sql, config.dataDir);
      if (removed > 0) console.log(`blob gc removed ${removed} orphaned file(s)`);

      if (Date.now() - lastScrub >= scrubIntervalMs) {
        lastScrub = Date.now();
        const problems = await scrubBlobs(sql, config.dataDir);
        for (const problem of problems) {
          console.warn(
            `blob integrity ${problem.problem}: ${problem.namespace}/${problem.extension_id}@${problem.version}`,
          );
        }
      }
    } catch (error) {
      console.error('maintenance job failed:', error.message);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      timer = setInterval(tick, gcIntervalMs);
      timer.unref?.();
      return this;
    },
    async stop() {
      if (timer) clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    },
    // Convenience for tests and tooling: run one pass immediately.
    async runOnce() {
      await tick();
    },
  };
}
