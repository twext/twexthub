import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { fieldErrors, notFound } from '../errors.js';
import { legalDocumentToObject } from '../serialize.js';
import { notifyUsersMatching, termsBumpedMessage } from '../notify.js';
import { audit, auditRowToObject } from '../audit.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';

// trim() is applied to the broadcast message before insert, so this limit
// applies to the trimmed length.
const BROADCAST_MAX_LENGTH = 280;
import { requireObjectBody } from './shared.js';

export function makeAdminRouter({ sql, config, termsGate }) {
  const router = Router();

  function makeLegalDocumentHandler(kind, bodyError) {
    return async (req, res) => {
      requireObjectBody(req);
      const body = req.body.body;
      if (typeof body !== 'string' || body.length === 0) {
        throw fieldErrors([{ field: 'body', message: bodyError }]);
      }
      const row = await sql.begin(async (tx) => {
        const [doc] = await tx`
          INSERT INTO legal_documents (kind, body)
          VALUES (${kind}, ${body})
          ON CONFLICT (kind)
          DO UPDATE SET
            version = legal_documents.version + 1,
            body = EXCLUDED.body,
            updated_at = now()
          RETURNING *
        `;
        // A first insert (version 1) is not a bump, and only accounts that
        // accepted a previous version are blocked by the gate afterwards.
        if (kind === 'terms' && doc.version > 1) {
          await notifyUsersMatching(
            tx,
            tx`WHERE terms_accepted_version IS NOT NULL`,
            'terms.bumped',
            termsBumpedMessage(doc.version),
            { version: doc.version, previousVersion: doc.version - 1 },
          );
        }
        return doc;
      });
      termsGate.invalidate?.();
      res.json(legalDocumentToObject(row));
    };
  }

  router.patch(
    '/admin/terms',
    requireAdmin,
    termsGate,
    makeLegalDocumentHandler('terms', 'Terms body is required.'),
  );
  router.patch(
    '/admin/privacy',
    requireAdmin,
    termsGate,
    makeLegalDocumentHandler('privacy', 'Privacy body is required.'),
  );

  router.post('/admin/notifications', requireAdmin, termsGate, async (req, res) => {
    requireObjectBody(req);
    const { message } = req.body;
    if (
      typeof message !== 'string' ||
      message.trim().length === 0 ||
      message.length > BROADCAST_MAX_LENGTH
    ) {
      throw fieldErrors([
        {
          field: 'message',
          message: `A message is required, at most ${BROADCAST_MAX_LENGTH} characters.`,
        },
      ]);
    }
    const created = await sql.begin((tx) =>
      notifyUsersMatching(tx, tx``, 'broadcast', message.trim()),
    );
    res.status(201).json({ created });
  });

  router.patch('/admin/users/:namespace/quota', requireAdmin, termsGate, async (req, res) => {
    requireObjectBody(req);
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${req.params.namespace}`;
    if (!user) throw notFound('No such account.');
    const { maxBlobBytes } = req.body;
    if (maxBlobBytes !== null && (!Number.isInteger(maxBlobBytes) || maxBlobBytes <= 0)) {
      throw fieldErrors([
        { field: 'maxBlobBytes', message: 'Must be a positive integer, or null for the default.' },
      ]);
    }
    const updated = await sql.begin(async (tx) => {
      const [row] = await tx`
        UPDATE users SET max_blob_bytes = ${maxBlobBytes}
        WHERE id = ${user.id}
        RETURNING id, namespace, blob_bytes, max_blob_bytes
      `;
      await audit(
        tx,
        req.auth.user,
        'quota.set',
        { namespace: user.namespace },
        {
          maxBlobBytes,
          previousMaxBlobBytes: user.max_blob_bytes,
        },
      );
      return row;
    });
    res.json({
      namespace: updated.namespace,
      blobBytes: Number(updated.blob_bytes),
      maxBlobBytes: updated.max_blob_bytes === null ? null : Number(updated.max_blob_bytes),
    });
  });

  router.get('/admin/users/:namespace/quota', requireAdmin, async (req, res) => {
    const [user] = await sql`
      SELECT namespace, blob_bytes, max_blob_bytes FROM users
      WHERE namespace = ${req.params.namespace}
    `;
    if (!user) throw notFound('No such account.');
    res.json({
      namespace: user.namespace,
      blobBytes: Number(user.blob_bytes),
      maxBlobBytes: user.max_blob_bytes === null ? null : Number(user.max_blob_bytes),
    });
  });

  router.get('/admin/audit', requireAdmin, async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const rows = await sql`
      SELECT * FROM audit_log
      ${cursor ? sql`WHERE id < ${cursor.i}` : sql``}
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ i: Number(last.id) }) : null;
    res.json({
      data: page.map(auditRowToObject),
      pagination: { nextCursor, hasMore },
    });
  });

  return router;
}
