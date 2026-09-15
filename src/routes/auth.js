import { Router } from 'express';
import { hashToken, newToken, requireAuth } from '../auth.js';
import { hashPassword, verifyPassword } from '../password.js';
import { fieldErrors, HttpError, conflict, unauthorized } from '../errors.js';
import { isPlainObject, isValidNamespace } from '../util.js';
import { userToObject } from '../serialize.js';

export function makeAuthRouter({ sql, config, rateLimiter }) {
  const router = Router();
  const scrypt = config.auth.scrypt;
  const sessionTtlMs = config.auth.sessionTtlDays * 86_400_000;

  function requireObjectBody(req) {
    if (!isPlainObject(req.body)) {
      throw new HttpError(422, {
        title: 'Validation Error',
        detail: 'Request body must be a JSON object.',
      });
    }
  }

  async function createSession(tx, userId) {
    const token = newToken();
    await tx`
      INSERT INTO sessions (user_id, token_hash, expires_at)
      VALUES (${userId}, ${hashToken(token)}, ${new Date(Date.now() + sessionTtlMs)})
    `;
    return token;
  }

  router.post('/signup', async (req, res) => {
    requireObjectBody(req);
    const { namespace, password, displayName } = req.body;

    const errors = [];
    if (typeof namespace !== 'string' || !isValidNamespace(namespace)) {
      errors.push({
        field: 'namespace',
        message: 'Must be lowercase letters, digits and hyphens; no leading/trailing hyphen.',
      });
    }
    if (typeof password !== 'string') {
      errors.push({ field: 'password', message: 'Password is required.' });
    } else if (password.length < 8) {
      errors.push({ field: 'password', message: 'Password must be at least 8 characters.' });
    }
    if (displayName !== undefined && typeof displayName !== 'string') {
      errors.push({ field: 'displayName', message: 'Must be a string.' });
    } else if (displayName !== undefined && displayName.length > 80) {
      errors.push({
        field: 'displayName',
        message: 'Display name must be at most 80 characters.',
      });
    }
    if (errors.length > 0) throw fieldErrors(errors);

    const effectiveDisplayName =
      typeof displayName === 'string' && displayName.length > 0 ? displayName : namespace;

    const recordSignup = await rateLimiter.signupCheck(`signup:${req.ip}`);

    let user;
    let token;
    try {
      await sql.begin(async (tx) => {
        const [{ count }] = await tx`SELECT count(*)::int AS count FROM users`;
        const role = count === 0 ? 'admin' : 'normal';
        [user] = await tx`
          INSERT INTO users (namespace, display_name, password_hash, role)
          VALUES (${namespace}, ${effectiveDisplayName}, ${hashPassword(password, scrypt)}, ${role})
          RETURNING *
        `;
        token = await createSession(tx, user.id);
        await recordSignup(tx);
      });
    } catch (error) {
      if (error.code === '23505') throw conflict('That namespace is already taken.');
      throw error;
    }

    res.status(201).json({ user: userToObject(user), token });
  });

  router.post('/login', async (req, res) => {
    requireObjectBody(req);
    const { namespace, password } = req.body;
    if (typeof namespace !== 'string' || typeof password !== 'string') {
      throw unauthorized('Invalid namespace or password.');
    }

    const recordFailure = await rateLimiter.loginCheck(`login:${namespace}|${req.ip}`);

    const [user] = await sql`SELECT * FROM users WHERE namespace = ${namespace}`;
    if (!user || !verifyPassword(password, user.password_hash)) {
      await recordFailure();
      throw unauthorized('Invalid namespace or password.');
    }

    const token = await sql.begin(async (tx) => {
      const tokenText = await createSession(tx, user.id);
      return tokenText;
    });
    res.json({ user: userToObject(user), token });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    const { tokenType, tokenId } = req.auth;
    if (tokenType === 'session') {
      await sql`DELETE FROM sessions WHERE id = ${tokenId}`;
    } else {
      await sql`DELETE FROM automation_tokens WHERE id = ${tokenId}`;
    }
    res.status(204).end();
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json(userToObject(req.auth.user));
  });

  return router;
}
