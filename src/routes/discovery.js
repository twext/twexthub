import { Router } from 'express';
import { requireAdmin, requireSession } from '../auth.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { HttpError, notFound } from '../errors.js';
import { foldText, isValidExtensionId, isValidNamespace } from '../util.js';
import { trendingExtensions, totalDownloads } from '../metrics.js';
import { product } from '../product.js';
import {
  extensionSummaryFromRow,
  legalDocumentToObject,
  pendingVersionToObject,
} from '../serialize.js';

const SORTS = new Set(['recent', 'downloads', 'updated', 'name']);

export function makeDiscoveryRouter({ sql, config, termsGate }) {
  const router = Router();

  function escapeLike(value) {
    return value.replace(/[\\%_]/g, (ch) => '\\' + ch);
  }

  // Keyset pagination over the latest-version-per-extension view. The cursor
  // carries the sort key plus (namespace, id) as the tiebreaker, so every sort
  // needs both a WHERE condition and an ORDER BY on the same columns. Sorting
  // is descending except for name, which reads naturally A→Z.
  const SORT_COLUMNS = {
    recent: 'published_at',
    updated: 'updated_at',
    downloads: 'downloads',
    name: 'name',
  };
  const SORT_TYPES = {
    recent: 'timestamptz',
    updated: 'timestamptz',
    // int8 rather than the bigint alias: the cast is emitted as a quoted type
    // name, and only int8 is a real entry in pg_type.
    downloads: 'int8',
    name: 'text',
  };

  function cursorCondition(cursor, sort) {
    if (!cursor) return sql``;
    // downloads is a joined aggregate, not a column of the versions subquery.
    const col =
      sort === 'downloads' ? sql`COALESCE(d.total, 0)::bigint` : sql('s.' + SORT_COLUMNS[sort]);
    if (sort === 'name') {
      return sql`
        AND (${col}, s.namespace, s.extension_id) > (${cursor.k}::text, ${cursor.ns}, ${cursor.id})
      `;
    }
    return sql`
      AND (${col}, s.namespace, s.extension_id) < (${cursor.k}::${sql(
        SORT_TYPES[sort],
      )}, ${cursor.ns}, ${cursor.id})
    `;
  }

  const SORT_ORDER = {
    recent: sql`s.published_at DESC, s.namespace ASC, s.extension_id ASC`,
    updated: sql`s.updated_at DESC, s.namespace ASC, s.extension_id ASC`,
    downloads: sql`downloads DESC, s.namespace ASC, s.extension_id ASC`,
    name: sql`s.name ASC, s.namespace ASC, s.extension_id ASC`,
  };

  // Anonymous and unprivileged callers never see private extensions; owners
  // and admins do. Grants do not apply here: the private surface is
  // detail/download only, so listing stays a single-query affair.
  function visibilityFilter(user) {
    if (user?.role === 'admin') return sql``;
    if (user) {
      return sql`
        AND (s.visibility = 'public' OR s.namespace = ${user.namespace}
          OR EXISTS (
            SELECT 1 FROM extension_owners o
            WHERE o.owner_id = ${user.id} AND o.namespace = s.namespace
              AND o.extension_id = s.extension_id
          ))
      `;
    }
    return sql`AND s.visibility = 'public'`;
  }

  async function listLatestVersions({
    limit,
    cursor,
    sort = 'recent',
    license,
    searchFilter = sql``,
    user = null,
  }) {
    const rows = await sql`
      SELECT s.*, COALESCE(d.total, 0)::bigint AS downloads FROM (
        SELECT v.*,
          row_number() OVER (
            PARTITION BY namespace, extension_id
            ORDER BY
              CASE WHEN v.status = 'published' THEN 0 ELSE 1 END,
              v.published_at DESC, v.id DESC
          ) AS rn,
          -- updated_at: publication time of the newest accepted version
          MAX(v.published_at) OVER (PARTITION BY namespace, extension_id) AS updated_at
        FROM versions v
        WHERE v.status IN ('published', 'deprecated')
      ) s
      LEFT JOIN (
        SELECT namespace, extension_id, SUM(total_downloads) AS total
        FROM extension_daily_downloads
        GROUP BY namespace, extension_id
      ) d ON d.namespace = s.namespace AND d.extension_id = s.extension_id
      WHERE rn = 1
        ${visibilityFilter(user)}
        ${license ? sql`AND s.license = ${license}` : sql``}
        ${searchFilter}
        ${cursorCondition(cursor, sort)}
      ORDER BY ${SORT_ORDER[sort]}
      LIMIT ${limit + 1}
    `;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const sortKey =
      sort === 'downloads'
        ? String(Number(last?.downloads ?? 0))
        : sort === 'name'
          ? last?.name
          : (sort === 'recent' ? last?.published_at : last?.updated_at)?.toISOString();
    const nextCursor = hasMore
      ? encodeCursor({ k: sortKey, ns: last.namespace, id: last.extension_id })
      : null;

    return {
      data: page.map((row) => {
        const summary = extensionSummaryFromRow(row);
        summary.downloads = Number(row.downloads ?? 0);
        return summary;
      }),
      pagination: { nextCursor, hasMore },
    };
  }

  function parseSort(raw) {
    if (raw === undefined) return 'recent';
    if (!SORTS.has(raw)) {
      throw new HttpError(400, {
        title: 'Bad Request',
        detail: 'sort must be one of: recent, downloads, updated, name.',
      });
    }
    return raw;
  }

  router.get('/extensions', async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const sort = parseSort(req.query.sort);
    // SPDX identifiers are case-sensitive ("Apache-2.0"), so no normalization.
    const license =
      typeof req.query.license === 'string' && req.query.license.length > 0
        ? req.query.license
        : null;
    const cursor = decodeCursor(req.query.cursor, { k: 'string', ns: 'string', id: 'string' });
    res.json(
      await listLatestVersions({ limit, cursor, sort, license, user: req.auth?.user ?? null }),
    );
  });

  router.get('/extensions/trending', async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 10) || 10, 50);
    const user = req.auth?.user ?? null;
    const trending = await trendingExtensions(sql, { limit, visibility: visibilityFilter(user) });
    if (trending.length === 0) {
      return res.json({ data: [], pagination: { nextCursor: null, hasMore: false } });
    }
    const t = trending;
    // Trending is a flat (namespace, id) list, so the pair has to be joined as a
    // pair: two ANY() lists would match every combination of both columns.
    const namespaces = t.map((e) => e.namespace);
    const ids = t.map((e) => e.id);
    const rows = await sql`
      SELECT * FROM (
        SELECT v.*,
          row_number() OVER (
            PARTITION BY v.namespace, v.extension_id
            ORDER BY CASE WHEN v.status = 'published' THEN 0 ELSE 1 END,
                     v.published_at DESC, v.id DESC
          ) AS rn
        FROM versions v
        JOIN unnest(${namespaces}::text[], ${ids}::text[]) AS trending(namespace, extension_id)
          ON trending.namespace = v.namespace AND trending.extension_id = v.extension_id
        WHERE v.status IN ('published', 'deprecated')
      ) s
      WHERE rn = 1
        ${visibilityFilter(user)}
    `;
    const byKey = new Map(trending.map((e) => [`${e.namespace}/${e.id}`, e]));
    const page = rows
      .map((row) => {
        const summary = extensionSummaryFromRow(row);
        summary.downloads = byKey.get(`${row.namespace}/${row.extension_id}`)?.downloads ?? 0;
        return summary;
      })
      .sort((a, b) => Number(b.downloads) - Number(a.downloads));
    res.json({ data: page, pagination: { nextCursor: null, hasMore: false } });
  });

  router.get('/search', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : null;
    const folded = query && query.length > 0 ? foldText(query) : null;
    const limit = parseLimit(config, req.query.limit);
    const sort = parseSort(req.query.sort);
    const license =
      typeof req.query.license === 'string' && req.query.license.length > 0
        ? req.query.license
        : null;
    const cursor = decodeCursor(req.query.cursor, { k: 'string', ns: 'string', id: 'string' });
    const searchFilter = folded
      ? sql`AND search_text LIKE ${'%' + escapeLike(folded) + '%'}`
      : sql``;
    res.json(
      await listLatestVersions({
        limit,
        cursor,
        sort,
        license,
        searchFilter,
        user: req.auth?.user ?? null,
      }),
    );
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
    const [published, pending, authors, downloads] = await Promise.all([
      sql`SELECT COUNT(DISTINCT (namespace, extension_id)) AS count FROM versions WHERE status IN ('published', 'deprecated')`,
      sql`SELECT COUNT(*) AS count FROM versions WHERE status = 'pending'`,
      sql`SELECT COUNT(DISTINCT owner_id) AS count FROM versions WHERE status IN ('published', 'deprecated')`,
      sql`SELECT COALESCE(SUM(total_downloads), 0)::bigint AS count FROM extension_daily_downloads`,
    ]);
    res.json({
      published: Number(published[0].count),
      pending: Number(pending[0].count),
      authors: Number(authors[0].count),
      downloads: Number(downloads[0].count),
    });
  });

  const LICENSE_BADGE_COLORS = {
    MIT: '#4c1',
    'Apache-2.0': '#a04',
    ISC: '#97ca00',
    'GPL-3.0': '#d6405f',
    'GPL-3.0-only': '#d6405f',
    'GPL-2.0': '#c8404f',
    BSD: '#0f9',
    Unlicense: '#777',
    CC0: '#777',
  };

  function xmlEscape(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&apos;');
  }

  router.get('/badge/@:namespace/:id', async (req, res) => {
    const { namespace, id } = req.params;
    if (!isValidNamespace(namespace) || !isValidExtensionId(id)) throw notFound();
    const rows = await sql`
      SELECT * FROM (
        SELECT v.*, row_number() OVER (
          PARTITION BY namespace, extension_id
          ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END,
                   published_at DESC, id DESC
        ) AS rn
        FROM versions v
        WHERE namespace = ${namespace} AND extension_id = ${id}
          AND status IN ('published', 'deprecated')
          AND v.visibility = 'public'
      ) s
      WHERE rn = 1
    `;
    if (rows.length === 0) throw notFound();
    const row = rows[0];
    // The badge is a fixed 190px wide, so a long label has to be cut before the
    // width heuristic runs or the second rect gets a negative width. Length is
    // taken from the escaped text: escapes expand (& -> 5 chars) and geometry
    // must be derived from what is actually rendered.
    const rawLabel =
      typeof req.query.label === 'string' && req.query.label.length > 0
        ? req.query.label.slice(0, 25)
        : id;
    const label = xmlEscape(rawLabel);
    const downloads = Number((await totalDownloads(sql, namespace, id)) ?? 0);
    const license = row.license;
    const color = LICENSE_BADGE_COLORS[license] ?? '#0070F3';
    const versionText = xmlEscape(`v${row.version}`);
    const downloadsText = xmlEscape(downloads === 1 ? '1 download' : `${downloads} downloads`);
    const licenseText = xmlEscape(license);
    const labelEscaped = label;
    // shields-style flat badge: two pills, 18px tall, DejaVu-ish width heuristic
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="190" height="20" role="img" aria-label="${labelEscaped}: ${versionText}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="190" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${label.length * 7 + 12}" height="20" fill="#555"/>
    <rect x="${label.length * 7 + 12}" width="${190 - label.length * 7 - 12}" height="20" fill="#0070F3"/>
    <rect width="190" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${(label.length * 7 + 12) / 2}" y="14">${label}</text>
    <text x="${label.length * 7 + 12 + (190 - label.length * 7 - 12) / 2}" y="14">${versionText} | ${downloadsText} | ${licenseText} ${color === '#4c1' ? '' : ''}</text>
  </g>
</svg>`;
    res.set('Cache-Control', 'public, max-age=300');
    res.type('image/svg+xml').send(svg);
  });

  router.get('/feed.atom', async (req, res) => {
    const rows = await sql`
      SELECT * FROM (
        SELECT v.*, row_number() OVER (
          PARTITION BY namespace, extension_id
          ORDER BY CASE WHEN status = 'published' THEN 0 ELSE 1 END,
                   published_at DESC, id DESC
        ) AS rn
        FROM versions v
        WHERE status IN ('published', 'deprecated') AND published_at IS NOT NULL
          AND v.visibility = 'public'
      ) s
      WHERE rn = 1
      ORDER BY published_at DESC
      LIMIT 50
    `;
    const base = config.publicBaseUrl.replace(/\/$/, '');
    const root = config.apiRoot ? `/${config.apiRoot}` : '';
    const entries = rows
      .map(
        (row) => `  <entry>
    <id>tag:twexthub,${row.published_at.toISOString().slice(0, 10)}:${xmlEscape(
      `@${row.namespace}/${row.extension_id}-${row.version}`,
    )}</id>
    <title>${xmlEscape(`${row.name} v${row.version}`)}</title>
    <link rel="alternate" href="${xmlEscape(
      `${base}${root}/@${row.namespace}/${row.extension_id}`,
    )}"/>
    <published>${row.published_at.toISOString()}</published>
    <updated>${row.published_at.toISOString()}</updated>
    <author><name>${xmlEscape(row.author || row.namespace)}</name></author>
    <summary>${xmlEscape(row.description)}</summary>
  </entry>`,
      )
      .join('\n');
    const feed = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEscape(product.name)} — new releases</title>
  <id>${xmlEscape(`${base}${root}/feed.atom`)}</id>
  <link rel="self" href="${xmlEscape(`${base}${root}/feed.atom`)}"/>
  <updated>${rows[0]?.published_at?.toISOString() ?? new Date().toISOString()}</updated>
${entries}
</feed>
`;
    res.type('application/atom+xml').send(feed);
  });

  router.get('/terms', async (req, res) => {
    const [row] = await sql`SELECT * FROM legal_documents WHERE kind = 'terms'`;
    if (!row) throw notFound();
    res.json(legalDocumentToObject(row));
  });

  router.get('/privacy', async (req, res) => {
    const [row] = await sql`SELECT * FROM legal_documents WHERE kind = 'privacy'`;
    if (!row) throw notFound();
    res.json(legalDocumentToObject(row));
  });

  router.post('/terms/accept', requireSession, async (req, res) => {
    const [terms] = await sql`SELECT * FROM legal_documents WHERE kind = 'terms'`;
    if (!terms) throw notFound();
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
    const cursor = decodeCursor(req.query.cursor, { c: 'timestamp', i: 'int' });

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
