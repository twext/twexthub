import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import { hashPassword } from '../password.js';
import { requireSession } from '../auth.js';
import { decodeCursor, encodeCursor, parseLimit } from '../pagination.js';
import { fieldErrors, forbidden, notFound } from '../errors.js';
import { isValidNamespace } from '../util.js';
import { userToObject } from '../serialize.js';
import { requireObjectBody } from './shared.js';

export function makeUsersRouter({ sql, config, termsGate }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const limit = parseLimit(config, req.query.limit);
    const cursor = decodeCursor(req.query.cursor, { i: 'int' });

    const rows = await sql`
      SELECT * FROM users
      ${cursor ? sql`WHERE id < ${cursor.i}` : sql``}
      ORDER BY id DESC
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ i: Number(last.id) }) : null;

    res.json({
      data: page.map(userToObject),
      pagination: { nextCursor, hasMore },
    });
  });

  router.get('/:namespace', async (req, res) => {
    if (!isValidNamespace(req.params.namespace)) throw notFound();
    const [user] = await sql`SELECT * FROM users WHERE namespace = ${req.params.namespace}`;
    if (!user) throw notFound();
    res.json(userToObject(user));
  });

  function skipTermsForPasswordOnly(req, res, next) {
    const { displayName, password, role } = req.body ?? {};
    if (password !== undefined && displayName === undefined && role === undefined) return next();
    return termsGate(req, res, next);
  }

  router.patch('/:namespace', requireSession, skipTermsForPasswordOnly, async (req, res) => {
    const target = await loadUserOr404(sql, req.params.namespace);
    if (req.auth.user.namespace !== target.namespace && req.auth.user.role !== 'admin') {
      throw forbidden('Only an admin can update another account.');
    }
    requireObjectBody(req);

    const { displayName, password, role } = req.body;
    if (displayName === undefined && password === undefined && role === undefined) {
      throw fieldErrors([{ field: 'body', message: 'Provide at least one field to update.' }]);
    }

    const errors = [];
    if (displayName !== undefined && (typeof displayName !== 'string' || displayName.length > 80)) {
      errors.push({ field: 'displayName', message: 'Must be a string of at most 80 characters.' });
    }
    if (password !== undefined && (typeof password !== 'string' || password.length < 8)) {
      errors.push({ field: 'password', message: 'Password must be at least 8 characters.' });
    }
    if (role !== undefined && role !== 'admin' && role !== 'normal') {
      errors.push({ field: 'role', message: 'Role must be "admin" or "normal".' });
    }
    if (errors.length > 0) throw fieldErrors(errors);

    if (role !== undefined && req.auth.user.role !== 'admin') {
      throw forbidden('Only an admin can change a role.');
    }

    const patch = {};
    const columns = [];
    if (displayName !== undefined) {
      patch.display_name = displayName;
      columns.push('display_name');
    }
    if (role !== undefined) {
      patch.role = role;
      columns.push('role');
    }
    if (password !== undefined) {
      patch.password_hash = await hashPassword(password, config.auth.scrypt);
      columns.push('password_hash');
    }

    const [updated] = await sql.begin(async (tx) => {
      await tx`UPDATE users SET ${sql(patch, columns)} WHERE id = ${target.id}`;
      if (password !== undefined) {
        await tx`DELETE FROM sessions WHERE user_id = ${target.id}`;
        await tx`DELETE FROM automation_tokens WHERE user_id = ${target.id}`;
      }
      return tx`SELECT * FROM users WHERE id = ${target.id}`;
    });

    res.json(userToObject(updated));
  });

  router.delete('/:namespace', requireSession, async (req, res) => {
    const target = await loadUserOr404(sql, req.params.namespace);
    if (req.auth.user.namespace !== target.namespace && req.auth.user.role !== 'admin') {
      throw forbidden('Only an admin can delete another account.');
    }
    await rm(path.join(config.dataDir, 'blobs', target.namespace), {
      recursive: true,
      force: true,
    });
    await sql`DELETE FROM users WHERE id = ${target.id}`;
    res.status(204).end();
  });

  return router;
}

async function loadUserOr404(sql, namespace) {
  if (!isValidNamespace(namespace)) throw notFound();
  const [user] = await sql`SELECT * FROM users WHERE namespace = ${namespace}`;
  if (!user) throw notFound();
  return user;
}
