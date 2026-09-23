import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { fieldErrors, HttpError } from '../errors.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { notificationToObject } from '../serialize.js';
import { requireObjectBody } from './shared.js';

const MAX_MARK_READ = 100;

export function makeNotificationsRouter({ sql, config, termsGate }) {
  const router = Router();
  const guard = [requireAuth, termsGate];

  router.get('/', guard, async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });
    const { unread } = req.query;
    if (unread !== undefined && unread !== 'true') {
      throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid unread.' });
    }

    const rows = await sql`
      SELECT * FROM notifications
      WHERE user_id = ${req.auth.user.id}
        ${unread === 'true' ? sql`AND read_at IS NULL` : sql``}
        ${cursor ? sql`AND id < ${cursor.i}` : sql``}
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ i: Number(last.id) }) : null;

    const [counts] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE read_at IS NULL) AS unread,
        COUNT(*) AS total
      FROM notifications
      WHERE user_id = ${req.auth.user.id}
    `;

    res.json({
      data: page.map(notificationToObject),
      unreadCount: Number(counts.unread),
      pagination: { nextCursor, hasMore },
    });
  });

  router.post('/read', guard, async (req, res) => {
    requireObjectBody(req);
    const { ids, all } = req.body;
    if ((ids === undefined) === (all === undefined)) {
      throw fieldErrors([
        { field: 'ids', message: 'Provide either "ids" or "all", not both or neither.' },
      ]);
    }

    if (all !== undefined) {
      if (all !== true) {
        throw fieldErrors([{ field: 'all', message: 'Must be true when provided.' }]);
      }
      const updated = await sql`
        UPDATE notifications SET read_at = now()
        WHERE user_id = ${req.auth.user.id} AND read_at IS NULL
      `;
      return res.json({ updated: updated.count });
    }

    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_MARK_READ) {
      throw fieldErrors([
        { field: 'ids', message: `Must be a non-empty array of at most ${MAX_MARK_READ} ids.` },
      ]);
    }
    const parsed = [];
    for (const id of ids) {
      const n = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN;
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw fieldErrors([{ field: 'ids', message: 'Ids must be positive integers.' }]);
      }
      parsed.push(n);
    }

    const updated = await sql`
      UPDATE notifications SET read_at = now()
      WHERE user_id = ${req.auth.user.id} AND id IN ${sql(parsed)} AND read_at IS NULL
      RETURNING id
    `;
    res.json({ updated: updated.count });
  });

  return router;
}
