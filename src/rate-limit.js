import { tooManyRequests } from './errors.js';

function windowStartFor(now, windowMinutes) {
  const ms = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function makeRateLimiter(sql, config) {
  const limits = config.rateLimits;

  async function secondsUntilReset(windowMinutes) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const remaining = windowStart.getTime() + windowMinutes * 60_000 - Date.now();
    return Math.max(1, Math.ceil(remaining / 1000));
  }

  async function record(bucket, windowMinutes) {
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const [{ count }] = await sql`
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
    const windowStart = windowStartFor(new Date(), windowMinutes);
    const [existing] = await sql`
      SELECT count FROM rate_limit_entries
      WHERE bucket = ${bucket} AND window_start = ${windowStart}
    `;
    if (existing && Number(existing.count) >= max) {
      throw tooManyRequests(await secondsUntilReset(windowMinutes));
    }
    return async () => {
      const count = await record(bucket, windowMinutes);
      if (count > max) throw tooManyRequests(await secondsUntilReset(windowMinutes));
    };
  }

  async function signupCheck(bucket) {
    const max = limits.signupsPerIpPerWindow;
    const windowMinutes = limits.signupWindowMinutes;
    const count = await record(bucket, windowMinutes);
    if (count > max) throw tooManyRequests(await secondsUntilReset(windowMinutes));
  }

  const maxWindow = Math.max(limits.loginWindowMinutes, limits.signupWindowMinutes);
  const cleanupInterval = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - maxWindow * 60_000);
      await sql`DELETE FROM rate_limit_entries WHERE window_start < ${cutoff}`;
    } catch {
      // cleanup errors are non-fatal
    }
  }, 60_000);
  cleanupInterval.unref();

  return { loginCheck, signupCheck };
}
