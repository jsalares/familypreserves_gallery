// Runs the real app on local storage, uploads a small order folder with the
// upload tool, then signs in and checks the gallery like a customer would.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import sharp from 'sharp';
import { loadConfig } from '../server/config.js';
import { createApp } from '../server/app.js';
import { uploadOrder, findPhotos } from '../uploader/upload.js';

const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
let tmp, server, base, close, orderDir;
const quiet = () => {};

async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function makeImage(file, width, height, color) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width, height, channels: 3, background: color } }).jpeg().toFile(file);
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-gallery-'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    SESSION_SECRET: 's'.repeat(48),
    ADMIN_TOKEN,
    STORAGE: 'local',
    DATA_DIR: path.join(tmp, 'data'),
    PUBLIC_URL: base,
    PORT: String(port),
  });
  const created = createApp(config);
  close = created.close;
  await new Promise((resolve) => (server = created.app.listen(port, '127.0.0.1', resolve)));

  orderDir = path.join(tmp, 'FP-1042 Martin');
  await makeImage(path.join(orderDir, 'Album 1', 'scan10.jpg'), 3000, 2000, '#a08a68');
  await makeImage(path.join(orderDir, 'Album 1', 'scan2.jpg'), 1200, 1600, '#6f7f72');
  await makeImage(path.join(orderDir, 'Shoebox', 'old.jpg'), 800, 600, '#9c7458');
  await makeImage(path.join(orderDir, 'loose.jpg'), 640, 480, '#5f6f80');
  fs.writeFileSync(path.join(orderDir, 'Album 1', 'notes.txt'), 'not a photo');
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('finds photos in natural order and ignores other files', () => {
  const found = findPhotos(orderDir).map((p) => `${p.folder}/${p.filename}`);
  assert.deepEqual(found, ['Album 1/scan2.jpg', 'Album 1/scan10.jpg', 'Other photos/loose.jpg', 'Shoebox/old.jpg']);
});

let access;

test('admin API refuses a wrong token', async () => {
  const res = await fetch(`${base}/api/admin/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    body: JSON.stringify({ code: 'FP-1', title: 'x' }),
  });
  assert.equal(res.status, 401);
});

test('uploads an order and creates its gallery link and code', async () => {
  const result = await uploadOrder({
    dir: orderDir,
    order: 'fp-1042',
    title: 'The Martin Family Collection',
    galleryUrl: base,
    adminToken: ADMIN_TOKEN,
    log: quiet,
  });
  assert.equal(result.uploaded, 4);
  assert.equal(result.failed.length, 0);
  assert.match(result.url, new RegExp(`^${base}/g/fp-1042-[a-z2-9]{8}$`));
  assert.ok(result.accessCode);
  assert.match(fs.readFileSync(path.join(orderDir, 'gallery-access.txt'), 'utf8'), new RegExp(result.accessCode));
  access = result;
});

test('running the upload again skips everything already there', async () => {
  const again = await uploadOrder({ dir: orderDir, order: 'FP-1042', galleryUrl: base, adminToken: ADMIN_TOKEN, log: quiet });
  assert.equal(again.uploaded, 0);
  assert.equal(again.skipped, 4);
  assert.equal(again.accessCode, undefined, 'the access code is not shown again');
});

test('the gallery asks for the code, then shows the photos', async () => {
  const page = await fetch(access.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Access code/);

  const slug = access.url.split('/').pop();
  const apiBase = `${base}/api/g/${slug}`;
  assert.equal((await fetch(`${apiBase}/gallery`)).status, 401);

  const wrong = await fetch(`${apiBase}/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'WRONG-0000' }),
  });
  assert.equal(wrong.status, 401);

  const right = await fetch(`${apiBase}/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: access.accessCode.toLowerCase() }),
  });
  assert.equal(right.status, 200);
  const cookie = right.headers.get('set-cookie').split(';')[0];
  assert.match(right.headers.get('set-cookie'), /HttpOnly/);

  const galleryPage = await fetch(access.url, { headers: { cookie } });
  assert.match(await galleryPage.text(), /gallery\.js/);

  const data = await (await fetch(`${apiBase}/gallery`, { headers: { cookie } })).json();
  assert.equal(data.order.title, 'The Martin Family Collection');
  assert.deepEqual(data.folders, [
    { name: 'Album 1', count: 2 },
    { name: 'Other photos', count: 1 },
    { name: 'Shoebox', count: 1 },
  ]);
  assert.deepEqual(data.photos.map((p) => p.filename), ['scan2.jpg', 'scan10.jpg', 'loose.jpg', 'old.jpg']);

  // Screen copies are shrunk to 2048 px; thumbnails to 480 px.
  const big = data.photos[1];
  assert.deepEqual([big.width, big.height], [3000, 2000]);
  const screen = await sharp(Buffer.from(await (await fetch(big.screen)).arrayBuffer())).metadata();
  assert.equal(Math.max(screen.width, screen.height), 2048);
  const thumb = await sharp(Buffer.from(await (await fetch(big.thumb)).arrayBuffer())).metadata();
  assert.equal(Math.max(thumb.width, thumb.height), 480);

  // A file link without its signature is refused.
  assert.equal((await fetch(big.thumb.split('?')[0])).status, 403);
});

test('wrong codes lock the gallery for that address after five tries', async () => {
  const slug = access.url.split('/').pop();
  const tryCode = (code) =>
    fetch(`${base}/api/g/${slug}/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  for (let i = 0; i < 5; i++) await tryCode('WRONG-1111');
  const locked = await tryCode(access.accessCode);
  assert.equal(locked.status, 429, 'even the right code waits during the lockout');
});

test('unknown galleries show a friendly not-found page', async () => {
  const res = await fetch(`${base}/g/fp-9999-aaaaaaaa`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /couldn't find that gallery/);
});
