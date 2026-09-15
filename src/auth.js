import { createHash, randomBytes } from 'node:crypto';
import { forbidden, unauthorized } from './errors.js';

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function newToken() {
  return randomBytes(32).toString('hex');
}

const LAST_USED_THROTTLE_MS = 60_000;

export function makeAuthenticate(sql) {
  return async function authenticate(req, res, next) {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? header.match(/^Bearer\s+(.+)$/i) : null;
    if (!match) {
      req.auth = null;
      return next();
    }

    const hash = hashToken(match[1].trim());
    const found = await lookupToken(sql, hash);
    req.auth = found
      ? {
          user: found.user,
          tokenType: found.tokenType,
          scopes: found.scopes,
          tokenId: found.tokenId,
        }
      : null;

    if (found && shouldTouchLastUsed(found.lastUsedAt)) {
      const table = found.tokenType === 'session' ? 'sessions' : 'automation_tokens';
      await sql`UPDATE ${sql(table)} SET last_used_at = now() WHERE id = ${found.tokenId}`;
    }
    next();
  };
}

function shouldTouchLastUsed(lastUsedAt) {
  if (!lastUsedAt) return true;
  return Date.now() - lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS;
}

async function lookupToken(sql, hash) {
  const [session] = await sql`
    SELECT s.id AS token_id, s.expires_at, s.last_used_at,
      u.id, u.namespace, u.display_name, u.role, u.has_published, u.terms_accepted_version, u.created_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hash}
  `;
  if (session) {
    if (session.expires_at && session.expires_at <= new Date()) return null;
    return {
      tokenId: session.token_id,
      tokenType: 'session',
      scopes: ['publish', 'yank'],
      lastUsedAt: session.last_used_at,
      user: session,
    };
  }

  const [token] = await sql`
    SELECT t.id AS token_id, t.expires_at, t.last_used_at, t.scopes,
      u.id, u.namespace, u.display_name, u.role, u.has_published, u.terms_accepted_version, u.created_at
    FROM automation_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ${hash}
  `;
  if (!token) return null;
  if (token.expires_at && token.expires_at <= new Date()) return null;
  return {
    tokenId: token.token_id,
    tokenType: 'automation',
    scopes: token.scopes,
    lastUsedAt: token.last_used_at,
    user: token,
  };
}

export function requireAuth(req, res, next) {
  if (!req.auth) throw unauthorized();
  next();
}

export function requireSession(req, res, next) {
  if (!req.auth) throw unauthorized();
  if (req.auth.tokenType !== 'session') {
    throw forbidden('Automation tokens cannot access this endpoint.');
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.auth) throw unauthorized();
  if (req.auth.tokenType !== 'session') {
    throw forbidden('Automation tokens cannot access this endpoint.');
  }
  if (req.auth.user.role !== 'admin') {
    throw forbidden('Admin privileges are required.');
  }
  next();
}

export function makeRequireTerms(sql) {
  return async function requireTerms(req, res, next) {
    requireAuth(req, res, () => {});
    const [terms] = await sql`SELECT version FROM legal_documents WHERE kind = 'terms'`;
    const accepted = req.auth.user.terms_accepted_version;
    if (!terms || !accepted || accepted < terms.version) {
      throw forbidden('The current Terms of Service have not been accepted yet.');
    }
    next();
  };
}

export function requireScope(scope) {
  return function checkScope(req, res, next) {
    requireAuth(req, res, () => {});
    if (!req.auth.scopes.includes(scope)) {
      throw forbidden(`This token is missing the required "${scope}" scope.`);
    }
    next();
  };
}
