import { Router } from 'express';
import { requireAdmin } from '../auth.js';
import { fieldErrors, HttpError } from '../errors.js';
import { isPlainObject } from '../util.js';
import { legalDocumentToObject } from '../serialize.js';

export function makeAdminRouter({ sql, termsGate }) {
  const router = Router();

  function requireObjectBody(req) {
    if (!isPlainObject(req.body)) {
      throw new HttpError(422, {
        title: 'Validation Error',
        detail: 'Request body must be a JSON object.',
      });
    }
  }

  router.patch('/admin/terms', requireAdmin, termsGate, async (req, res) => {
    requireObjectBody(req);
    const body = req.body.body;
    if (typeof body !== 'string' || body.length === 0) {
      throw fieldErrors([{ field: 'body', message: 'Terms body is required.' }]);
    }
    const [row] = await sql`
      UPDATE legal_documents
      SET version = version + 1, body = ${body}, updated_at = now()
      WHERE kind = 'terms'
      RETURNING *
    `;
    res.json(legalDocumentToObject(row));
  });

  router.patch('/admin/privacy', requireAdmin, termsGate, async (req, res) => {
    requireObjectBody(req);
    const body = req.body.body;
    if (typeof body !== 'string' || body.length === 0) {
      throw fieldErrors([{ field: 'body', message: 'Privacy body is required.' }]);
    }
    const [row] = await sql`
      UPDATE legal_documents
      SET version = version + 1, body = ${body}, updated_at = now()
      WHERE kind = 'privacy'
      RETURNING *
    `;
    res.json(legalDocumentToObject(row));
  });

  return router;
}
