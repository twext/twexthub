const DAY_MS = 24 * 60 * 60 * 1000;

// Buckets are keyed on the UTC date the event falls in, so day boundaries are
// UTC midnight too. Local midnight would split a day into two buckets on any
// host that isn't on UTC.
function utcMidnight(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function aggregateDayLoader(sql) {
  return async function aggregateDay(day = new Date()) {
    const dayStart = utcMidnight(day);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    await sql`
      INSERT INTO extension_daily_downloads (namespace, extension_id, day, total_downloads, distinct_downloads)
      SELECT
        e.namespace,
        e.extension_id,
        ${dayStart.toISOString()}::date AS day,
        COUNT(*)::bigint AS total_downloads,
        COUNT(
          DISTINCT md5(e.namespace || '/' || e.extension_id || '|' || COALESCE(e.remote_addr, e.user_agent, ''))
        )::bigint AS distinct_downloads
      FROM download_events e
      WHERE e.created_at >= ${dayStart.toISOString()}
        AND e.created_at < ${dayEnd.toISOString()}
      GROUP BY e.namespace, e.extension_id
      ON CONFLICT (namespace, extension_id, day)
      DO UPDATE SET
        total_downloads = EXCLUDED.total_downloads,
        distinct_downloads = EXCLUDED.distinct_downloads
    `;
  };
}

export function dailyAggregationJob(sql) {
  let timer = null;
  let running = false;
  const aggregateDay = aggregateDayLoader(sql);
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const yesterday = new Date(utcMidnight(new Date()).getTime() - DAY_MS);
      await aggregateDay(yesterday);
      await aggregateDay(new Date());
    } catch (error) {
      console.error('daily download aggregation failed:', error);
    } finally {
      running = false;
    }
  };
  return {
    start() {
      const interval = Number(process.env.TWEXTHUB_METRICS_INTERVAL_MS ?? 60 * 60 * 1000);
      timer = setInterval(tick, interval);
      timer.unref?.();
      void tick();
      return this;
    },
    async stop() {
      if (timer) clearInterval(timer);
      while (running) await new Promise((resolve) => setTimeout(resolve, 50));
    },
  };
}

export async function totalDownloads(sql, namespace, extensionId) {
  const rows = await sql`
    SELECT COALESCE(SUM(total_downloads), 0)::bigint AS total
    FROM extension_daily_downloads
    WHERE namespace = ${namespace} AND extension_id = ${extensionId}
  `;
  return rows[0]?.total ?? 0n;
}

export async function trendingExtensions(sql, { limit = 10 } = {}) {
  const rows = await sql`
    SELECT namespace, extension_id,
           COALESCE(SUM(total_downloads), 0)::bigint AS downloads
    FROM extension_daily_downloads
    WHERE day >= ${new Date(Date.now() - 7 * DAY_MS).toISOString()}::date
    GROUP BY namespace, extension_id
    ORDER BY downloads DESC, namespace ASC, extension_id ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({
    namespace: row.namespace,
    id: row.extension_id,
    downloads: row.downloads,
  }));
}
