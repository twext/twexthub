import express from 'express';
import { loadConfig } from './config.js';
import { createDb } from './db.js';
import { makeAuthenticate, makeRequireTerms } from './auth.js';
import { makeRateLimiter } from './rate-limit.js';
import { notFound, errorHandler } from './errors.js';
import { normalizeApiRoot } from './util.js';
import { makeAuthRouter } from './routes/auth.js';
import { makeSessionsRouter } from './routes/sessions.js';
import { makeTokensRouter } from './routes/tokens.js';
import { makeUsersRouter } from './routes/users.js';
import { makePackagesRouter } from './routes/packages.js';
import { makeDiscoveryRouter } from './routes/discovery.js';
import { makeAdminRouter } from './routes/admin.js';

export function createApp(opts = {}) {
  const config = opts.config ?? loadConfig();
  const sql = opts.sql ?? createDb(config);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', opts.trustProxy ?? config.trustProxy ?? false);

  const jsonBody = express.json({ limit: '100kb' });
  app.use((req, res, next) => {
    const isPublish = req.method === 'POST' && /\/@[^/?]+\/[^/?]+\/versions$/.test(req.path);
    return isPublish ? next() : jsonBody(req, res, next);
  });
  app.use(makeAuthenticate(sql));

  const rateLimiter = makeRateLimiter(sql, config);
  const termsGate = makeRequireTerms(sql);
  const shared = { sql, config, rateLimiter, termsGate };

  const root = `/${normalizeApiRoot(config.apiRoot)}`;
  app.use(`${root}/auth`, makeAuthRouter(shared));
  app.use(`${root}/sessions`, makeSessionsRouter(shared));
  app.use(`${root}/tokens`, makeTokensRouter(shared));
  app.use(`${root}/users`, makeUsersRouter(shared));
  app.use(root, makePackagesRouter(shared));
  app.use(root, makeDiscoveryRouter(shared));
  app.use(root, makeAdminRouter(shared));

  app.use((req, res, next) => next(notFound()));
  app.use(errorHandler);

  return { app, sql, config };
}
