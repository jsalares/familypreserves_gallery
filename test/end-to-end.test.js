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
import yauzl from 'yauzl';
import { exiftool } from 'exiftool-vendored';
import { orientationAfterTurn, tagsFor, safeName } from '../server/download.js';
import { openDb, MIGRATIONS } from '../server/db.js';
import { todayLocal, addDays, isExpired } from '../server/app.js';
import { KEEP_BACKUPS } from '../server/backup.js';

const ADMIN_TOKEN = 'test-admin-token-0123456789abcdef';
let tmp, server, base, close, orderDir, db, backups;
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
  backups = created.backups;
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
  await close();
  await exiftool.end();
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

test('custom folders have no practical limit, and other galleries are off limits', async () => {
  const names = Array.from({ length: 20 }, (_, i) => `Folder ${i + 1}`);
  const { results } = await (await send(names.map((name) => ({ op: 'folder.create', name })))).json();
  assert.ok(results.every((r) => r.ok));
  assert.equal((await gallery()).customFolders.length, 21); // plus "Cottage"

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

test('backs go with their fronts, and raw folders upload untouched', async () => {
  const dir = path.join(tmp, 'FP-3000 Lee');
  await makeImage(path.join(dir, 'Album 1', 'scan1.jpg'), 1000, 800, '#998877');
  await makeImage(path.join(dir, 'Album 1', 'scan1_b.jpg'), 1000, 800, '#ddddcc');
  await makeImage(path.join(dir, 'Album 1', 'scan2.jpg'), 900, 700, '#887766');
  await makeImage(path.join(dir, 'Album 1', 'stray_b.jpg'), 600, 400, '#556677'); // no front
  fs.mkdirSync(path.join(dir, 'Album 1', 'raw'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Album 1', 'raw', 'scan1.tif'), 'raw front bytes');
  fs.writeFileSync(path.join(dir, 'Album 1', 'raw', 'notes.xmp'), 'any file in raw is kept');
  fs.mkdirSync(path.join(dir, 'RAW', 'Box'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'RAW', 'Box', 'b.tif'), 'order-level raw');

  const scan = scanOrder(dir);
  assert.deepEqual(
    scan.photos.map((p) => [p.folder, p.filename, p.back?.filename ?? null]),
    [
      ['Album 1', 'scan1.jpg', 'scan1_b.jpg'],
      ['Album 1', 'scan2.jpg', null],
      ['Album 1', 'stray_b.jpg', null],
    ]
  );
  assert.deepEqual(scan.raws.map((r) => r.path), ['Album 1/raw/notes.xmp', 'Album 1/raw/scan1.tif', 'RAW/Box/b.tif']);
  assert.match(scan.warnings.join('\n'), /stray_b\.jpg looks like the back/);

  const result = await uploadOrder({ dir, order: 'FP-3000', title: 'Lee', galleryUrl: base, adminToken: ADMIN_TOKEN, log: quiet });
  assert.equal(result.uploaded, 3);
  assert.equal(result.rawUploaded, 3);
  assert.equal(result.failed.length, 0);

  const raws = db.prepare(`SELECT r.path, r.key, r.bytes FROM raw_files r JOIN orders o ON o.id = r.order_id WHERE o.code = 'FP-3000' ORDER BY r.path`).all();
  assert.equal(raws.length, 3);
  assert.match(raws[1].key, /^orders\/FP-3000\/raw\/[a-f0-9]{64}\.tif$/);
  assert.equal(fs.readFileSync(path.join(tmp, 'data', 'files', raws[1].key), 'utf8'), 'raw front bytes');

  const again = await uploadOrder({ dir, order: 'FP-3000', galleryUrl: base, adminToken: ADMIN_TOKEN, log: quiet });
  assert.equal(again.skipped, 3);
  assert.equal(again.rawSkipped, 3);

  // The customer sees the back with its photo, and can turn each side.
  const reset = await fetch(`${base}/api/admin/orders/FP-3000/reset-code`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const { accessCode, order } = await reset.json();
  const slug = order.url.split('/').pop();
  const signIn = await fetch(`${base}/api/g/${slug}/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.9' },
    body: JSON.stringify({ code: accessCode }),
  });
  assert.equal(signIn.status, 200);
  const leeCookie = signIn.headers.get('set-cookie').split(';')[0];
  const load = async () => (await fetch(`${base}/api/g/${slug}/gallery`, { headers: { cookie: leeCookie } })).json();
  const data = await load();
  const [front, plain] = data.photos;
  assert.equal(front.back.filename, 'scan1_b.jpg');
  assert.ok(front.back.screen && front.back.thumb);
  assert.equal(plain.back, null);
  assert.equal(front.rotation, 0);

  const change = async (changes) =>
    (await (await fetch(`${base}/api/g/${slug}/changes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: leeCookie },
      body: JSON.stringify({ changes }),
    })).json()).results;
  const results = await change([
    { op: 'photo.rotate', photoId: front.id, side: 'front', degrees: 90 },
    { op: 'photo.rotate', photoId: front.id, side: 'back', degrees: 270 },
    { op: 'photo.rotate', photoId: plain.id, side: 'back', degrees: 90 },
    { op: 'photo.rotate', photoId: plain.id, side: 'front', degrees: 45 },
  ]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, false, false]);
  const after = await load();
  assert.equal(after.photos[0].rotation, 90);
  assert.equal(after.photos[0].back.rotation, 270);

  // Re-running the upload keeps the customer's turns.
  await uploadOrder({ dir, order: 'FP-3000', galleryUrl: base, adminToken: ADMIN_TOKEN, log: quiet });
  const kept = await load();
  assert.equal(kept.photos[0].rotation, 90);
  assert.equal(kept.photos[0].back.rotation, 270);
});

