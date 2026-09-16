import { Router } from 'express';
import { requireSession } from '../auth.js';
import { forbidden, notFound } from '../errors.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { sessionToObject } from '../serialize.js';
import { resolveTargetUser } from './shared.js';

export function makeSessionsRouter({ sql, config }) {
  const router = Router();

  router.get('/', requireSession, async (req, res) => {
    const user = await resolveTargetUser(sql, req);
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });

    const rows = await sql`
      SELECT * FROM sessions
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
      data: page.map(sessionToObject),
      pagination: { nextCursor, hasMore },
    });
  });

  router.delete('/:id', requireSession, async (req, res) => {
    const targetId = Number(req.params.id);
    const isNumeric = Number.isSafeInteger(targetId) && targetId > 0;
    const [row] = isNumeric ? await sql`SELECT * FROM sessions WHERE id = ${targetId}` : [];
    if (!row) throw notFound();
    if (Number(row.user_id) !== Number(req.auth.user.id) && req.auth.user.role !== 'admin') {
      throw forbidden("Only an admin can revoke another account's sessions.");
    }
    await sql`DELETE FROM sessions WHERE id = ${targetId}`;
    res.status(204).end();
  });

  return router;
}
