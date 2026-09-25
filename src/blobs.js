import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat, unlink, utimes } from 'node:fs/promises';
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
    // Identical bytes already on disk; drop the upload. The mtime refresh keeps
    // the reuse window open against gcBlobs, which skips files under an hour
    // old, and covers the gap where the file disappears mid-publish.
    try {
      const now = new Date();
      await utimes(abs, now, now);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await copyFile(tmpPath, abs);
    }
  } else {
    await copyFile(tmpPath, abs);
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