function unzip(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const files = new Map();
      zip.on('entry', (entry) => {
        zip.openReadStream(entry, (err2, stream) => {
          if (err2) return reject(err2);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            files.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(files));
      zip.on('error', reject);
      zip.readEntry();
    });
  });
}

test('the zip download has enhanced photos with details, copies, and untouched raw scans', async () => {
  const reset = await fetch(`${base}/api/admin/orders/FP-3000/reset-code`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const { accessCode, order } = await reset.json();
  const slug = order.url.split('/').pop();
  const signIn = await fetch(`${base}/api/g/${slug}/sign-in`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: accessCode }),
  });
  const ck = signIn.headers.get('set-cookie').split(';')[0];
  const data = await (await fetch(`${base}/api/g/${slug}/gallery`, { headers: { cookie: ck } })).json();
  assert.deepEqual(data.raw, { files: 3, bytes: fs.statSync(path.join(tmp, 'FP-3000 Lee', 'Album 1', 'raw', 'scan1.tif')).size + 23 + 15 });
  const [front, plain] = data.photos;
  assert.ok(front.bytes > plain.bytes, 'a photo with a back counts both files');

  await fetch(`${base}/api/g/${slug}/changes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ck },
    body: JSON.stringify({
      changes: [
        { op: 'photo.folder', photoId: front.id, name: 'Christmas', on: true },
        { op: 'photo.person', photoId: front.id, name: 'Grandma Rose', on: true },
        { op: 'photo.field', photoId: front.id, field: 'year', value: 'about 1962' },
        { op: 'photo.field', photoId: front.id, field: 'caption', value: 'Café on the lake' },
        { op: 'photo.field', photoId: front.id, field: 'place', value: 'Lac Philippe' },
        { op: 'photo.field', photoId: front.id, field: 'event', value: 'Summer trip' },
      ],
    }),
  });

  assert.equal((await fetch(`${base}/api/g/${slug}/download?raw=1`)).status, 401, 'needs the access code');
  assert.equal((await fetch(`${base}/api/g/${slug}/download`, { headers: { cookie: ck } })).status, 400, 'nothing chosen');

  const res = await fetch(`${base}/api/g/${slug}/download?raw=1&scanned=Album%201&custom=Christmas`, { headers: { cookie: ck } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /FP-3000%20Lee\.zip/);
  const files = await unzip(Buffer.from(await res.arrayBuffer()));
  const names = [...files.keys()].sort();
  assert.deepEqual(names, [
    'FP-3000 Lee/Enhanced/Album 1/scan1.jpg',
    'FP-3000 Lee/Enhanced/Album 1/scan1_b.jpg',
    'FP-3000 Lee/Enhanced/Album 1/scan2.jpg',
    'FP-3000 Lee/Enhanced/Album 1/stray_b.jpg',
    'FP-3000 Lee/My custom folders/Christmas/scan1.jpg',
    'FP-3000 Lee/My custom folders/Christmas/scan1_b.jpg',
    'FP-3000 Lee/Raw scans/Album 1/notes.xmp',
    'FP-3000 Lee/Raw scans/Album 1/scan1.tif',
    'FP-3000 Lee/Raw scans/Box/b.tif',
  ]);
  // Raw scans are byte for byte what was uploaded.
  assert.equal(files.get('FP-3000 Lee/Raw scans/Album 1/scan1.tif').toString(), 'raw front bytes');

  // The enhanced front carries the details and its turn (90 degrees -> orientation 6).
  const out = path.join(tmp, 'check-front.jpg');
  fs.writeFileSync(out, files.get('FP-3000 Lee/My custom folders/Christmas/scan1.jpg'));
  const tags = await exiftool.read(out, ['-G1', '-n']);
  const t = (name) => Object.entries(tags).find(([k]) => k === name || k.endsWith(`:${name}`))?.[1];
  assert.equal(t('Orientation'), 6);
  assert.equal(String(t('DateTimeOriginal')).slice(0, 4), '1962');
  assert.equal(t('Description'), 'Café on the lake');
  assert.equal(t('Location'), 'Lac Philippe');
  assert.equal(t('Event'), 'Summer trip');
  assert.deepEqual([t('PersonInImage')].flat(), ['Grandma Rose']);
  assert.deepEqual([t('Subject')].flat().sort(), ['Christmas', 'Grandma Rose', 'Summer trip']);
  // The back has its own turn (270 -> orientation 8).
  fs.writeFileSync(out, files.get('FP-3000 Lee/Enhanced/Album 1/scan1_b.jpg'));
  assert.equal((await exiftool.read(out, ['-n'])).Orientation, 8);
  // A photo with nothing to add is left as uploaded.
  fs.writeFileSync(out, files.get('FP-3000 Lee/Enhanced/Album 1/scan2.jpg'));
  assert.equal((await exiftool.read(out, ['-n'])).Orientation, undefined);

  // Only the raw scans.
  const rawOnly = await unzip(Buffer.from(await (await fetch(`${base}/api/g/${slug}/download?raw=1`, { headers: { cookie: ck } })).arrayBuffer()));
  assert.equal([...rawOnly.keys()].every((n) => n.startsWith('FP-3000 Lee/Raw scans/')), true);
});

test('download helpers: turns, tags and safe names', () => {
  assert.equal(orientationAfterTurn(undefined, 90), 6);
  assert.equal(orientationAfterTurn(6, 90), 3);
  assert.equal(orientationAfterTurn(8, 90), 1);
  assert.equal(orientationAfterTurn(2, 90), 2, 'mirrored is left alone');
  const tags = tagsFor({ year: '1970s', caption: '', place: '', event: '', people: [], customFolders: [] });
  assert.deepEqual(tags, {}, 'no exact year, nothing to write');
  assert.equal(tagsFor({ year: 'Summer 1985', caption: '', place: '', event: '', people: [], customFolders: [] })['XMP-photoshop:DateCreated'], '1985');
  assert.equal(safeName('Mom & Dad: 1980/81?'), 'Mom & Dad_ 1980_81_');
});

test('raw file paths cannot climb out of the order', async () => {
  const res = await fetch(`${base}/api/admin/orders/FP-3000/raw-files`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ files: [{ path: '../x.tif', sha256: 'a'.repeat(64), bytes: 1, key: `orders/FP-3000/raw/${'a'.repeat(64)}.tif` }] }),
  });
  assert.equal(res.status, 400);
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
  const row = upgraded.prepare('SELECT enhanced_key, rotation FROM photos').get();
  assert.deepEqual({ ...row }, { enhanced_key: 'orders/FP-1/original/abc.jpg', rotation: 0 });
  assert.equal(upgraded.pragma('user_version', { simple: true }), MIGRATIONS.length);
  upgraded.close();
});

// ---------------------------------------------------------------- step 5: admin

async function adminCall(method, url, body, headers = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})), res };
}
const bearer = { authorization: `Bearer ${ADMIN_TOKEN}` };

test('the admin page needs the admin token, then works with a cookie', async () => {
  const page = await fetch(`${base}/admin`);
  assert.match(await page.text(), /Admin sign-in/);
  assert.equal((await adminCall('GET', '/api/admin/overview')).status, 401);
  assert.equal((await adminCall('POST', '/api/admin-session', { token: 'wrong' })).status, 401);

  const ok = await adminCall('POST', '/api/admin-session', { token: ADMIN_TOKEN });
  assert.equal(ok.status, 200);
  const cookie = ok.res.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const jar = { cookie: cookie.split(';')[0] };
  assert.match(await (await fetch(`${base}/admin`, { headers: jar })).text(), /id="orders"/);
  const { status, data } = await adminCall('GET', '/api/admin/overview', null, jar);
  assert.equal(status, 200);
  const martin = data.orders.find((o) => o.code === 'FP-1042');
  assert.ok(martin.photos > 0);
  assert.ok(martin.folders.some((f) => f.name === 'Album 1'));
  assert.equal(data.galleryDays, 90);
});

test('new galleries get an end date, and closed galleries show the closed page', async () => {
  const { data } = await adminCall('POST', '/api/admin/orders', { code: 'FP-5000', title: 'Expiry test' }, bearer);
  const { data: all } = await adminCall('GET', '/api/admin/overview', null, bearer);
  const o = all.orders.find((x) => x.code === 'FP-5000');
  assert.equal(o.expiresOn, addDays(todayLocal(), 90));
  assert.equal(o.expired, false);

  const yesterday = addDays(todayLocal(), -1);
  assert.equal((await adminCall('POST', '/api/admin/orders/FP-5000/expiry', { expiresOn: yesterday }, bearer)).data.expired, true);
  assert.equal((await fetch(data.order.url)).status, 410);
  // The end date itself is still open: it closes the next morning.
  await adminCall('POST', '/api/admin/orders/FP-5000/expiry', { expiresOn: todayLocal() }, bearer);
  assert.equal((await fetch(data.order.url)).status, 200);
  await adminCall('POST', '/api/admin/orders/FP-5000/expiry', { expiresOn: null }, bearer);
  assert.equal((await fetch(data.order.url)).status, 200);
  assert.equal((await adminCall('POST', '/api/admin/orders/FP-5000/expiry', { expiresOn: 'soon' }, bearer)).status, 400);

  assert.equal(isExpired({ expires_at: '2026-11-24' }, new Date('2026-11-25T04:30:00Z')), false, '11:30 PM in Ottawa');
  assert.equal(isExpired({ expires_at: '2026-11-24' }, new Date('2026-11-25T05:30:00Z')), true, '12:30 AM in Ottawa');
});

test('deleting a scanned folder removes its photos and only the files nothing else uses', async () => {
  const dir = path.join(tmp, 'FP-6000');
  await makeImage(path.join(dir, 'Kay', 'a.jpg'), 600, 400, '#336699');
  await makeImage(path.join(dir, 'Kay', 'a_b.jpg'), 600, 400, '#eeeeee');
  await makeImage(path.join(dir, 'Kay', 'b.jpg'), 600, 400, '#996633');
  // The mistake from the old upload tool: the raw folder as an album, with an
  // identical copy of the back.
  fs.mkdirSync(path.join(dir, 'Oops'), { recursive: true });
  fs.copyFileSync(path.join(dir, 'Kay', 'a_b.jpg'), path.join(dir, 'Oops', 'a_b.jpg'));
  await makeImage(path.join(dir, 'Oops', 'c.jpg'), 600, 400, '#663399');
  await uploadOrder({ dir, order: 'FP-6000', title: 'Delete test', galleryUrl: base, adminToken: ADMIN_TOKEN, log: quiet });

  const files = () => fs.readdirSync(path.join(tmp, 'data', 'files', 'orders', 'FP-6000', 'enhanced')).length;
  assert.equal(files(), 4); // a, a_b (shared), b, c

  const wrong = await adminCall('DELETE', '/api/admin/orders/FP-6000/folders', { folder: 'Oops', confirm: 'nope' }, bearer);
  assert.equal(wrong.status, 400);
  const { status, data } = await adminCall('DELETE', '/api/admin/orders/FP-6000/folders', { folder: 'Oops', confirm: 'fp-6000' }, bearer);
  assert.equal(status, 200);
  assert.equal(data.photosDeleted, 2);
  assert.equal(files(), 3, 'c is gone; the back shared with Kay/a stays');

  const { data: all } = await adminCall('GET', '/api/admin/overview', null, bearer);
  assert.deepEqual(all.orders.find((o) => o.code === 'FP-6000').folders, [{ name: 'Kay', photos: 2 }]);
});

test('deleting a gallery removes it and all its files', async () => {
  const before = await adminCall('GET', '/api/admin/overview', null, bearer);
  const url = before.data.orders.find((o) => o.code === 'FP-6000').url;
  assert.equal((await adminCall('DELETE', '/api/admin/orders/FP-6000', { confirm: 'FP-1042' }, bearer)).status, 400);
  const { status, data } = await adminCall('DELETE', '/api/admin/orders/FP-6000', { confirm: 'FP-6000' }, bearer);
  assert.equal(status, 200);
  assert.ok(data.filesDeleted >= 9);
  const left = fs.readdirSync(path.join(tmp, 'data', 'files', 'orders', 'FP-6000'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
  assert.equal(left.length, 0);
  assert.equal((await fetch(url)).status, 404);
  assert.equal((await adminCall('DELETE', '/api/admin/orders/FP-6000', { confirm: 'FP-6000' }, bearer)).status, 404);
});

test('backs up the database and keeps the newest copies', async () => {
  const dir = path.join(tmp, 'data', 'files', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= KEEP_BACKUPS + 2; i++) fs.writeFileSync(path.join(dir, `gallery-2020-01-${String(i).padStart(2, '0')}.sqlite`), 'old');
  const { status, data } = await adminCall('POST', '/api/admin/backup', null, bearer);
  assert.equal(status, 200);
  const kept = fs.readdirSync(dir).sort();
  assert.equal(kept.length, KEEP_BACKUPS);
  assert.ok(kept.includes(data.key.split('/').pop()), 'today’s copy is kept');
  assert.ok(!kept.includes('gallery-2020-01-01.sqlite'), 'the oldest are removed');
  const copy = new Database(path.join(dir, data.key.split('/').pop()), { readonly: true });
  assert.ok(copy.prepare("SELECT COUNT(*) AS n FROM orders WHERE code = 'FP-1042'").get().n === 1);
  copy.close();
  const { data: all } = await adminCall('GET', '/api/admin/overview', null, bearer);
  assert.equal(all.backup.latest.key, data.key);
});
