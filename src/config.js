import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { product } from './product.js';
import { normalizeApiRoot } from './util.js';

export const DEFAULTS = {
  port: 3000,
  dataDir: './data',
  apiRoot: product.defaults?.apiRoot ?? '/v0',
  publicBaseUrl: 'http://localhost:3000',
  requireHttps: false,
  trustProxy: false,
  database: {
    url: null,
    maxConnections: 10,
  },
  auth: {
    sessionTtlDays: 7,
    scrypt: { N: 16384, r: 8, p: 1 },
  },
  rateLimits: {
    loginAttemptsPerWindow: 5,
    loginWindowMinutes: 15,
    signupsPerIpPerWindow: 5,
    signupWindowMinutes: 15,
  },
  pagination: {
    defaultLimit: 20,
    maxLimit: 50,
  },
};

function mergeDeep(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base)) return override;
  if (typeof base === 'object' && base !== null) {
    const out = structuredClone(base);
    for (const [key, value] of Object.entries(override)) {
      if (value !== undefined) out[key] = mergeDeep(base[key], value);
    }
    return out;
  }
  return override;
}

const ENV_OVERRIDES = [
  ['port', 'TWEXTHUB_PORT'],
  ['dataDir', 'TWEXTHUB_DATA_DIR'],
  ['apiRoot', 'TWEXTHUB_API_ROOT'],
  ['publicBaseUrl', 'TWEXTHUB_PUBLIC_BASE_URL'],
  ['requireHttps', 'TWEXTHUB_REQUIRE_HTTPS'],
  ['trustProxy', 'TWEXTHUB_TRUST_PROXY'],
  ['database.url', 'TWEXTHUB_DATABASE_URL'],
  ['database.maxConnections', 'TWEXTHUB_DATABASE_MAX_CONNECTIONS'],
  ['auth.sessionTtlDays', 'TWEXTHUB_SESSION_TTL_DAYS'],
  ['rateLimits.loginAttemptsPerWindow', 'TWEXTHUB_LOGIN_ATTEMPTS_PER_WINDOW'],
  ['rateLimits.loginWindowMinutes', 'TWEXTHUB_LOGIN_WINDOW_MINUTES'],
  ['rateLimits.signupsPerIpPerWindow', 'TWEXTHUB_SIGNUPS_PER_IP_PER_WINDOW'],
  ['rateLimits.signupWindowMinutes', 'TWEXTHUB_SIGNUP_WINDOW_MINUTES'],
  ['pagination.defaultLimit', 'TWEXTHUB_PAGINATION_DEFAULT_LIMIT'],
  ['pagination.maxLimit', 'TWEXTHUB_PAGINATION_MAX_LIMIT'],
];

function coerceEnvValue(raw, current, envName) {
  if (typeof current === 'boolean') {
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    throw new Error(`${envName} must be "true" or "false" (got "${raw}")`);
  }
  if (typeof current === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n)) throw new Error(`${envName} must be a number (got "${raw}")`);
    return n;
  }
  return raw;
}

function coerceTrustProxy(raw) {
  if (raw === 'true') return true;
  if (raw === 'false' || raw === '0') return false;
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);
  return raw;
}

function applyEnvOverrides(config) {
  for (const [key, envName] of ENV_OVERRIDES) {
    const raw = process.env[envName];
    if (raw === undefined) continue;
    const parts = key.split('.');
    const target = parts.slice(0, -1).reduce((acc, part) => acc[part], config);
    const last = parts[parts.length - 1];
    if (key === 'trustProxy') {
      target[last] = coerceTrustProxy(raw);
      continue;
    }
    target[last] = coerceEnvValue(raw, target[last], envName);
  }
}

export function loadConfig(configPath = product.defaults?.configFilename ?? 'config.yaml') {
  let raw = {};
  if (existsSync(configPath)) {
    const parsed = YAML.parse(readFileSync(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object') raw = parsed;
  }
  const config = mergeDeep(DEFAULTS, raw);
  applyEnvOverrides(config);
  config.apiRoot = normalizeApiRoot(config.apiRoot);
  if (!config.database.url) {
    throw new Error(
      `config.yaml: database.url is required (edit ${configPath} or pass a file via --config)`,
    );
  }
  config.dataDir = path.resolve(process.cwd(), config.dataDir);
  return config;
}
