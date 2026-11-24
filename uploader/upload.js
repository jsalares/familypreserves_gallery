#!/usr/bin/env node
// Upload one order folder from Jason's PC to the gallery.
//
//   npm run upload -- "C:\Orders\FP-1042 Martin" --order FP-1042 --title "The Martin Family Collection"
//
// Each subfolder becomes one of the customer's Original folders. Safe to run
// again: anything already uploaded is skipped, so an interrupted upload just
// picks up where it stopped.

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
const SCREEN_EDGE = 2048; // what customers browse
const THUMB_EDGE = 480; // grid and filmstrip
const LOOSE_FOLDER = 'Other photos'; // for files sitting directly in the order folder
const BATCH = 50;
const CONCURRENCY = 3;

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ------------------------------------------------------------------ scanning

export function findPhotos(orderDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (IMAGE_TYPES[path.extname(entry.name).toLowerCase()]) {
        const rel = path.relative(orderDir, path.dirname(full));
        // Nested folders are flattened into one name: "Album 1 - Page 2".
        const folder = rel === '' ? LOOSE_FOLDER : rel.split(path.sep).join(' - ');
        found.push({ file: full, folder, filename: entry.name });
      }
    }
  };
  walk(orderDir);
  return found.sort((a, b) => collator.compare(a.folder, b.folder) || collator.compare(a.filename, b.filename));
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

  const photos = findPhotos(dir);
  if (photos.length === 0) throw new Error('No photos found (looking for .jpg, .jpeg, .png, .tif, .tiff).');
  log(`Found ${photos.length} photos in ${new Set(photos.map((p) => p.folder)).size} folders.\n`);

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

  log(`\nDone. ${stats.uploaded} uploaded, ${stats.skipped} already there, ${stats.failed.length} failed.`);
  if (stats.failed.length) log('Run the same command again to retry the failed ones.');
  return { ...stats, url: created.order.url, accessCode: created.accessCode };
}

async function uploadOne(call, code, item) {
  const original = await fs.promises.readFile(item.file);
  const sha256 = crypto.createHash('sha256').update(original).digest('hex');
  const ext = path.extname(item.filename).toLowerCase();
  const contentType = IMAGE_TYPES[ext];
  // The checksum is part of every key, so a re-scanned file never overwrites
  // or gets confused with the old one.
  const keys = {
    originalKey: `orders/${code}/original/${sha256}${ext}`,
    screenKey: `orders/${code}/screen/${sha256}.jpg`,
    thumbKey: `orders/${code}/thumb/${sha256}.jpg`,
  };

  const { files } = await call(`/orders/${code}/upload-urls`, {
    files: [
      { key: keys.originalKey, contentType },
      { key: keys.screenKey, contentType: 'image/jpeg' },
      { key: keys.thumbKey, contentType: 'image/jpeg' },
    ],
  });
  const byKey = Object.fromEntries(files.map((f) => [f.key, f]));

  const meta = await sharp(original).metadata();
  // EXIF orientation 5-8 means the picture is stored sideways.
  const sideways = meta.orientation >= 5;
  const width = sideways ? meta.height : meta.width;
  const height = sideways ? meta.width : meta.height;

  let didUpload = false;
  const resized = (edge) =>
    sharp(original)
      .rotate()
      .resize(edge, edge, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

  if (!byKey[keys.thumbKey].exists) {
    await put(byKey[keys.thumbKey].url, await resized(THUMB_EDGE), 'image/jpeg');
    didUpload = true;
  }
  if (!byKey[keys.screenKey].exists) {
    await put(byKey[keys.screenKey].url, await resized(SCREEN_EDGE), 'image/jpeg');
    didUpload = true;
  }
  // The original goes last, so a half-finished photo is retried next run.
  if (!byKey[keys.originalKey].exists) {
    await put(byKey[keys.originalKey].url, original, contentType);
    didUpload = true;
  }

  return {
    didUpload,
    record: {
      folder: item.folder,
      filename: item.filename,
      sha256,
      bytes: original.length,
      width,
      height,
      ...keys,
    },
  };
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
