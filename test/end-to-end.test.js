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

let access, cookie, apiBase;

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
  apiBase = `${base}/api/g/${slug}`;
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
  cookie = right.headers.get('set-cookie').split(';')[0];
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

const send = (changes, withCookie = true) =>
  fetch(`${apiBase}/changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(withCookie ? { cookie } : {}) },
    body: JSON.stringify({ changes }),
  });
const gallery = async () => (await fetch(`${apiBase}/gallery`, { headers: { cookie } })).json();

test('customers can sort photos into custom folders and add details', async () => {
  assert.equal((await send([{ op: 'folder.create', name: 'Christmas' }], false)).status, 401);

  const before = await gallery();
  const [a, b, c] = before.photos.map((p) => p.id);
  const changes = [
    { op: 'folder.create', name: '  Christmas  ' },
    { op: 'photo.folder', photoId: a, name: 'Christmas', on: true },
    { op: 'photo.folder', photoId: a, name: 'Christmas', on: true }, // repeat is harmless
    { op: 'photo.folder', photoId: b, name: 'Cottage', on: true }, // creates the folder
    { op: 'photo.folder', photoId: c, name: 'Christmas', on: true },
    { op: 'photo.folder', photoId: c, name: 'Christmas', on: false },
    { op: 'photo.person', photoId: a, name: 'Grandma Rose', on: true },
    { op: 'photo.person', photoId: b, name: 'Grandma Rose', on: true },
    { op: 'photo.person', photoId: b, name: 'Uncle Pete', on: true },
    { op: 'photo.person', photoId: b, name: 'Uncle Pete', on: false },
    { op: 'photo.field', photoId: a, field: 'year', value: ' 1985 ' },
    { op: 'photo.field', photoId: a, field: 'caption', value: 'First snow' },
    { op: 'photo.field', photoId: a, field: 'owner', value: 'x' },
    { op: 'photo.enhance', photoId: b, on: true },
    { op: 'photo.folder', photoId: 999999, name: 'Christmas', on: true },
  ];
  const { results } = await (await send(changes)).json();
  assert.equal(results.length, changes.length);
  assert.deepEqual(
    results.map((r) => r.ok),
    [true, true, true, true, true, true, true, true, true, true, true, true, false, true, false]
  );

  const after = await gallery();
  assert.deepEqual(after.customFolders, ['Christmas', 'Cottage']);
  assert.deepEqual(after.people, ['Grandma Rose', 'Uncle Pete']);
  const byId = new Map(after.photos.map((p) => [p.id, p]));
  assert.deepEqual(byId.get(a).customFolders, ['Christmas']);
  assert.deepEqual(byId.get(b).customFolders, ['Cottage']);
  assert.deepEqual(byId.get(c).customFolders, []);
  assert.deepEqual(byId.get(a).people, ['Grandma Rose']);
  assert.deepEqual(byId.get(b).people, ['Grandma Rose']);
  assert.equal(byId.get(a).year, '1985');
  assert.equal(byId.get(a).caption, 'First snow');
  assert.equal(byId.get(b).enhance, true);
  assert.equal(byId.get(a).enhance, false);

  // Deleting a custom folder removes the copies, never the photos.
  await send([{ op: 'folder.delete', name: 'Christmas' }]);
  const later = await gallery();
  assert.deepEqual(later.customFolders, ['Cottage']);
  assert.equal(later.photos.length, 4);
  assert.deepEqual(later.photos.find((p) => p.id === a).customFolders, []);
});

test('custom folders stop at eight, and other galleries are off limits', async () => {
  const names = Array.from({ length: 9 }, (_, i) => `Folder ${i + 1}`);
  const { results } = await (await send(names.map((name) => ({ op: 'folder.create', name })))).json();
  // "Cottage" already exists, so seven more fit.
  assert.deepEqual(results.map((r) => r.ok), [true, true, true, true, true, true, true, false, false]);
  assert.match(results[7].error, /up to 8/);
  assert.equal((await gallery()).customFolders.length, 8);

  const tooMany = await send(Array.from({ length: 201 }, () => ({ op: 'folder.create', name: 'x' })));
  assert.equal(tooMany.status, 400);

  // A second order's photo cannot be changed from this gallery.
  const other = path.join(tmp, 'FP-2000');
  await makeImage(path.join(other, 'Box', 'a.jpg'), 400, 300, '#888888');
  await uploadOrder({ dir: other, order: 'FP-2000', title: 'Other', galleryUrl: base, adminToken: ADMIN_TOKEN, log: quiet });
  const ids = new Set((await gallery()).photos.map((p) => p.id));
  const foreignId = Math.max(...ids) + 1;
  const res = await (await send([{ op: 'photo.enhance', photoId: foreignId, on: true }])).json();
  assert.equal(res.results[0].ok, false);
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
