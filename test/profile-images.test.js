import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm, utimes } from 'node:fs/promises';
import request from 'supertest';
import { blobPathFor } from '../src/blobs.js';
import { gcBlobs } from '../src/maintenance.js';
import { sniffImageType, supportedImageTypes } from '../src/image-sniff.js';
import { boot, bearer, resetDb, signupAndAccept, uniqNs } from './helpers.mjs';

// Real signature bytes rather than a fixture file: the endpoints sniff the
// upload, so a test that sent a placeholder string would exercise the rejection
// path and pass for the wrong reason.
function pngBytes(extra = 0) {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR'),
    Buffer.alloc(13),
    Buffer.alloc(extra, 0x5a),
  ]);
}

const gifBytes = () => Buffer.from('GIF89a\0\0\0\0\0\0\0\0', 'latin1');
const jpegBytes = () =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0,
    16,
    ...Buffer.from('JFIF\0'),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);

let app;
let sql;
let config;

before(async () => {
  ({ app, sql, config } = await boot({
    // A small ceiling keeps the over-limit case cheap. The other keys are
    // repeated because the override replaces the whole limits object.
    limits: {
      maxBlobBytes: 2 * 1024 * 1024,
      maxAccountBlobBytes: 64 * 1024 * 1024,
      maxSourceBytes: 1024 * 1024,
      maxProfileImageBytes: 4096,
    },
  }));
});
beforeEach(resetDb);
after(async () => {
  await sql.end();
});

const tokens = new Map();

async function account() {
  const ns = uniqNs();
  const res = await signupAndAccept(app, ns);
  tokens.set(ns, res.token);
  return ns;
}

const put = (ns, kind, body, type) =>
  request(app)
    .put(`/v1/users/${ns}/${kind}`)
    .set(bearer(tokens.get(ns)))
    .set('Content-Type', type)
    .send(body);

const avatarDigest = (ns) => sql`SELECT avatar_blob_digest FROM users WHERE namespace = ${ns}`;

// The published URL names the exact bytes, so it carries a short version token
// taken from the content digest. Reading it back from the row keeps a test from
// having to re-derive the hash.
// supertest needs the path the API is mounted on, not the absolute URL a reader
// would follow, so the published URL is trimmed back to that.
const asPath = (url) => url.replace(config.publicBaseUrl, '');

const versioned = async (ns, kind) => {
  const column = kind === 'avatar' ? 'avatar_blob_digest' : 'banner_blob_digest';
  const [row] = await sql`SELECT ${sql(column)} AS digest FROM users WHERE namespace = ${ns}`;
  assert.ok(row.digest, `expected ${ns} to have a ${kind} upload`);
  return `${config.publicBaseUrl}/v1/users/${ns}/${kind}?v=${row.digest.slice(0, 16)}`;
};

