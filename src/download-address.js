import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Set this to manage the key yourself (Kubernetes secret, config management);
// it is read once per process.
const KEY_ENV = 'TWEXTHUB_DOWNLOAD_HASH_KEY';

const resolved = new Map();

function keyFile(dataDir) {
  return path.join(dataDir, 'secrets', 'download-address.key');
}

// A download address is hashed so the registry can count distinct clients
// without keeping the address, and that hash is worth nothing if the key sits
// next to it: one database dump would undo the whole point. The key therefore
// lives on disk, or wherever the operator keeps secrets, and never in a table.
export async function downloadAddressKey(sql, config) {
  const cached = resolved.get(config.dataDir);
  if (cached) return cached;

  const fromEnv = process.env[KEY_ENV];
  if (fromEnv) {
    resolved.set(config.dataDir, fromEnv);
    return fromEnv;
  }

  const file = keyFile(config.dataDir);
  let secret;
  try {
    secret = readFileSync(file, 'utf8').trim();
  } catch {
    secret = randomBytes(32).toString('base64url');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${secret}\n`, { mode: 0o600 });
    // Losing the key leaves hashes that cannot be compared with new ones, so
    // the rows that used it are cleared. The rollup still counts them; their
    // distinct counts fall back to the user agent.
    const stale = await sql`
      UPDATE download_events SET ip_hash = NULL WHERE ip_hash IS NOT NULL
    `;
    if (stale.count > 0) {
      console.log(`generated a new download address key; cleared ${stale.count} stale hashes`);
    }
  }

  resolved.set(config.dataDir, secret);
  return secret;
}
