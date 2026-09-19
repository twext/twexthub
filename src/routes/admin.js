import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { fieldErrors } from '../errors.js';
import { legalDocumentToObject } from '../serialize.js';
import { notifyUsersMatching, termsBumpedMessage } from '../notify.js';

// trim() is applied to the broadcast message before insert, so this limit
// applies to the trimmed length.
const BROADCAST_MAX_LENGTH = 280;
import { requireObjectBody } from './shared.js';

export function makeAdminRouter({ sql, termsGate }) {
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

  return router;
}
