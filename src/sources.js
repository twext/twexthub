import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256Hex } from './blobs.js';

// Sources are keyed by digest just like blobs, so identical tarballs share one
// file. Addressed as sources/<first two hex chars>/<rest> for fan-out.
export function sourcePathFor(dataDir, digest) {
  return path.join(dataDir, 'sources', digest.slice(0, 2), digest.slice(2));
}

export async function storeSource(dataDir, buffer) {
  const digest = sha256Hex(buffer);
  const abs = sourcePathFor(dataDir, digest);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, buffer);
  return { path: path.relative(dataDir, abs), digest, size: buffer.length };
}

export async function removeSourceIfUnused(sql, config, digest) {
  if (!digest) return;
  const [keeper] = await sql`
    SELECT 1 FROM versions WHERE source_digest = ${digest} LIMIT 1
  `;
  if (keeper) return;
  try {
    await unlink(sourcePathFor(config.dataDir, digest));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
