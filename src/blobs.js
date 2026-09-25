import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha512Base64(buffer) {
  return createHash('sha512').update(buffer).digest('base64');
}

export function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(abs);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// Blobs are keyed by digest so identical publishes share one file on disk.
// The digest is addressed as blobs/<first two hex chars>/<rest> to keep
// directory fan-out low.
export function blobPathFor(dataDir, digest) {
  return path.join(dataDir, 'blobs', digest.slice(0, 2), digest.slice(2));
}

async function readSize(abs) {
  try {
    return Number((await stat(abs)).size);
  } catch {
    return null;
  }
}

export async function storeBlob(dataDir, tmpPath, buffer) {
  const digest = sha256Hex(buffer);
  const abs = blobPathFor(dataDir, digest);
  await mkdir(path.dirname(abs), { recursive: true });
  const existing = await readSize(abs);
  if (existing === buffer.length) {
    try {
      if ((await hashFile(abs)) === digest) {
        // Refresh the reuse window against gcBlobs, which skips recent files.
        const now = new Date();
        await utimes(abs, now, now);
        return { digest, abs, size: buffer.length, sha512: sha512Base64(buffer) };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const staged = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomUUID()}.tmp`);
  try {
    await copyFile(tmpPath, staged);
    await rename(staged, abs);
  } finally {
    await rm(staged, { force: true });
  }
  return { digest, abs, size: buffer.length, sha512: sha512Base64(buffer) };
}

export async function removeBlobIfUnused(sql, config, digest, exceptId) {
  if (!digest) return;
  const [keeper] = await sql`
    SELECT 1 FROM versions
    WHERE blob_digest = ${digest} AND id != ${exceptId}
    LIMIT 1
  `;
  if (keeper) return;
  try {
    await unlink(blobPathFor(config.dataDir, digest));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
