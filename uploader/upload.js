#!/usr/bin/env node
// Upload one order folder from Jason's PC to the gallery.
//
//   npm run upload -- "C:\Orders\FP-1042 Martin" --order FP-1042 --title "The Martin Family Collection"
//
// In each album folder the photos are the enhanced versions (what the
// customer sees). A file ending in _b is the back of the photo with the same
// name. Anything in a "raw" folder is uploaded exactly as it is, only for the
// customer to download; it is never matched, resized or shown.
//
//   FP-1042 Martin\Album 1\scan001.jpg        photo (front)
//   FP-1042 Martin\Album 1\scan001_b.jpg      back of the same photo
//   FP-1042 Martin\Album 1\raw\…              raw scans, for download
//
// Each album folder becomes one of the customer's scanned folders. Safe to run
// again: anything already uploaded is skipped, so an interrupted upload picks
// up where it stopped.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};
const RAW_DIR = /^raw$/i;
const BACK = /^(.*)_b$/i; // scan001_b is the back of scan001
const SCREEN_EDGE = 2048; // what customers browse
const THUMB_EDGE = 480; // grid and filmstrip
const LOOSE_FOLDER = 'Other photos'; // for files sitting directly in the order folder, next to album folders
const ONLY_FOLDER = 'Photos'; // when the order folder has no album folders at all
const BATCH = 50;
const CONCURRENCY = 3;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ------------------------------------------------------------------ scanning

function walkOrder(orderDir) {
  const enhanced = [];
  const raws = [];
  const walk = (dir, inRaw) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'gallery-access.txt') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, inRaw || RAW_DIR.test(entry.name));
      } else if (inRaw) {
        // Paths use / so they read the same on every computer and in the zip.
        raws.push({ file: full, path: path.relative(orderDir, full).split(path.sep).join('/') });
      } else if (IMAGE_TYPES[path.extname(entry.name).toLowerCase()]) {
        enhanced.push({ file: full, filename: entry.name, relDir: path.relative(orderDir, dir) });
      }
    }
  };
  walk(orderDir, false);
  return { enhanced, raws };
}

// Finds the photos in an order folder, attaching each back (scan001_b) to its
// front, plus the raw files to upload as they are.
// Returns { photos, raws, warnings }.
export function scanOrder(orderDir) {
  const { enhanced, raws } = walkOrder(orderDir);
  const warnings = [];
  const nameKey = (relDir, filename) => path.join(relDir, path.parse(filename).name).toLowerCase();

  const byName = new Map();
  const duplicates = [];
  for (const e of enhanced) {
    const k = nameKey(e.relDir, e.filename);
    if (byName.has(k)) duplicates.push(path.join(e.relDir, e.filename));
    else byName.set(k, e);
  }
  if (duplicates.length) {
    throw new Error(`These share a name with another photo in the same folder (only the extension differs), so a back can't be matched to them:\n  ${duplicates.join('\n  ')}`);
  }

  const hasAlbums = enhanced.some((e) => e.relDir !== '');
  const folderName = (relDir) => (relDir === '' ? (hasAlbums ? LOOSE_FOLDER : ONLY_FOLDER) : relDir.split(path.sep).join(' - '));

  const backOf = new Map(); // front -> back
  for (const e of enhanced) {
    const m = BACK.exec(path.parse(e.filename).name);
    if (!m) continue;
    const front = byName.get(nameKey(e.relDir, m[1]));
    if (front) backOf.set(front, e);
    else warnings.push(`${path.join(e.relDir, e.filename)} looks like the back of a photo, but there is no front called ${m[1]}. Uploading it as its own photo.`);
  }
  const backs = new Set(backOf.values());

  const photos = enhanced
    .filter((e) => !backs.has(e))
    .map((e) => {
      const back = backOf.get(e);
      return { folder: folderName(e.relDir), file: e.file, filename: e.filename, back: back ? { file: back.file, filename: back.filename } : null };
    })
    .sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.filename, b.filename));

  if (raws.length === 0) warnings.push('No "raw" folder found, so there are no raw scans to upload.');
  raws.sort((a, b) => collator.compare(a.path, b.path));
  return { photos, raws, warnings };
}

