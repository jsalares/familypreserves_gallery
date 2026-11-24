import crypto from 'node:crypto';

// Short, easy-to-type words for access codes (no look-alike letters, nothing awkward).
const WORDS = [
  'APPLE', 'BIRCH', 'CEDAR', 'CLOVER', 'CORAL', 'DAISY', 'EMBER', 'FERN', 'GARNET', 'HAZEL',
  'HONEY', 'IVORY', 'JADE', 'JUNIPER', 'LAUREL', 'LILAC', 'MAPLE', 'MEADOW', 'MINT', 'OAK',
  'OLIVE', 'ORCHID', 'PEARL', 'PINE', 'POPPY', 'RAVEN', 'RIVER', 'ROBIN', 'SAGE', 'SPRUCE',
  'STONE', 'SUNNY', 'TULIP', 'VIOLET', 'WILLOW', 'WREN',
];

export function generateAccessCode() {
  const word = WORDS[crypto.randomInt(WORDS.length)];
  const digits = String(crypto.randomInt(10000)).padStart(4, '0');
  return `${word}-${digits}`;
}

// Customers may type the code in any case, with or without the dash or spaces.
export function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function hashAccessCode(code) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalizeCode(code), salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyAccessCode(code, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = crypto.scryptSync(normalizeCode(code), Buffer.from(saltB64, 'base64url'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// The random tail makes gallery links impossible to guess from the order number.
export function generateSlug(orderCode) {
  const base = String(orderCode).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let tail = '';
  for (let i = 0; i < 8; i++) tail += alphabet[crypto.randomInt(alphabet.length)];
  return `${base}-${tail}`;
}

// ---- Signed values (session cookies and local file links) ----

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function sign(secret, payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, body)}`;
}

export function unsign(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(hmac(secret, body));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export const SESSION_DAYS = 60;

export function sessionCookieName(orderId) {
  return `fpg_${orderId}`;
}

export function makeSession(secret, orderId, now = Date.now()) {
  return sign(secret, { o: orderId, exp: now + SESSION_DAYS * 24 * 3600 * 1000 });
}

export function readSession(secret, token, orderId, now = Date.now()) {
  const data = unsign(secret, token);
  return Boolean(data && data.o === orderId && typeof data.exp === 'number' && data.exp > now);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    if (name) out[name] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- Wrong-code lockout ----
// After MAX_FAILURES wrong codes for one gallery from one address, that address
// waits LOCK_MINUTES before it can try again.

export const MAX_FAILURES = 5;
export const LOCK_MINUTES = 15;

export function createLimiter({ maxFailures = MAX_FAILURES, lockMinutes = LOCK_MINUTES } = {}) {
  const entries = new Map();
  const lockMs = lockMinutes * 60 * 1000;
  return {
    check(key, now = Date.now()) {
      const e = entries.get(key);
      if (e && e.lockedUntil > now) return { allowed: false, retryAfterSec: Math.ceil((e.lockedUntil - now) / 1000) };
      return { allowed: true };
    },
    fail(key, now = Date.now()) {
      const e = entries.get(key) || { failures: 0, lockedUntil: 0 };
      if (e.lockedUntil && e.lockedUntil <= now) e.failures = 0;
      e.failures += 1;
      if (e.failures >= maxFailures) e.lockedUntil = now + lockMs;
      entries.set(key, e);
    },
    succeed(key) {
      entries.delete(key);
    },
  };
}