describe('sniffImageType', () => {
  test('recognises a format from its signature bytes', () => {
    assert.equal(sniffImageType(pngBytes()), 'image/png');
    assert.equal(sniffImageType(gifBytes()), 'image/gif');
    assert.equal(sniffImageType(jpegBytes()), 'image/jpeg');
  });

  test('rejects SVG, which would execute script in the serving origin', () => {
    assert.equal(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
    assert.ok(!supportedImageTypes().includes('image/svg+xml'));
  });

  test('rejects non-images and truncated headers', () => {
    assert.equal(sniffImageType(Buffer.from('GIF87a')), null);
    assert.equal(sniffImageType(Buffer.from('<?php system($_GET[0]); ?>')), null);
    assert.equal(sniffImageType(Buffer.alloc(0)), null);
  });
});

describe('uploading a profile image', () => {
  test('stores the bytes and reports the canonical URL', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', pngBytes(), 'image/png');
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));

    const [row] = await sql`SELECT * FROM users WHERE namespace = ${ns}`;
    assert.match(row.avatar_blob_digest, /^[0-9a-f]{64}$/);
    assert.equal(row.avatar_content_type, 'image/png');
    assert.equal(row.avatar_bytes, 29);
    assert.ok(existsSync(blobPathFor(config.dataDir, row.avatar_blob_digest)));
  });

  test('stores a banner', async () => {
    const ns = await account();
    const res = await put(ns, 'banner', pngBytes(), 'image/png');
    assert.equal(res.status, 200);
    assert.equal(res.body.bannerUrl, await versioned(ns, 'banner'));
  });

  test('deduplicates identical uploads across accounts', async () => {
    const a = await account();
    const b = await account();
    const bytes = pngBytes();
    await put(a, 'avatar', bytes, 'image/png');
    await put(b, 'avatar', bytes, 'image/png');
    const [ra] = await avatarDigest(a);
    const [rb] = await avatarDigest(b);
    assert.equal(ra.avatar_blob_digest, rb.avatar_blob_digest);
  });

  test('keeps an external reference, which the upload then shadows', async () => {
    const ns = await account();
    await request(app)
      .patch(`/v1/users/${ns}`)
      .set(bearer(tokens.get(ns)))
      .send({ avatarUrl: 'https://cdn.example/old.png' })
      .expect(200);

    const res = await put(ns, 'avatar', pngBytes(), 'image/png');

    const [row] =
      await sql`SELECT avatar_url, avatar_blob_digest FROM users WHERE namespace = ${ns}`;
    assert.equal(row.avatar_url, 'https://cdn.example/old.png');
    assert.ok(row.avatar_blob_digest);
    // The upload is what a visitor is shown, not the linked file.
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));
    const served = await request(app).get(`/v1/users/${ns}/avatar`);
    assert.equal(served.status, 200);
    assert.equal(served.headers['content-type'], 'image/png');
  });
});

describe('upload validation', () => {
  test('rejects a non-image body declared as an image', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', 'not an image at all', 'image/png');
    assert.equal(res.status, 415);
  });

  test('rejects an SVG', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', Buffer.from('<svg onload="alert(1)"/>'), 'image/svg+xml');
    assert.equal(res.status, 415);
  });

  test('rejects a declared type that disagrees with the bytes', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', pngBytes(), 'image/jpeg');
    assert.equal(res.status, 415);
    assert.match(res.body.detail, /does not match/i);
  });

  test('accepts a generic content type and trusts the bytes', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', gifBytes(), 'application/octet-stream');
    assert.equal(res.status, 200);
  });

  test('ignores a charset parameter on the content type', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', pngBytes(), 'image/png; charset=binary');
    assert.equal(res.status, 200);
  });

  test('rejects an empty body', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', Buffer.alloc(0), 'image/png');
    assert.equal(res.status, 413);
  });

  test('rejects an image over the configured limit', async () => {
    const ns = await account();
    const res = await put(ns, 'avatar', pngBytes(config.limits.maxProfileImageBytes), 'image/png');
    assert.equal(res.status, 413);
  });

  // The body parser is built when the routes are wired, so with the configured
  // limit baked into it a change on the running instance would not reach the next
  // upload: the parser reads up to the ceiling and the live limit is applied to
  // what arrives. Both directions have to hold, so neither a lower limit that
  // still lets bytes through nor a higher one the parser would refuse can pass.
  test('applies a limit changed on the running instance', async () => {
    const ns = await account();
    const before = config.limits.maxProfileImageBytes;
    try {
      config.limits.maxProfileImageBytes = 64;
      const tooBig = await put(ns, 'avatar', pngBytes(2000), 'image/png');
      assert.equal(tooBig.status, 413);
      // The rejection names the setting rather than the parser's ceiling, which
      // is what says the live value was the one consulted.
      assert.match(tooBig.body.detail, /limit for this field/);

      // Above the 4 KiB this suite booted with, so a parser still holding that
      // value would refuse the body instead of storing it.
      config.limits.maxProfileImageBytes = 8192;
      assert.equal((await put(ns, 'avatar', pngBytes(5000), 'image/png')).status, 200);
    } finally {
      config.limits.maxProfileImageBytes = before;
    }
  });
});

