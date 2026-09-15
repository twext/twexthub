import { tooManyRequests } from './errors.js';

function windowStartFor(now, windowMinutes) {
  const ms = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function makeRateLimiter(sql, config) {
  const limits = config.rateLimits;

  async function countFor(bucket, windowMinutes) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const rows = await sql`
      SELECT count FROM rate_limit_entries
      WHERE bucket = ${bucket} AND window_start = ${windowStart}
    `;
    return rows.length ? Number(rows[0].count) : 0;
  }

  async function secondsUntilReset(windowMinutes) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const remaining = windowStart.getTime() + windowMinutes * 60_000 - Date.now();
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  async function record(bucket, windowMinutes, tx = sql) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const [{ count }] = await tx`
      INSERT INTO rate_limit_entries (bucket, window_start, count)
      VALUES (${bucket}, ${windowStart}, 1)
      ON CONFLICT (bucket, window_start)
      DO UPDATE SET count = rate_limit_entries.count + 1
      RETURNING count
    `;
    return Number(count);
  }

  async function loginCheck(bucket) {
    const max = limits.loginAttemptsPerWindow;
    const windowMinutes = limits.loginWindowMinutes;
    if ((await countFor(bucket, windowMinutes)) >= max) {
      throw tooManyRequests(await secondsUntilReset(windowMinutes));
    }
    return () => record(bucket, windowMinutes);
  }

  async function signupCheck(bucket) {
    const max = limits.signupsPerIpPerWindow;
    const windowMinutes = limits.signupWindowMinutes;
    if ((await countFor(bucket, windowMinutes)) >= max) {
      throw tooManyRequests(await secondsUntilReset(windowMinutes));
    }
    return (tx) => record(bucket, windowMinutes, tx);
  }

  return { loginCheck, signupCheck };
}
