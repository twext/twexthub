import { stat, unlink } from 'node:fs/promises';
import { sniffImageType, supportedImageTypes } from './image-sniff.js';
import { BLOB_GC_LOCK_KEY, blobPathFor, storeBlobBuffer } from './blobs.js';
import { payloadTooLarge, unsupportedMediaType } from './errors.js';

// The body parser is built once, when the routes are wired, so it cannot read
// the configured limit the way validateProfileImage does. It accepts up to this
// ceiling and the configured limit is enforced per request, which is what keeps
// limits.maxProfileImageBytes hot. The ceiling is the hard cap: a configured or
// per-kind limit above it is unreachable, because this is the largest body the
// route will read.
export const MAX_PROFILE_IMAGE_BYTES = 16 * 1024 * 1024;

// Which images an account can upload, and how each maps to the columns and the
// serving path. Keeping both in one table means adding a third image later
// cannot half-work in the upload route and the serving route.
export const PROFILE_IMAGES = {
  avatar: {
    digestColumn: 'avatar_blob_digest',
    typeColumn: 'avatar_content_type',
    bytesColumn: 'avatar_bytes',
    // Avatars are small and render on every listing, so the ceiling is tighter
    // than a banner's. Both default from limits.maxProfileImageBytes when the
    // operator has not overridden them.
    maxBytes: 'maxAvatarBytes',
  },
  banner: {
    digestColumn: 'banner_blob_digest',
    typeColumn: 'banner_content_type',
    bytesColumn: 'banner_bytes',
    maxBytes: 'maxBannerBytes',
  },
};

function limitFor(config, kind) {
  const key = PROFILE_IMAGES[kind].maxBytes;
  return config.limits?.[key] ?? config.limits?.maxProfileImageBytes ?? 2 * 1024 * 1024;
}

/**
 * Validates an uploaded profile image and returns the metadata to store, or
 * throws. `declaredType` is what the caller sent as Content-Type; it is only
 * used to reject a mismatch, never to decide what the bytes are.
 */
export function validateProfileImage(config, kind, buffer, declaredType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw payloadTooLarge('Image body is empty.');
  }
  const max = limitFor(config, kind);
  if (buffer.length > max) {
    throw payloadTooLarge(
      `Image is larger than the ${Math.floor(max / 1024)} KiB limit for this field.`,
    );
  }
  const sniffed = sniffImageType(buffer);
  if (!sniffed) {
    throw unsupportedMediaType(
      `Unsupported image type. Upload a PNG, JPEG, GIF, WebP, or AVIF file (${supportedImageTypes().join(', ')}).`,
    );
  }
  // A client that labels a real PNG as a JPEG has a bug; a client that labels
  // arbitrary bytes as a PNG is an attack. Rejecting only the mismatched
  // labels is what makes the sniff authoritative.
  const declared = String(declaredType ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (declared && declared !== 'application/octet-stream' && declared !== sniffed) {
    throw unsupportedMediaType(
      `Image content type ${declared} does not match the uploaded data, which is ${sniffed}.`,
    );
  }
  return { contentType: sniffed, size: buffer.length };
}

/**
 * Stores the image and points the account's column at it, in one transaction.
 *
 * The blob lands on disk before the row that references it, which is the same
 * order publish uses, and the shared lock keeps the collector from unlinking
 * the file between the two statements.
 */
export async function storeProfileImage(sql, config, user, kind, buffer, declaredType) {
  const { contentType, size } = validateProfileImage(config, kind, buffer, declaredType);
  const columns = PROFILE_IMAGES[kind];
  const previous = user[columns.digestColumn] ?? null;
  const { digest } = await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock_shared(hashtextextended(${BLOB_GC_LOCK_KEY}, 0))`;
    const stored = await storeBlobBuffer(config.dataDir, buffer);
    // The external reference is left alone. An account can hold a URL and an
    // upload at once; the upload is what a visitor sees, and the URL is what
    // comes back if the upload is removed, so neither write has to destroy the
    // other. It is also the only copy the instance controls, and dropping it
    // because someone picked a file would silently discard it.
    await tx`
      UPDATE users
      SET ${tx(columns.digestColumn)} = ${stored.digest},
          ${tx(columns.typeColumn)} = ${contentType},
          ${tx(columns.bytesColumn)} = ${size}
      WHERE id = ${user.id}
    `;
    return stored;
  });
  return { digest, contentType, size, previous };
}

/**
 * Resolves a stored image to an on-disk path and metadata, or null when the
 * account has no upload for this kind. A row that points at a digest whose
 * file has gone missing reads as "no upload" so the caller can fall back
 * rather than 500.
 */
export async function resolveProfileImage(config, user, kind) {
  const columns = PROFILE_IMAGES[kind];
  const digest = user[columns.digestColumn];
  if (!digest) return null;
  const abs = blobPathFor(config.dataDir, digest);
  let size;
  try {
    size = (await stat(abs)).size;
  } catch {
    return null;
  }
  return {
    abs,
    digest,
    size,
    contentType: user[columns.typeColumn] ?? 'application/octet-stream',
    expectedSize: user[columns.bytesColumn] ?? null,
  };
}

/**
 * Clears the account's pointer to an uploaded image and returns the digest that
 * may now be collectable. The row update is committed by the caller; this only
 * computes what to do afterwards.
 */
export function profileImagePointer(user, kind) {
  const columns = PROFILE_IMAGES[kind];
  return {
    digest: user[columns.digestColumn] ?? null,
    updates: {
      [columns.digestColumn]: null,
      [columns.typeColumn]: null,
      [columns.bytesColumn]: null,
    },
  };
}

/**
 * Unlinks a profile image's bytes once nothing points at them.
 *
 * The blob store is shared with version uploads and is content-addressed, so a
 * digest can be referenced by a version row, by an account's avatar, by that
 * same account's banner, or by all of them. removeBlobIfUnused only knows about
 * versions, so this check spans every table that can name a digest before
 * deleting anything.
 *
 * Callers run this after the pointer update has committed, so the account that
 * just dropped its avatar no longer names those bytes in that column. Excluding
 * its row would also hide the other column on the same account, which is how an
 * avatar and a banner that share bytes would end up with the file unlinked under
 * the banner.
 */
export async function removeProfileImageBlob(sql, config, digest) {
  if (!digest) return false;
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${BLOB_GC_LOCK_KEY}, 0))`;
    const [version] = await tx`
      SELECT 1 FROM versions WHERE blob_digest = ${digest} LIMIT 1
    `;
    if (version) return false;
    const [user] = await tx`
      SELECT 1 FROM users
      WHERE avatar_blob_digest = ${digest} OR banner_blob_digest = ${digest}
      LIMIT 1
    `;
    if (user) return false;
    try {
      await unlink(blobPathFor(config.dataDir, digest));
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

/**
 * Queues the UPDATE fragment that drops a kind's upload pointer, and returns the
 * digest it freed so the caller can release the bytes after the row commits.
 *
 * A no-op when the account has no upload, so a request that never touched an
 * upload does not write three NULL columns for nothing.
 */
export function clearProfileImagePointer(patch, columns, user, kind) {
  const image = PROFILE_IMAGES[kind];
  const digest = user[image.digestColumn];
  if (!digest) return [];
  patch[image.digestColumn] = null;
  columns.push(image.digestColumn);
  patch[image.typeColumn] = null;
  columns.push(image.typeColumn);
  patch[image.bytesColumn] = null;
  columns.push(image.bytesColumn);
  return [digest];
}
