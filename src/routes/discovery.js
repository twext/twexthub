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

  // The sort key moves descending for every sort but name, while the
  // (namespace, id) tiebreaker always moves ascending. A row-wise comparison
  // against the tuple would drag the sort key's direction onto the
  // tiebreaker, skipping or repeating rows whenever the sort key ties, so the
  // two are compared separately.
  function cursorCondition(cursor, sort) {
    if (!cursor) return sql``;
    // downloads is a joined aggregate, not a column of the versions subquery.
    const col =
      sort === 'downloads' ? sql`COALESCE(d.total, 0)::bigint` : sql('s.' + SORT_COLUMNS[sort]);
    const key = sql`${cursor.k}::${sql(SORT_TYPES[sort])}`;
    const after = sort === 'name' ? sql`${col} > ${key}` : sql`${col} < ${key}`;
    return sql`
      AND (${after}
        OR (${col} = ${key}
          AND (s.namespace, s.extension_id) > (${cursor.ns}, ${cursor.id})))
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
    // Trending is lenient about a bad limit rather than throwing like
    // parseLimit, so clamp here: a negative or fractional value used to reach
    // the query as a negative or fractional LIMIT.
    const requested = Number(req.query.limit ?? 10);
    const limit = Math.min(Number.isInteger(requested) && requested > 0 ? requested : 10, 50);
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

  const XML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

  // Badge text is laid out by hand, so the pills have to be as wide as the
  // glyphs they hold. These are DejaVu Sans advance widths in font units, one
  // per printable ASCII code point from 0x20, read out of the font's hmtx
  // table; a flat per-character guess over-pads exactly the narrow glyphs that
  // dominate the right pill (space, |, i, l).
  //
  // The stack below names this font first, and that ordering is load-bearing:
  // the widths above are DejaVu's, so a viewer that substitutes a wider face
  // first would render text wider than the pill holding it. Verdana and Geneva
  // are the next most likely faces on a desktop and both run wider than DejaVu,
  // so they are worth naming explicitly rather than letting each platform pick a
  // default -- a little slack in the gutter absorbs the difference.
  const ADVANCE_UNITS = `
  651 821 942 1716 1303 1946 1597 563 799 799 1024 1716
  651 739 651 690 1303 1303 1303 1303 1303 1303 1303 1303
  1303 1303 690 690 1716 1716 1716 1087 2048 1401 1405 1430
  1577 1294 1178 1587 1540 604 604 1343 1141 1767 1532 1612
  1235 1612 1423 1300 1251 1499 1401 2025 1403 1251 1403 799
  690 799 1716 1024 1024 1255 1300 1126 1300 1260 721 1300
  1298 569 569 1186 569 1995 1298 1253 1300 1300 842 1067
  803 1298 1212 1675 1212 1212 1075 1303 690 1303 1716
  `
    .trim()
    .split(/\s+/)
    .map(Number);
  const UNITS_PER_EM = 2048;
  const BADGE_FONT_SIZE = 11;
  // A non-ASCII ?label= gets the mean ASCII advance; guessing the real glyph
  // width would be worse than an average.
  const MEAN_ADVANCE = Math.round(
    ADVANCE_UNITS.reduce((sum, units) => sum + units, 0) / ADVANCE_UNITS.length,
  );
  // A fixed gutter either side of the text. It has to clear the ~4.5px the text
  // already sits from the top and bottom: at 5px the long right-hand pill read
  // as flush while the short label pill looked generously padded.
  const BADGE_PADDING = 16;
  // The label is caller-supplied, and the badge is sized to fit it, so an
  // unbounded ?label= would let a short URL ask for an arbitrarily wide SVG.
  // Long real names fit well inside this; the cap only bounds the pathological.
  const MAX_LABEL_WIDTH = 320;

  function textWidth(text) {
    let units = 0;
    for (const char of text) {
      const index = char.codePointAt(0) - 0x20;
      units += index >= 0 && index < ADVANCE_UNITS.length ? ADVANCE_UNITS[index] : MEAN_ADVANCE;
    }
    return (units * BADGE_FONT_SIZE) / UNITS_PER_EM;
  }

  // Widths are measured on the raw label and the escaped label is what gets
  // written out, because the two render identically -- an entity is how the
  // markup spells a glyph, not extra glyphs. Cutting is therefore a plain
  // per-glyph budget on the raw text and cannot land inside an entity.
  function fitLabel(value) {
    let out = '';
    let units = 0;
    for (const char of String(value)) {
      const index = char.codePointAt(0) - 0x20;
      const advance =
        index >= 0 && index < ADVANCE_UNITS.length ? ADVANCE_UNITS[index] : MEAN_ADVANCE;
      if ((units + advance) * BADGE_FONT_SIZE > (MAX_LABEL_WIDTH - BADGE_PADDING) * UNITS_PER_EM) {
        break;
      }
      units += advance;
      out += char;
    }
    return out;
  }

  const round = (value) => Math.round(value * 100) / 100;

  // One pass over every metacharacter, so the ampersands introduced by the
  // earlier entities are not escaped again.
  function xmlEscape(value) {
    return String(value).replace(/[&<>"']/g, (ch) => XML_ENTITIES[ch]);
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
    const label =
      fitLabel(
        typeof req.query.label === 'string' && req.query.label.length > 0 ? req.query.label : id,
      ) || id;
    const downloads = Number((await totalDownloads(sql, namespace, id)) ?? 0);
    const license = row.license;
    const color = LICENSE_BADGE_COLORS[license] ?? '#0070F3';
    const versionText = `v${row.version}`;
    const downloadsText = downloads === 1 ? '1 download' : `${downloads} downloads`;
    const rightText = `${versionText} | ${downloadsText} | ${license}`;
    // shields-style flat badge: two pills, 20px tall, each sized to its own text
    // plus the gutter. Sizing to the content is what makes the badge look right;
    // a fixed total width either leaves a short label marooned in a huge blue
    // pill or squeezes the right-hand text off the end.
    const labelWidth = round(textWidth(label) + BADGE_PADDING);
    const rightWidth = round(textWidth(rightText) + BADGE_PADDING);
    const totalWidth = round(labelWidth + rightWidth);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" viewBox="0 0 ${totalWidth} 20" role="img" aria-label="${xmlEscape(`${label}: ${versionText}`)}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalWidth}" height="20" rx="3"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${rightWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${xmlEscape(label)}</text>
    <text x="${labelWidth + rightWidth / 2}" y="14">${xmlEscape(rightText)}</text>
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
