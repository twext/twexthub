import { existsSync, statSync } from 'node:fs';
import { Router } from 'express';
import { notFound } from '../errors.js';
import { blobPathFor, hashFile } from '../blobs.js';

export function makeBlobsRouter({ sql, config }) {
  const router = Router();

  router.get('/blobs/:digest', async (req, res) => {
    const { digest } = req.params;
    if (!/^[0-9a-f]{64}$/.test(digest)) throw notFound();
    const abs = blobPathFor(config.dataDir, digest);
    if (!existsSync(abs)) throw notFound();
    const [row] = await sql`
      SELECT blob_size FROM versions
      WHERE blob_digest = ${digest}
      ORDER BY id DESC
      LIMIT 1
    `;
    if (row?.blob_size !== null && row?.blob_size !== undefined) {
      if (statSync(abs).size !== Number(row.blob_size)) {
        throw notFound('Blob integrity check failed.');
      }
    }
    if ((await hashFile(abs)) !== digest) throw notFound('Blob integrity check failed.');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('application/javascript');
    res.sendFile(abs);
  });

  return router;
}
