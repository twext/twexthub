import { HttpError } from './errors.js';

const CURSOR_KEY_TYPES = {
  int: (value) => {
    let n;
    if (typeof value === 'number') n = value;
    else if (typeof value === 'string' && /^[0-9]+$/.test(value)) n = Number(value);
    else return null;
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  },
  timestamp: (value) => {
    if (typeof value !== 'string') return null;
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  },
  string: (value) => (typeof value === 'string' && value.length > 0 ? value : null),
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
    const value = CURSOR_KEY_TYPES[type]?.(parsed[key]);
    if (value === null || value === undefined) {
      throw new HttpError(400, { title: 'Bad Request', detail: 'Invalid cursor.' });
    }
    parsed[key] = value;
  }
  return parsed;
}
