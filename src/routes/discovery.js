import { Router } from 'express';
import { requireAdmin, requireAuth } from '../auth.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { HttpError } from '../errors.js';
import { foldText } from '../util.js';
import { product } from '../product.js';
import {
  extensionSummaryFromRow,
  legalDocumentToObject,
  pendingVersionToObject,
} from '../serialize.js';

export function makeDiscoveryRouter({ sql, config, termsGate }) {
  const router = Router();

  function escapeLike(value) {
    return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
  }

  const latestCursor = (row) => ({
    p: row.published_at.toISOString(),
    ns: row.namespace,
    id: row.extension_id,
  });

  function recentCursorCondition(cursor) {
    if (!cursor) return sql``;
    return sql`
      AND (published_at < ${cursor.p}::timestamptz
        OR (published_at = ${cursor.p}::timestamptz AND namespace > ${cursor.ns})
        OR (published_at = ${cursor.p}::timestamptz AND namespace = ${cursor.ns} AND extension_id > ${cursor.id}))
    `;
  }

  router.get('/extensions', async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const rows = await sql`
      SELECT * FROM (
        SELECT v.*,
          row_number() OVER (
            PARTITION BY namespace, extension_id
            ORDER BY published_at DESC, id DESC
          ) AS rn
        FROM versions v
        WHERE status = 'published'
      ) s
      WHERE rn = 1
        ${recentCursorCondition(cursor)}
      ORDER BY published_at DESC, namespace ASC, extension_id ASC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? encodeCursor(latestCursor(page[page.length - 1])) : null;

    res.json({
      data: page.map(extensionSummaryFromRow),
      pagination: { nextCursor, hasMore },
    });
  });

  router.get('/search', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : null;
    const folded = query && query.length > 0 ? foldText(query) : null;
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const rows = await sql`
      SELECT * FROM (
        SELECT v.*,
          row_number() OVER (
            PARTITION BY namespace, extension_id
            ORDER BY published_at DESC, id DESC
          ) AS rn
        FROM versions v
        WHERE status = 'published'
          ${folded ? sql`AND search_text LIKE ${'%' + escapeLike(folded) + '%'}` : sql``}
      ) s
      WHERE rn = 1
        ${recentCursorCondition(cursor)}
      ORDER BY published_at DESC, namespace ASC, extension_id ASC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? encodeCursor(latestCursor(page[page.length - 1])) : null;

    res.json({
      data: page.map(extensionSummaryFromRow),
      pagination: { nextCursor, hasMore },
    });
  });

  router.get('/meta', (req, res) => {
    res.json({
      name: product.name,
      version: product.version,
      tagline: product.tagline,
      homepage: product.homepage,
    });
  });

  router.get('/stats', async (req, res) => {
    const [published, pending, authors] = await Promise.all([
      sql`SELECT COUNT(DISTINCT (namespace, extension_id)) AS count FROM versions WHERE status = 'published'`,
      sql`SELECT COUNT(*) AS count FROM versions WHERE status = 'pending'`,
      sql`SELECT COUNT(DISTINCT owner_id) AS count FROM versions WHERE status = 'published'`,
    ]);
    res.json({
      published: Number(published[0].count),
      pending: Number(pending[0].count),
      authors: Number(authors[0].count),
    });
  });

  router.get('/terms', async (req, res) => {
    const [row] = await sql`SELECT * FROM legal_documents WHERE kind = 'terms'`;
    res.json(legalDocumentToObject(row));
  });

  router.get('/privacy', async (req, res) => {
    const [row] = await sql`SELECT * FROM legal_documents WHERE kind = 'privacy'`;
    res.json(legalDocumentToObject(row));
  });

  router.post('/terms/accept', requireAuth, async (req, res) => {
    const [terms] = await sql`SELECT * FROM legal_documents WHERE kind = 'terms'`;
    await sql`UPDATE users SET terms_accepted_version = ${terms.version} WHERE id = ${req.auth.user.id}`;
    res.status(204).end();
  });

  router.get('/versions', requireAdmin, termsGate, async (req, res) => {
    if (req.query.status !== 'pending') {
      throw new HttpError(400, {
        title: 'Bad Request',
        detail: 'status must be "pending".',
      });
    }
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor);

    const rows = await sql`
      SELECT * FROM versions
      WHERE status = 'pending'
        ${
          cursor
            ? sql`AND (created_at > ${cursor.c}::timestamptz
              OR (created_at = ${cursor.c}::timestamptz AND id > ${cursor.i}))`
            : sql``
        }
      ORDER BY created_at ASC, id ASC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ c: last.created_at.toISOString(), i: Number(last.id) })
        : null;

    res.json({
      data: page.map((row) => pendingVersionToObject(row, config)),
      pagination: { nextCursor, hasMore },
    });
  });

  return router;
}
