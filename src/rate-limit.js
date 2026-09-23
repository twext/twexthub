import { tooManyRequests } from './errors.js';

function windowStartFor(now, windowMinutes) {
  const ms = windowMinutes * 60_000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

export function makeRateLimiter(sql, config) {
  const limits = config.rateLimits;

  function secondsUntilReset(windowMinutes) {
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
      throw tooManyRequests(secondsUntilReset(windowMinutes));
    }
    return async () => {
      const count = await record(bucket, windowMinutes);
      if (count > max) throw tooManyRequests(secondsUntilReset(windowMinutes));
    };
  }

  async function signupCheck(bucket) {
    const max = limits.signupsPerIpPerWindow;
    const windowMinutes = limits.signupWindowMinutes;
    const count = await record(bucket, windowMinutes);
    if (count > max) throw tooManyRequests(secondsUntilReset(windowMinutes));
  }

  // Middleware factory: bucketFor(req) names the bucket (e.g. per account).
  // Recorded before the handler runs because publishes compile on the server.
  function publish(bucketFor) {
    const max = limits.publishesPerWindow ?? 100;
    const windowMinutes = limits.publishWindowMinutes ?? 15;
    return async (req, res, next) => {
      try {
        const bucket = bucketFor?.(req) ?? 'publish';
        const windowStart = windowStartFor(new Date(), windowMinutes);
        const [existing] = await sql`
          SELECT count FROM rate_limit_entries
          WHERE bucket = ${bucket} AND window_start = ${windowStart}
        `;
        if (existing && Number(existing.count) >= max) {
          return next(tooManyRequests(secondsUntilReset(windowMinutes)));
        }
        const count = await record(bucket, windowMinutes);
        if (count > max) return next(tooManyRequests(secondsUntilReset(windowMinutes)));
        return next();
      } catch (error) {
        return next(error);
      }
    };
  }

  const maxWindow = Math.max(
    limits.loginWindowMinutes,
    limits.signupWindowMinutes,
    limits.publishWindowMinutes ?? 15,
  );
  const cleanupInterval = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - maxWindow * 60_000);
      await sql`DELETE FROM rate_limit_entries WHERE window_start < ${cutoff}`;
    } catch {
      // cleanup errors are non-fatal
    }
  }, 60_000);
  cleanupInterval.unref();

  return {
    loginCheck,
    signupCheck,
    publish,
    stop() {
      clearInterval(cleanupInterval);
    },
  };
}
