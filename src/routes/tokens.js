import { Router } from 'express';
import { hashToken, newToken, requireSession } from '../auth.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { fieldErrors, forbidden, notFound } from '../errors.js';
import { automationTokenToObject } from '../serialize.js';
import { requireObjectBody, resolveTargetUser } from './shared.js';

const SCOPES = ['publish', 'yank'];

export function makeTokensRouter({ sql, config }) {
  const router = Router();

  function validateScopes(scopes) {
    const errors = [];
    if (!Array.isArray(scopes) || scopes.length < 1) {
      errors.push({ field: 'scopes', message: 'At least one scope is required.' });
    } else {
      for (const scope of scopes) {
        if (!SCOPES.includes(scope)) {
          errors.push({ field: 'scopes', message: `Unknown scope "${scope}".` });
        }
      }
    }
    if (errors.length > 0) throw fieldErrors(errors);
    return [...new Set(scopes)];
  }

  router.get('/', requireSession, async (req, res) => {
    const user = await resolveTargetUser(sql, req);
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });

    const rows = await sql`
      SELECT * FROM automation_tokens
      WHERE user_id = ${user.id}
        ${cursor ? sql`AND id < ${cursor.i}` : sql``}
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ i: Number(last.id) }) : null;

    res.json({
      data: page.map(automationTokenToObject),
      pagination: { nextCursor, hasMore },
    });
  });

  router.post('/', requireSession, async (req, res) => {
    requireObjectBody(req);
    const { name, scopes, expiresInDays } = req.body;

    const errors = [];
    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 80) {
      errors.push({
        field: 'name',
        message: 'Name must be a non-empty string of at most 80 characters.',
      });
    }
    if (expiresInDays !== undefined) {
      if (!Number.isInteger(expiresInDays) || expiresInDays < 1) {
        errors.push({
          field: 'expiresInDays',
          message: 'Must be a positive integer when provided.',
        });
      } else {
        const expiry = new Date(Date.now() + expiresInDays * 86_400_000);
        if (!Number.isFinite(expiry.getTime())) {
          errors.push({ field: 'expiresInDays', message: 'Expiration is too far in the future.' });
        }
      }
    }
    if (errors.length > 0) throw fieldErrors(errors);

    const cleanScopes = validateScopes(scopes);
    const token = newToken();
    const expiresAt =
      expiresInDays !== undefined ? new Date(Date.now() + expiresInDays * 86_400_000) : null;

    const [row] = await sql`
      INSERT INTO automation_tokens (user_id, name, token_hash, scopes, expires_at)
      VALUES (${req.auth.user.id}, ${name}, ${hashToken(token)}, ${sql.json(cleanScopes)}, ${expiresAt})
      RETURNING *
    `;

    res.status(201).json({ ...automationTokenToObject(row), token });
  });

  router.patch('/:id', requireSession, async (req, res) => {
    requireObjectBody(req);
    const { name, scopes } = req.body;
    if (name === undefined && scopes === undefined) {
      throw fieldErrors([{ field: 'body', message: 'Provide at least name or scopes.' }]);
    }

    const targetId = Number(req.params.id);
    const [row] =
      Number.isSafeInteger(targetId) && targetId > 0
        ? await sql`SELECT * FROM automation_tokens WHERE id = ${targetId}`
        : [];
    if (!row) throw notFound();
    if (Number(row.user_id) !== Number(req.auth.user.id) && req.auth.user.role !== 'admin') {
      throw forbidden("Only an admin can modify another account's tokens.");
    }

    if (
      name !== undefined &&
      (typeof name !== 'string' || name.trim().length === 0 || name.length > 80)
    ) {
      throw fieldErrors([
        { field: 'name', message: 'Name must be a non-empty string of at most 80 characters.' },
      ]);
    }
    const patch = {};
    const columns = [];
    if (name !== undefined) {
      patch.name = name;
      columns.push('name');
    }
    if (scopes !== undefined) {
      patch.scopes = sql.json(validateScopes(scopes));
      columns.push('scopes');
    }

    const [updated] = await sql`
      UPDATE automation_tokens
      SET ${sql(patch, columns)}
      WHERE id = ${targetId}
      RETURNING *
    `;
    if (!updated) throw notFound();

    res.json(automationTokenToObject(updated));
  });

  router.delete('/:id', requireSession, async (req, res) => {
    const targetId = Number(req.params.id);
    const [row] =
      Number.isSafeInteger(targetId) && targetId > 0
        ? await sql`SELECT * FROM automation_tokens WHERE id = ${targetId}`
        : [];
    if (!row) throw notFound();
    if (Number(row.user_id) !== Number(req.auth.user.id) && req.auth.user.role !== 'admin') {
      throw forbidden("Only an admin can revoke another account's tokens.");
    }
    await sql`DELETE FROM automation_tokens WHERE id = ${targetId}`;
    res.status(204).end();
  });

  return router;
}