describe('upload authorization', () => {
  test('requires a session', async () => {
    const ns = await account();
    const res = await request(app)
      .put(`/v1/users/${ns}/avatar`)
      .set('Content-Type', 'image/png')
      .send(pngBytes());
    assert.equal(res.status, 401);
  });

  test('refuses another account, including for an admin', async () => {
    // The first account on a fresh database is the bootstrapped admin, so it has
    // to be created first for this to be testing the admin path.
    const adminRes = await signupAndAccept(app, uniqNs());
    const [adminRow] =
      await sql`SELECT role FROM users WHERE namespace = ${adminRes.user.namespace}`;
    assert.equal(adminRow.role, 'admin');

    const owner = await account();
    const res = await request(app)
      .put(`/v1/users/${owner}/avatar`)
      .set(bearer(adminRes.token))
      .set('Content-Type', 'image/png')
      .send(pngBytes());
    assert.equal(res.status, 403);
  });
});

describe('serving profile images', () => {
  test('streams the uploaded bytes back', async () => {
    const ns = await account();
    const bytes = pngBytes();
    await put(ns, 'avatar', bytes, 'image/png');

    const res = await request(app).get(`/v1/users/${ns}/avatar`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /image\/png/);
    assert.equal(Buffer.compare(res.body, bytes), 0);
  });

  // The upload is served from the API origin, and the validator reads the
  // leading signature only, so the response has to forbid content sniffing.
  test('sends nosniff with the bytes', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');

    const res = await request(app).get(`/v1/users/${ns}/avatar`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  // The two paths have to be cached differently, because only one of them names
  // the bytes it serves. Caching the bare path hard is how a re-upload keeps
  // showing the old picture for a year.
  test('caches the versioned URL immutably, because it names the bytes', async () => {
    const ns = await account();
    const upload = await put(ns, 'avatar', pngBytes(), 'image/png');
    const res = await request(app).get(asPath(upload.body.avatarUrl));
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  test('makes the bare path revalidate, and answers a match with 304', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const res = await request(app).get(`/v1/users/${ns}/avatar`);
    assert.equal(res.headers['cache-control'], 'public, max-age=0, must-revalidate');
    const etag = res.headers.etag;
    assert.match(etag, /^"[0-9a-f]{64}"$/);

    const revalidated = await request(app).get(`/v1/users/${ns}/avatar`).set('If-None-Match', etag);
    assert.equal(revalidated.status, 304);
  });

  test('gives a reader a new version after a replacement', async () => {
    const ns = await account();
    const first = await put(ns, 'avatar', pngBytes(1), 'image/png');
    const replacement = await put(ns, 'avatar', pngBytes(2), 'image/png');
    assert.notEqual(first.body.avatarUrl, replacement.body.avatarUrl);
  });

  test('sends a reader holding a stale version to the current one', async () => {
    const ns = await account();
    const upload = await put(ns, 'avatar', pngBytes(1), 'image/png');
    const stale = new URL(upload.body.avatarUrl).searchParams.get('v');
    await put(ns, 'avatar', pngBytes(2), 'image/png');

    const res = await request(app).get(`/v1/users/${ns}/avatar?v=${stale}`);
    assert.equal(res.status, 302);
    assert.notEqual(
      new URL(res.headers.location, config.publicBaseUrl).searchParams.get('v'),
      stale,
    );

    const followed = await request(app).get(res.headers.location.replace(config.publicBaseUrl, ''));
    assert.equal(followed.status, 200);
  });

  test('serves a replacement under the same URL', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(1), 'image/png');
    const first = await request(app).get(`/v1/users/${ns}/avatar`);
    await put(ns, 'avatar', pngBytes(2), 'image/png');
    const second = await request(app).get(`/v1/users/${ns}/avatar`);
    assert.notEqual(Buffer.compare(first.body, second.body), 0);
  });

  test('still redirects to an external reference when no upload exists', async () => {
    const ns = await account();
    await request(app)
      .patch(`/v1/users/${ns}`)
      .set(bearer(tokens.get(ns)))
      .send({ bannerUrl: 'https://cdn.example/banner.png' })
      .expect(200);
    const res = await request(app).get(`/v1/users/${ns}/banner`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, 'https://cdn.example/banner.png');
  });

  test('falls back to the identicon when an avatar has neither', async () => {
    const ns = await account();
    const res = await request(app).get(`/v1/users/${ns}/avatar`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /svg/);
  });

  test('404s a banner that was never set', async () => {
    const ns = await account();
    const res = await request(app).get(`/v1/users/${ns}/banner`);
    assert.equal(res.status, 404);
  });

  test('falls back instead of 500ing when the stored file has gone missing', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    await rm(blobPathFor(config.dataDir, row.avatar_blob_digest), { force: true });

    const res = await request(app).get(`/v1/users/${ns}/avatar`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /svg/);
  });

  test('404s an unknown namespace', async () => {
    const res = await request(app).get('/v1/users/nope-nope/avatar');
    assert.equal(res.status, 404);
  });
});

