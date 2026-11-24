import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateAccessCode,
  hashAccessCode,
  verifyAccessCode,
  generateSlug,
  sign,
  unsign,
  makeSession,
  readSession,
  createLimiter,
} from '../server/auth.js';
import { assertSafeKey } from '../server/storage.js';

const SECRET = 'x'.repeat(40);

test('access codes are easy to type and verify regardless of case or spacing', () => {
  const code = generateAccessCode();
  assert.match(code, /^[A-Z]+-\d{4}$/);
  const stored = hashAccessCode(code);
  assert.ok(!stored.includes(code), 'the code itself is never stored');
  assert.ok(verifyAccessCode(code, stored));
  assert.ok(verifyAccessCode(code.toLowerCase().replace('-', ' '), stored));
  assert.ok(!verifyAccessCode('PINE-0000', hashAccessCode('PINE-0001')));
  assert.ok(!verifyAccessCode(code, 'garbage'));
});

test('gallery links cannot be guessed from the order number', () => {
  const a = generateSlug('FP-1042');
  const b = generateSlug('FP-1042');
  assert.match(a, /^fp-1042-[a-z2-9]{8}$/);
  assert.notEqual(a, b);
});

test('signed values reject tampering', () => {
  const token = sign(SECRET, { o: 1 });
  assert.deepEqual(unsign(SECRET, token), { o: 1 });
  assert.equal(unsign('y'.repeat(40), token), null);
  assert.equal(unsign(SECRET, token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))), null);
  assert.equal(unsign(SECRET, 'nonsense'), null);
});

test('sessions belong to one gallery and expire after 60 days', () => {
  const now = Date.now();
  const s = makeSession(SECRET, 7, now);
  assert.ok(readSession(SECRET, s, 7, now));
  assert.ok(!readSession(SECRET, s, 8, now), 'not valid for another order');
  assert.ok(readSession(SECRET, s, 7, now + 59 * 86400e3));
  assert.ok(!readSession(SECRET, s, 7, now + 61 * 86400e3));
});

test('five wrong codes lock that address out for 15 minutes', () => {
  const limiter = createLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 4; i++) limiter.fail('k', t0);
  assert.ok(limiter.check('k', t0).allowed);
  limiter.fail('k', t0);
  const blocked = limiter.check('k', t0 + 1000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 14 * 60);
  assert.ok(limiter.check('k', t0 + 15 * 60e3 + 1).allowed);
  assert.ok(limiter.check('other', t0).allowed, 'other galleries and addresses are unaffected');
});

test('storage keys cannot escape their folder', () => {
  assert.equal(assertSafeKey('orders/FP-1/original/abc.jpg'), 'orders/FP-1/original/abc.jpg');
  for (const bad of ['../x', 'orders/../x', '/orders/x', 'orders\\x', 'orders//x', 'orders/x\n', '']) {
    assert.throws(() => assertSafeKey(bad), /Bad storage key/, bad);
  }
});
