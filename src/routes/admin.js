import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { fieldErrors } from '../errors.js';
import { legalDocumentToObject } from '../serialize.js';
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
      const [row] = await sql`
        INSERT INTO legal_documents (kind, body)
        VALUES (${kind}, ${body})
        ON CONFLICT (kind)
        DO UPDATE SET
          version = legal_documents.version + 1,
          body = EXCLUDED.body,
          updated_at = now()
        RETURNING *
      `;
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

  return router;
}
