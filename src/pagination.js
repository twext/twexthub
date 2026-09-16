import { HttpError } from './errors.js';

export function parseLimit(config, raw) {
  if (raw === undefined) return config.pagination.defaultLimit;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid limit.' });
  }
  const value = Number(raw.trim());
  if (value < 1) throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid limit.' });
  return Math.min(value, config.pagination.maxLimit);
}

export function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(raw, requiredKeys = []) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
  }
  for (const key of requiredKeys) {
    if (parsed[key] === undefined || parsed[key] === null || parsed[key] === '') {
      throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
    }
  }
  return parsed;
}

export function cursorResponse(page, hasMore, keysFromLast) {
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(keysFromLast(last)) : null;
  return { nextCursor, hasMore };
}
