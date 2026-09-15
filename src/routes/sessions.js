import { Router } from 'express';
import { requireSession } from '../auth.js';
import { forbidden, notFound } from '../errors.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { sessionToObject } from '../serialize.js';

export function makeSessionsRouter({ sql, config }) {
  const router = Router();

  async function resolveTargetUser(req) {
    const me = req.auth.user;
    const ns = req.query.namespace;
    if (ns === undefined) return me;
    if (me.role !== 'admin' && ns !== me.namespace) {
      throw forbidden('Only an admin can inspect another account.');
    }
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${ns}`;
    if (!user) throw notFound('No such user.');
    return user;
  }

  router.get('/', requireSession, async (req, res) => {
    const user = await resolveTargetUser(req);
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

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
    const isNumeric = Number.isInteger(targetId) && targetId > 0;
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