export function findPhotos(orderDir) {
  return scanOrder(orderDir).photos;
}

// ---------------------------------------------------------------- talking to the app

function client(galleryUrl, adminToken) {
  const base = galleryUrl.replace(/\/$/, '');
  return async function call(pathname, body) {
    const res = await fetch(`${base}/api/admin${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${pathname} failed with HTTP ${res.status}`);
    return data;
  };
}

async function withRetries(what, fn, attempts = 4) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw new Error(`${what}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

async function put(url, body, contentType) {
  const res = await fetch(url, { method: 'PUT', body, headers: { 'content-type': contentType } });
  if (!res.ok) throw new Error(`upload failed with HTTP ${res.status}`);
}

// ------------------------------------------------------------------ the upload

export async function uploadOrder({ dir, order, title, galleryUrl, adminToken, log = console.log }) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Folder not found: ${dir}`);
  const call = client(galleryUrl, adminToken);
  const code = String(order).trim().toUpperCase();

  const created = await call('/orders', { code, title });
  if (created.created) {
    const note = `Gallery: ${created.order.url}\nAccess code: ${created.accessCode}\n`;
    fs.writeFileSync(path.join(dir, 'gallery-access.txt'), note);
    log(`\nNew gallery for ${code}\n${note}(Saved in gallery-access.txt in the order folder.)\n`);
  } else {
    log(`\nAdding to existing gallery ${code}: ${created.order.url}\n`);
  }

  const { photos, raws, warnings } = scanOrder(dir);
  if (photos.length === 0) throw new Error('No photos found (looking for .jpg, .jpeg, .png, .tif, .tiff).');
  const backs = photos.filter((p) => p.back).length;
  log(`Found ${photos.length} photos${backs ? ` (${backs} with a back)` : ''} in ${new Set(photos.map((p) => p.folder)).size} folders, and ${raws.length} raw files.`);
  for (const w of warnings) log(`\n${w}`);
  log('');

  const stats = { uploaded: 0, skipped: 0, failed: [] };
  let pending = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    await withRetries('Saving photo list', () => call(`/orders/${code}/photos`, { photos: batch }));
  };

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < photos.length) {
      const item = photos[next++];
      const label = `${item.folder}/${item.filename}`;
      try {
        const result = await withRetries(label, () => uploadOne(call, code, item));
        stats[result.didUpload ? 'uploaded' : 'skipped']++;
        pending.push(result.record);
        if (pending.length >= BATCH) await flush();
        log(`[${++done}/${photos.length}] ${label}  ${result.didUpload ? 'uploaded' : 'already uploaded'}`);
      } catch (err) {
        stats.failed.push({ label, error: err.message });
        log(`[${++done}/${photos.length}] ${label}  FAILED: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await flush();

  // Raw scans: uploaded exactly as they are, for the customer's download.
  stats.rawUploaded = 0;
  stats.rawSkipped = 0;
  let pendingRaw = [];
  const flushRaw = async () => {
    if (pendingRaw.length === 0) return;
    const batch = pendingRaw;
    pendingRaw = [];
    await withRetries('Saving raw file list', () => call(`/orders/${code}/raw-files`, { files: batch }));
  };
  next = 0;
  done = 0;
  const rawWorker = async () => {
    while (next < raws.length) {
      const item = raws[next++];
      try {
        const result = await withRetries(item.path, () => uploadRaw(call, code, item));
        stats[result.didUpload ? 'rawUploaded' : 'rawSkipped']++;
        pendingRaw.push(result.record);
        if (pendingRaw.length >= BATCH) await flushRaw();
        log(`[raw ${++done}/${raws.length}] ${item.path}  ${result.didUpload ? 'uploaded' : 'already uploaded'}`);
      } catch (err) {
        stats.failed.push({ label: item.path, error: err.message });
        log(`[raw ${++done}/${raws.length}] ${item.path}  FAILED: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, rawWorker));
  await flushRaw();

  log(`\nDone. Photos: ${stats.uploaded} uploaded, ${stats.skipped} already there. Raw files: ${stats.rawUploaded} uploaded, ${stats.rawSkipped} already there. ${stats.failed.length} failed.`);
  if (stats.failed.length) log('Run the same command again to retry the failed ones.');
  return { ...stats, url: created.order.url, accessCode: created.accessCode };
}

