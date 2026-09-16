import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { fieldErrors, notFound } from '../errors.js';
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
        UPDATE legal_documents
        SET version = version + 1, body = ${body}, updated_at = now()
        WHERE kind = ${kind}
        RETURNING *
      `;
      if (!row) throw notFound(`No ${kind} document to update.`);
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
