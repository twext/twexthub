import { HttpError } from './errors.js';

const CURSOR_KEY_TYPES = {
  int: (value) =>
    (typeof value === 'number' || typeof value === 'string') &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0,
  timestamp: (value) => typeof value === 'string' && !Number.isNaN(Date.parse(value)),
  string: (value) => typeof value === 'string' && value.length > 0,
};

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

export function decodeCursor(raw, requiredKeys = {}) {
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
  for (const [key, type] of Object.entries(requiredKeys)) {
    const value = parsed[key];
    if (value === undefined || value === null || !CURSOR_KEY_TYPES[type](value)) {
      throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
    }
  }
  return parsed;
}