// Reads one side (front or back) and works out its storage keys. The
// checksum is part of every key, so a re-scanned file never overwrites or gets
// confused with the old one.
async function readSide(code, side) {
  const data = await fs.promises.readFile(side.file);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const ext = path.extname(side.filename).toLowerCase();
  const meta = await sharp(data).metadata();
  // EXIF orientation 5-8 means the picture is stored sideways.
  const sideways = meta.orientation >= 5;
  return {
    data,
    contentType: IMAGE_TYPES[ext],
    record: {
      filename: side.filename,
      sha256,
      bytes: data.length,
      width: sideways ? meta.height : meta.width,
      height: sideways ? meta.width : meta.height,
      enhancedKey: `orders/${code}/enhanced/${sha256}${ext}`,
      screenKey: `orders/${code}/screen/${sha256}.jpg`,
      thumbKey: `orders/${code}/thumb/${sha256}.jpg`,
    },
  };
}

const resized = (data, edge) =>
  sharp(data).rotate().resize(edge, edge, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();

async function uploadOne(call, code, item) {
  const sides = [await readSide(code, item)];
  if (item.back) sides.push(await readSide(code, item.back));

  // In upload order. The front's enhanced file goes last, so a half-finished
  // photo is retried next run.
  const jobs = [];
  for (const s of sides) {
    const r = s.record;
    jobs.push({ key: r.thumbKey, contentType: 'image/jpeg', body: () => resized(s.data, THUMB_EDGE) });
    jobs.push({ key: r.screenKey, contentType: 'image/jpeg', body: () => resized(s.data, SCREEN_EDGE) });
  }
  for (const s of [...sides].reverse()) {
    jobs.push({ key: s.record.enhancedKey, contentType: s.contentType, body: async () => s.data });
  }

  const { files } = await call(`/orders/${code}/upload-urls`, {
    files: jobs.map(({ key, contentType }) => ({ key, contentType })),
  });
  const byKey = Object.fromEntries(files.map((f) => [f.key, f]));

  let didUpload = false;
  for (const job of jobs) {
    if (byKey[job.key].exists) continue;
    await put(byKey[job.key].url, await job.body(), job.contentType);
    didUpload = true;
  }

  const [front, back] = sides.map((s) => s.record);
  return { didUpload, record: { folder: item.folder, ...front, back: back || null } };
}

const RAW_CONTENT_TYPES = { '.tif': 'image/tiff', '.tiff': 'image/tiff', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

async function uploadRaw(call, code, item) {
  const data = await fs.promises.readFile(item.file);
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  const ext = path.extname(item.path).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const key = `orders/${code}/raw/${sha256}${ext}`;
  const contentType = RAW_CONTENT_TYPES[ext] || 'application/octet-stream';
  const { files } = await call(`/orders/${code}/upload-urls`, { files: [{ key, contentType }] });
  let didUpload = false;
  if (!files[0].exists) {
    await put(files[0].url, data, contentType);
    didUpload = true;
  }
  return { didUpload, record: { path: item.path, sha256, bytes: data.length, key } };
}

// ---------------------------------------------------------------------- CLI

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envFile = path.join(root, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { order: { type: 'string' }, title: { type: 'string' } },
  });
  const dir = positionals[0];
  if (!dir || !values.order) {
    console.error('Usage: npm run upload -- "C:\\Orders\\FP-1042 Martin" --order FP-1042 --title "The Martin Family Collection"');
    process.exit(2);
  }
  const galleryUrl = process.env.GALLERY_URL || process.env.PUBLIC_URL;
  const adminToken = process.env.ADMIN_TOKEN;
  if (!galleryUrl || !adminToken) {
    console.error('Set GALLERY_URL and ADMIN_TOKEN in the .env file first (see .env.example).');
    process.exit(2);
  }
  const result = await uploadOrder({ dir: path.resolve(dir), order: values.order, title: values.title, galleryUrl, adminToken });
  process.exit(result.failed.length ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\nStopped: ${err.message}`);
    process.exit(1);
  });
}
