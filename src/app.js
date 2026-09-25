import express from 'express';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { makeAuthenticate, makeRequireTerms } from './auth.js';
import { makeRateLimiter } from './rate-limit.js';
import { makeHttpRateLimiter } from './http-rate-limit.js';
import { makeRequestTelemetry } from './observability.js';
import { makeCors } from './cors.js';
import { HttpError, notFound, errorHandler } from './errors.js';
import { normalizeApiRoot } from './util.js';
import { makeAuthRouter } from './routes/auth.js';
import { makeSessionsRouter } from './routes/sessions.js';
import { makeTokensRouter } from './routes/tokens.js';
import { makeUsersRouter } from './routes/users.js';
import { makeNotificationsRouter } from './routes/notifications.js';
import { makePackagesRouter } from './routes/packages.js';
import { makeBlobsRouter } from './routes/blobs.js';
import { makeDiscoveryRouter } from './routes/discovery.js';
import { makeAdminRouter } from './routes/admin.js';

export function createApp(opts = {}) {
  const config = opts.config ?? loadConfig();
  const sql = opts.sql ?? createDb(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? config.trustProxy ?? false);

  if (config.requireHttps) {
    app.use((req, res, next) => {
      if (req.secure) return next();
      return next(new HttpError(403, { title: 'Forbidden', detail: 'HTTPS is required.' }));
    });
  }

  app.use(makeCors(config.cors));

  // Coarse per-IP DoS backstop for every route, including the file-serving
  // and ownership-checked endpoints. The DB-backed buckets in rate-limit.js
  // layer their precise login/signup/publish/download windows on top.
  app.use(makeHttpRateLimiter(config));

  // Counts and timings for /admin/metrics; also the structured request log
  // when `logging.requests` is on. Mounted before the routers so unmatched
  // paths still count.
  const telemetry = makeRequestTelemetry({ logRequests: config.logging?.requests === true });
  app.locals.telemetry = telemetry;
  app.use(telemetry.middleware);

  const jsonBody = express.json({ limit: '100kb' });
  app.use((req, res, next) => {
    const isPublish = req.method === 'POST' && /\/@[^/?]+\/[^/?]+\/versions\/?$/.test(req.path);
    return isPublish ? next() : jsonBody(req, res, next);
  });
  app.use(makeAuthenticate(sql));

  const rateLimiter = makeRateLimiter(sql, config);
  const termsGate = makeRequireTerms(sql);
  const shared = { sql, config, rateLimiter, termsGate };

  const apiRoot = normalizeApiRoot(config.apiRoot);
  const root = apiRoot ? `/${apiRoot}` : '';
  const mount = (suffix) => `${root}${suffix}`;

  app.use(mount('/auth'), makeAuthRouter(shared));
  app.use(mount('/sessions'), makeSessionsRouter(shared));
  app.use(mount('/tokens'), makeTokensRouter(shared));
  app.use(mount('/users'), makeUsersRouter(shared));
  app.use(mount('/notifications'), makeNotificationsRouter(shared));
  app.use(root || '/', makeBlobsRouter(shared));
  app.use(root || '/', makePackagesRouter(shared));
  app.use(root || '/', makeDiscoveryRouter(shared));
  app.use(root || '/', makeAdminRouter(shared));

  app.use((req, res, next) => next(notFound()));
  app.use(errorHandler);

  return { app, sql, config, rateLimiter, telemetry };
}
