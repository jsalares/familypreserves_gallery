// Builds a customer's zip download while it is being downloaded, one file at
// a time, so even a very large order needs no waiting and little disk space.
//
//   FP-1042 The Martin Family Collection/
//     Enhanced/Album 1/scan001.jpg          (and scan001_b.jpg, the back)
//     My custom folders/Christmas/scan001.jpg
//     Raw scans/Album 1/scan001.tif         exactly as uploaded
//
// Enhanced photos and their copies get the customer's details written into
// them (date, caption, place, event, people, folders as tags) and their turn
// applied, using ExifTool. Raw scans are never changed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import yazl from 'yazl';
import { ExifTool } from 'exiftool-vendored';

// One ExifTool helper for the whole app, started on first use.
let exiftool = null;
const tool = () => (exiftool ??= new ExifTool({ maxProcs: 2, taskTimeoutMillis: 60_000 }));
export async function closeExifTool() {
  if (exiftool) await exiftool.end();
  exiftool = null;
}

// File and folder names inside the zip: no characters Windows refuses.
export function safeName(name) {
  const clean = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim();
  return clean || '_';
}

// EXIF orientation for a quarter turn, combined with any the file already has
// (scanners sometimes set one). Mirrored orientations are left as they are.
const TURN_FOR = { 1: 0, 6: 90, 3: 180, 8: 270 };
const ORIENTATION_FOR = { 0: 1, 90: 6, 180: 3, 270: 8 };
export function orientationAfterTurn(existing, rotation) {
  const start = TURN_FOR[existing ?? 1];
  if (start === undefined) return existing; // mirrored: leave alone
  return ORIENTATION_FOR[(start + rotation) % 360];
}

// The tags written into a photo. Exported for the tests.
export function tagsFor(photo, { orientation } = {}) {
  const tags = {};
  const year = /\b(1[89]\d\d|20\d\d)\b/.exec(photo.year || '')?.[1];
  if (year) {
    tags['EXIF:DateTimeOriginal'] = `${year}:01:01 00:00:00`;
    tags['XMP-photoshop:DateCreated'] = year; // XMP allows a year on its own
  }
  if (photo.caption) {
    tags['EXIF:ImageDescription'] = photo.caption;
    tags['XMP-dc:Description'] = photo.caption;
    tags['IPTC:Caption-Abstract'] = photo.caption;
  }
  if (photo.place) {
    tags['XMP-iptcCore:Location'] = photo.place;
    tags['IPTC:Sub-location'] = photo.place;
  }
  if (photo.event) tags['XMP-iptcExt:Event'] = photo.event;
  if (photo.people.length) tags['XMP-iptcExt:PersonInImage'] = photo.people;
  const keywords = [...new Set([...photo.people, ...photo.customFolders, ...(photo.event ? [photo.event] : [])])];
  if (keywords.length) {
    tags['XMP-dc:Subject'] = keywords;
    tags['IPTC:Keywords'] = keywords;
  }
  if (orientation) tags['EXIF:Orientation#'] = orientation;
  if (Object.keys(tags).some((k) => k.startsWith('IPTC:'))) tags['IPTC:CodedCharacterSet'] = 'UTF8';
  return tags;
}

// What to put in the zip for the parts the customer ticked.
//   parts: { raw: bool, scanned: Set<name>, custom: Set<name> }
export function planDownload({ order, photos, rawFiles, parts }) {
  const root = safeName(`${order.code} ${order.title}`);
  const used = new Set();
  const unique = (p) => {
    let name = p;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const ext = path.posix.extname(p);
      name = `${p.slice(0, p.length - ext.length)} (${i})${ext}`;
    }
    used.add(name.toLowerCase());
    return name;
  };

  const items = []; // { photo, side, paths[] } or { raw, path }
  for (const photo of photos) {
    const dirs = [];
    if (parts.scanned.has(photo.folder)) dirs.push(`Enhanced/${safeName(photo.folder)}`);
    for (const f of photo.customFolders) if (parts.custom.has(f)) dirs.push(`My custom folders/${safeName(f)}`);
    if (!dirs.length) continue;
    items.push({ photo, side: 'front', paths: dirs.map((d) => unique(`${root}/${d}/${safeName(photo.filename)}`)) });
    if (photo.back) {
      items.push({ photo, side: 'back', paths: dirs.map((d) => unique(`${root}/${d}/${safeName(photo.back.filename)}`)) });
    }
  }
  if (parts.raw) {
    for (const r of rawFiles) {
      // Album 1/raw/scan001.tif -> Raw scans/Album 1/scan001.tif
      const segments = r.path.split('/').filter((s) => !/^raw$/i.test(s)).map(safeName);
      items.push({ raw: r, path: unique(`${root}/Raw scans/${segments.join('/')}`) });
    }
  }
  return { root, items };
}

// Streams the zip into `res`. Stops quietly if the customer cancels.
export async function sendZip({ res, storage, plan, log = console.error }) {
  const zip = new yazl.ZipFile();
  let cancelled = false;
  res.on('close', () => {
    if (!res.writableFinished) cancelled = true;
  });
  const done = pipeline(zip.outputStream, res).catch(() => {
    cancelled = true;
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fpg-zip-'));
  // Adds one entry and waits until it has been read into the zip, so files
  // are fetched one at a time and the download controls the pace.
  const addStream = (stream, name) =>
    new Promise((resolve, reject) => {
      stream.once('end', resolve);
      stream.once('error', reject);
      zip.addReadStream(stream, name, { compress: false, mtime: new Date() });
    });

  try {
    for (const item of plan.items) {
      if (cancelled) break;
      if (item.raw) {
        await addStream(await storage.read(item.raw.key), item.path);
        continue;
      }
      const { photo, side } = item;
      const source = side === 'back' ? photo.back : photo;
      const file = path.join(tmpDir, `${crypto.randomBytes(8).toString('hex')}${path.extname(source.filename).toLowerCase()}`);
      await pipeline(await storage.read(source.enhanced_key), fs.createWriteStream(file));
      try {
        const current = await tool().read(file, ['-Orientation#']);
        const orientation = source.rotation ? orientationAfterTurn(current.Orientation, source.rotation) : undefined;
        const tags = tagsFor(photo, { orientation });
        if (Object.keys(tags).length) await tool().write(file, tags, { writeArgs: ['-overwrite_original', '-m'] });
      } catch (err) {
        // Better a photo without its details than a missing photo.
        log(`Could not write details into ${source.filename}: ${err.message}`);
      }
      for (const name of item.paths) {
        if (cancelled) break;
        await addStream(fs.createReadStream(file), name);
      }
      fs.rmSync(file, { force: true });
    }
  } catch (err) {
    log(`Download stopped: ${err.message}`);
    cancelled = true;
    res.destroy(err);
  } finally {
    zip.end();
    await done;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