describe('removing a profile image', () => {
  test('reverts to the identicon and frees the bytes', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    const res = await request(app)
      .delete(`/v1/users/${ns}/avatar`)
      .set(bearer(tokens.get(ns)));
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, null);
    assert.ok(!existsSync(stored));
  });

  test('leaves an external reference in place behind the upload', async () => {
    const ns = await account();
    await request(app)
      .patch(`/v1/users/${ns}`)
      .set(bearer(tokens.get(ns)))
      .send({ avatarUrl: 'https://cdn.example/a.png' })
      .expect(200);

    const res = await request(app)
      .delete(`/v1/users/${ns}/avatar`)
      .set(bearer(tokens.get(ns)));
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, 'https://cdn.example/a.png');
  });

  test('refuses another account', async () => {
    const owner = await account();
    const other = await account();
    const res = await request(app)
      .delete(`/v1/users/${owner}/avatar`)
      .set(bearer(tokens.get(other)));
    assert.equal(res.status, 403);
  });

  // The blob is content-addressed, so an avatar and a banner holding the same
  // bytes are one file on disk. Dropping one of them has to leave the other
  // serving, which means the release cannot skip the account it just wrote.
  test('keeps the bytes the account still points at with its other image', async () => {
    const ns = await account();
    const shared = pngBytes(5);
    await put(ns, 'avatar', shared, 'image/png');
    await put(ns, 'banner', shared, 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    await request(app)
      .delete(`/v1/users/${ns}/avatar`)
      .set(bearer(tokens.get(ns)))
      .expect(200);

    assert.ok(existsSync(stored));
    const served = await request(app).get(`/v1/users/${ns}/banner`);
    assert.equal(served.status, 200);
    assert.equal(Buffer.compare(served.body, shared), 0);
  });

  test('keeps the bytes a replacement shares with the account other image', async () => {
    const ns = await account();
    const shared = pngBytes(5);
    await put(ns, 'avatar', shared, 'image/png');
    await put(ns, 'banner', shared, 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    // Replacing the avatar releases the digest it used to name, and the banner
    // still names it.
    const replacement = await put(ns, 'avatar', pngBytes(7), 'image/png');
    assert.equal(replacement.status, 200);
    assert.ok(existsSync(stored));
    const served = await request(app).get(`/v1/users/${ns}/banner`);
    assert.equal(Buffer.compare(served.body, shared), 0);
  });

  test('frees the bytes once neither image names them', async () => {
    const ns = await account();
    const shared = pngBytes(5);
    await put(ns, 'avatar', shared, 'image/png');
    await put(ns, 'banner', shared, 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    const del = (kind) =>
      request(app)
        .delete(`/v1/users/${ns}/${kind}`)
        .set(bearer(tokens.get(ns)))
        .expect(200);
    await del('avatar');
    assert.ok(existsSync(stored));
    await del('banner');
    assert.ok(!existsSync(stored));
  });
});

describe('swapping one image source for another', () => {
  test('releases the replaced upload', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(4), 'image/png');
    const [row] = await avatarDigest(ns);
    const first = blobPathFor(config.dataDir, row.avatar_blob_digest);

    await put(ns, 'avatar', pngBytes(8), 'image/png');
    assert.ok(!existsSync(first));
  });

  test('keeps the upload when PATCH installs an external URL', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    const res = await request(app)
      .patch(`/v1/users/${ns}`)
      .set(bearer(tokens.get(ns)))
      .send({ avatarUrl: 'https://cdn.example/new.png' })
      .expect(200);

    assert.ok(existsSync(stored));
    // The upload is still what the profile reports, so the URL only takes over
    // once the upload is removed.
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));
  });

  test('falls back to the URL once the upload is removed', async () => {
    const ns = await account();
    await request(app)
      .patch(`/v1/users/${ns}`)
      .set(bearer(tokens.get(ns)))
      .send({ avatarUrl: 'https://cdn.example/fallback.png' })
      .expect(200);
    await put(ns, 'avatar', pngBytes(), 'image/png');

    const res = await request(app)
      .delete(`/v1/users/${ns}/avatar`)
      .set(bearer(tokens.get(ns)));

    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, 'https://cdn.example/fallback.png');
  });

  test('keeps bytes that another account still points at', async () => {
    const shared = pngBytes(3);
    const a = await account();
    const b = await account();
    await put(a, 'avatar', shared, 'image/png');
    await put(b, 'avatar', shared, 'image/png');
    const [row] = await avatarDigest(a);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    await request(app)
      .patch(`/v1/users/${a}`)
      .set(bearer(tokens.get(a)))
      .send({ avatarUrl: 'https://cdn.example/x.png' })
      .expect(200);
    // b still serves the identical bytes, so a's cleanup must not unlink them.
    assert.ok(existsSync(stored));
    const res = await request(app).get(`/v1/users/${b}/avatar`);
    assert.equal(res.status, 200);
  });
});

