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
import { uploadOrder, findPhotos, scanOrder } from '../uploader/upload.js';
import Database from 'better-sqlite3';
import { openDb, MIGRATIONS } from '../server/db.js';

const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
let tmp, server, base, close, orderDir, db;
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
  db = created.db;
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

test('scripts and styles are re-checked after updates', async () => {
  const js = await fetch(`${base}/assets/gallery.js`);
  assert.equal(js.headers.get('cache-control'), 'no-cache');
  const css = await fetch(`${base}/assets/app.css`);
  assert.equal(css.headers.get('cache-control'), 'no-cache');
  const img = await fetch(`${base}/assets/jar.png`);
  assert.match(img.headers.get('cache-control'), /max-age=3600/);
});

test('pairs each raw original with its enhanced version', async () => {
  const dir = path.join(tmp, 'FP-3000 Lee');
  await makeImage(path.join(dir, 'Original', 'Album 1', 'scan1.tif'), 1000, 800, '#776655');
  await makeImage(path.join(dir, 'Enhanced', 'Album 1', 'scan1.jpg'), 1000, 800, '#998877');
  await makeImage(path.join(dir, 'Original', 'Album 1', 'Scan2.TIF'), 900, 700, '#665544');
  await makeImage(path.join(dir, 'Enhanced', 'Album 1', 'scan2.jpg'), 900, 700, '#887766');
  await makeImage(path.join(dir, 'Enhanced', 'Shoebox', 'loose.jpg'), 600, 400, '#556677'); // no raw
  await makeImage(path.join(dir, 'Original', 'Shoebox', 'spare.tif'), 600, 400, '#445566'); // no enhanced

  const scan = scanOrder(dir);
  assert.equal(scan.paired, true);
  assert.deepEqual(
    scan.photos.map((p) => [p.folder, p.filename, p.raw?.filename ?? null]),
    [
      ['Album 1', 'scan1.jpg', 'scan1.tif'],
      ['Album 1', 'scan2.jpg', 'Scan2.TIF'],
      ['Shoebox', 'loose.jpg', null],
    ]
  );
  assert.deepEqual(scan.rawOnly, ['Shoebox/spare.tif']);

  const lines = [];
  const result = await uploadOrder({ dir, order: 'FP-3000', title: 'Lee', galleryUrl: base, adminToken: ADMIN_TOKEN, log: (l) => lines.push(l) });
  assert.equal(result.uploaded, 3);
  assert.match(lines.join('\n'), /No original \(raw scan\) found for 1/);
  assert.match(lines.join('\n'), /Shoebox\/spare\.tif/);

  const rows = db
    .prepare(`SELECT p.filename, p.enhanced_key, p.raw_filename, p.raw_key, p.raw_bytes FROM photos p
              JOIN orders o ON o.id = p.order_id WHERE o.code = 'FP-3000' ORDER BY p.filename`)
    .all();
  assert.equal(rows.length, 3);
  assert.match(rows[0].enhanced_key, /^orders\/FP-3000\/enhanced\/[a-f0-9]{64}\.jpg$/);
  assert.match(rows[1].raw_key, /^orders\/FP-3000\/raw\/[a-f0-9]{64}\.tif$/);
  assert.equal(rows[1].raw_filename, 'scan1.tif');
  assert.ok(rows[1].raw_bytes > 0);
  assert.equal(rows[0].raw_key, null); // loose.jpg

  // The raw file really is stored, byte for byte.
  const stored = fs.readFileSync(path.join(tmp, 'data', 'files', rows[1].raw_key));
  assert.ok(stored.equals(fs.readFileSync(path.join(dir, 'Original', 'Album 1', 'scan1.tif'))));

  const again = await uploadOrder({ dir, order: 'FP-3000', galleryUrl: base, adminToken: ADMIN_TOKEN, log: quiet });
  assert.equal(again.skipped, 3);
});

test('an Original folder without an Enhanced folder is refused', () => {
  const dir = path.join(tmp, 'FP-3001');
  fs.mkdirSync(path.join(dir, 'Original', 'Album'), { recursive: true });
  assert.throws(() => scanOrder(dir), /no "Enhanced" folder/);
});

test('a version 1 database upgrades and keeps its photos', () => {
  const dir = path.join(tmp, 'old-db');
  fs.mkdirSync(dir);
  const old = new Database(path.join(dir, 'gallery.sqlite'));
  old.exec(MIGRATIONS[0]);
  old.pragma('user_version = 1');
  old.exec(`INSERT INTO orders (code, title, slug, access_hash) VALUES ('FP-1', 'x', 'fp-1-aaaaaaaa', 'h');
            INSERT INTO source_folders (order_id, name) VALUES (1, 'Album');
            INSERT INTO photos (order_id, source_folder_id, filename, sha256, bytes, original_key, screen_key, thumb_key)
            VALUES (1, 1, 'a.jpg', 'abc', 1, 'orders/FP-1/original/abc.jpg', 's', 't');`);
  old.close();
  const upgraded = openDb(dir);
  const row = upgraded.prepare('SELECT enhanced_key, raw_key FROM photos').get();
  assert.deepEqual({ ...row }, { enhanced_key: 'orders/FP-1/original/abc.jpg', raw_key: null });
  assert.equal(upgraded.pragma('user_version', { simple: true }), MIGRATIONS.length);
  upgraded.close();
});
