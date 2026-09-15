import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export async function hashPassword(password, { N, r, p }) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N, r, p, maxmem: 256 * N * r });
  return `${N}:${r}:${p}:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const parts = stored.split(':');
  if (parts.length !== 5) return false;
  const [N, r, p, saltHex, keyHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(keyHex, 'hex');
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 256 * Number(N) * Number(r),
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