describe('blob collection', () => {
  // gcBlobs skips files younger than an hour, so the mtime has to be aged for a
  // test to observe the sweep.
  async function age(paths) {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    for (const p of paths) await utimes(p, old, old);
  }

  test('keeps an avatar a users row still points at', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);
    await age([stored]);

    await gcBlobs(sql, config.dataDir);
    assert.ok(existsSync(stored));
  });

  test('keeps a banner a users row still points at', async () => {
    const ns = await account();
    await put(ns, 'banner', gifBytes(), 'image/gif');
    const [row] = await sql`SELECT banner_blob_digest FROM users WHERE namespace = ${ns}`;
    const stored = blobPathFor(config.dataDir, row.banner_blob_digest);
    await age([stored]);

    await gcBlobs(sql, config.dataDir);
    assert.ok(existsSync(stored));
  });

  test('collects the bytes once the last reference is gone', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);
    await request(app)
      .delete(`/v1/users/${ns}/avatar`)
      .set(bearer(tokens.get(ns)))
      .expect(200);

    assert.ok(!existsSync(stored));
  });

  test('collects an image when its account is deleted', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const [row] = await avatarDigest(ns);
    const stored = blobPathFor(config.dataDir, row.avatar_blob_digest);

    await request(app)
      .delete(`/v1/users/${ns}`)
      .set(bearer(tokens.get(ns)))
      .expect(204);
    assert.ok(!existsSync(stored));
  });
});

describe('visibility', () => {
  test('reports the upload to a stranger, since profile images are public', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const res = await request(app).get(`/v1/users/${ns}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));
  });

  test('includes it in the auth payload, so the UI needs no second fetch', async () => {
    const ns = await account();
    await put(ns, 'avatar', pngBytes(), 'image/png');
    const res = await request(app)
      .get('/v1/auth/me')
      .set(bearer(tokens.get(ns)));
    assert.equal(res.status, 200);
    assert.equal(res.body.avatarUrl, await versioned(ns, 'avatar'));
  });

  test('carries the other profile fields the auth payload used to drop', async () => {
    const ns = await account();
    await request(app)
      .patch(`/v1/users/${ns}`)
      .set(bearer(tokens.get(ns)))
      .send({ bio: 'Hello there', website: 'https://kane.dev', github: 'kane' })
      .expect(200);

    const res = await request(app)
      .get('/v1/auth/me')
      .set(bearer(tokens.get(ns)));
    assert.equal(res.body.bio, 'Hello there');
    assert.equal(res.body.website, 'https://kane.dev');
    assert.equal(res.body.github, 'kane');
  });
});
