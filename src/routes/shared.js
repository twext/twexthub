import { forbidden, HttpError, notFound } from '../errors.js';
import { isPlainObject } from '../util.js';

export function requireObjectBody(req) {
  if (!isPlainObject(req.body)) {
    throw new HttpError(422, {
      title: 'Validation Error',
      detail: 'Request body must be a JSON object.',
    });
  }
}

export async function resolveTargetUser(sql, req) {
  const me = req.auth.user;
  const ns = req.query.namespace;
  if (ns === undefined) return me;
  if (typeof ns !== 'string') {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid namespace parameter.' });
  }
  if (me.role !== 'admin' && ns !== me.namespace) {
    throw forbidden('Only an admin can inspect another account.');
  }
  const [user] = await sql`SELECT * FROM users WHERE namespace = ${ns}`;
  if (!user) throw notFound('No such user.');
  return user;
}
