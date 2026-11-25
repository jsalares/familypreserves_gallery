import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { openDb, createQueries } from './db.js';
import { createStorage, assertSafeKey } from './storage.js';
import { createChangeHandler, loadOrganizing, MAX_CHANGES_PER_REQUEST, MAX_CUSTOM_FOLDERS } from './changes.js';
import { planDownload, sendZip, closeExifTool } from './download.js';
import { createBackups } from './backup.js';
import {
  generateAccessCode,
  hashAccessCode,
  verifyAccessCode,
  generateSlug,
  makeSession,
  sign,
  unsign,
  readSession,
  sessionCookieName,
  parseCookies,
  createLimiter,
  SESSION_DAYS,
} from './auth.js';

const ORDER_CODE = /^[A-Za-z0-9][A-Za-z0-9-]{1,39}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BATCH = 200;
const ADMIN_COOKIE = 'fpg_admin';
const ADMIN_HOURS = 12;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Gallery end dates are calendar days in Ottawa: open through the whole of
// that day, closed from the next morning.
const TZ = 'America/Toronto';
export const todayLocal = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
export const addDays = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const isExpired = (order, now = new Date()) => Boolean(order.expires_at && todayLocal(now) > order.expires_at.slice(0, 10));

export function createApp(config) {
  const db = openDb(config.dataDir);
  const q = createQueries(db);
  const storage = createStorage(config);
  const limiter = createLimiter();
  const applyChanges = createChangeHandler(db);
  const backups = createBackups({ db, storage });
  const secureCookies = config.publicUrl.startsWith('https://');
  const publicDir = path.join(config.root, 'public');

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // Caddy runs on the same machine
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': [
        "default-src 'self'",
        "img-src 'self' https://*.r2.cloudflarestorage.com",
        "style-src 'self' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com",
        "script-src 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
    });
    next();
  });

  if (storage.kind === 'local') storage.routes(app);
  // Scripts and styles change with each update, so browsers re-check them every
  // time (a quick "not modified" when unchanged). Images can be kept for an hour.
  app.use(
    '/assets',
    express.static(path.join(publicDir, 'assets'), {
      maxAge: '1h',
      setHeaders: (res, file) => {
        if (/\.(js|css)$/.test(file)) res.set('Cache-Control', 'no-cache');
      },
    })
  );
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const galleryUrl = (order) => `${config.publicUrl}/g/${order.slug}`;
  const page = (res, name, status = 200) => {
    res.status(status).set('Cache-Control', 'no-store').sendFile(path.join(publicDir, name));
  };

  // ---------------------------------------------------------------- admin API
  // Used by the upload tool on Jason's PC. Every call needs the ADMIN_TOKEN.

  const tokenMatches = (value) => {
    const given = Buffer.from(String(value || ''));
    const expected = Buffer.from(config.adminToken);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };
  // The admin page signs in once with the token and then uses a cookie. The
  // cookie is SameSite=Strict, so other websites can't use it.
  const adminCookieOk = (req) => {
    const data = unsign(config.sessionSecret, parseCookies(req.get('cookie'))[ADMIN_COOKIE]);
    return Boolean(data && data.admin === 1 && data.exp > Date.now());
  };

  // Sign in and out of the admin page. Wrong tokens count toward the same
  // lock-out as wrong access codes.
  app.post('/api/admin-session', (req, res) => {
    const key = `admin|${req.ip}`;
    const gate = limiter.check(key);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({ error: `Too many tries. Please wait ${Math.ceil(gate.retryAfterSec / 60)} minutes.` });
    }
    if (!tokenMatches(String(req.body?.token || '').trim())) {
      limiter.fail(key);
      return res.status(401).json({ error: "That token didn't match the ADMIN_TOKEN in the server's .env file." });
    }
    limiter.succeed(key);
    const token = sign(config.sessionSecret, { admin: 1, exp: Date.now() + ADMIN_HOURS * 3600 * 1000 });
    const cookie = [`${ADMIN_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${ADMIN_HOURS * 3600}`];
    if (secureCookies) cookie.push('Secure');
    res.set('Set-Cookie', cookie.join('; ')).json({ ok: true });
  });
  app.delete('/api/admin-session', (req, res) => {
    res.set('Set-Cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`).json({ ok: true });
  });
  app.get('/admin', (req, res) => page(res, adminCookieOk(req) ? 'admin.html' : 'admin-sign-in.html'));

  const removeStrayBack = db.prepare('DELETE FROM photos WHERE source_folder_id = ? AND filename = ?');

  const admin = express.Router();
  admin.use((req, res, next) => {
    if (tokenMatches(String(req.get('authorization') || '').replace(/^Bearer\s+/i, '')) || adminCookieOk(req)) return next();
    res.status(401).json({ error: 'Wrong or missing admin token.' });
  });

  const findOrder = (req, res) => {
    const order = q.orderByCode.get(String(req.params.code).toUpperCase());
    if (!order) res.status(404).json({ error: `No order ${req.params.code}.` });
    return order;
  };

  // Create an order, or return it if it already exists (so re-running the
  // upload tool is safe). The access code is only shown when it is created
  // or reset, because only its hash is stored.
  admin.post('/orders', (req, res) => {
    const code = String(req.body?.code || '').trim().toUpperCase();
    const title = String(req.body?.title || '').trim();
    if (!ORDER_CODE.test(code)) return res.status(400).json({ error: 'Order code should look like FP-1042.' });
    const existing = q.orderByCode.get(code);
    if (existing) {
      return res.json({ created: false, order: { code, title: existing.title, url: galleryUrl(existing) } });
    }
    if (!title || title.length > 120) return res.status(400).json({ error: 'A gallery title is needed for a new order.' });
    const accessCode = generateAccessCode();
    const slug = generateSlug(code);
    const expires_at = config.galleryDays > 0 ? addDays(todayLocal(), config.galleryDays) : null;
    q.insertOrder.run({ code, title, slug, access_hash: hashAccessCode(accessCode), expires_at });
    res.status(201).json({ created: true, accessCode, order: { code, title, url: galleryUrl({ slug }) } });
  });

  admin.post('/orders/:code/reset-code', (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const accessCode = generateAccessCode();
    q.setAccessHash.run(hashAccessCode(accessCode), order.id);
    res.json({ accessCode, order: { code: order.code, title: order.title, url: galleryUrl(order) } });
  });

  // For each file, either "already uploaded" or a short-lived upload link.
  admin.post('/orders/:code/upload-urls', async (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0 || files.length > MAX_BATCH) return res.status(400).json({ error: `Send 1 to ${MAX_BATCH} files.` });
    const prefix = `orders/${order.code}/`;
    try {
      const out = await Promise.all(
        files.map(async ({ key, contentType }) => {
          assertSafeKey(key);
          if (!key.startsWith(prefix)) throw new Error(`Key must start with ${prefix}`);
          if (await storage.exists(key)) return { key, exists: true };
          return { key, exists: false, url: await storage.uploadUrl(key, String(contentType || 'application/octet-stream')) };
        })
      );
      res.json({ files: out });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Record uploaded photos. Safe to repeat: a photo is matched by its scanned
  // folder and filename. A photo may carry its back scan.
  admin.post('/orders/:code/photos', (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const photos = Array.isArray(req.body?.photos) ? req.body.photos : [];
    if (photos.length === 0 || photos.length > MAX_BATCH) return res.status(400).json({ error: `Send 1 to ${MAX_BATCH} photos.` });
    const prefix = `orders/${order.code}/`;
    const side = (p, what) => {
      const filename = String(p?.filename || '').trim();
      if (!filename || filename.length > 255) throw new Error(`${what} needs a filename.`);
      if (!SHA256.test(String(p.sha256))) throw new Error(`Bad checksum for ${filename}.`);
      const enhancedKey = p.enhancedKey ?? p.originalKey; // older upload tools sent originalKey
      for (const k of [enhancedKey, p.screenKey, p.thumbKey]) {
        assertSafeKey(k);
        if (!k.startsWith(prefix)) throw new Error(`Key must start with ${prefix}`);
      }
      return {
        filename,
        sha256: p.sha256,
        bytes: Number(p.bytes) || 0,
        width: Number(p.width) || null,
        height: Number(p.height) || null,
        enhanced_key: enhancedKey,
        screen_key: p.screenKey,
        thumb_key: p.thumbKey,
      };
    };
    try {
      db.transaction(() => {
        for (const p of photos) {
          const folder = String(p.folder || '').trim();
          if (!folder || folder.length > 200) throw new Error('Each photo needs a folder.');
          const front = side(p, 'Each photo');
          const back = p.back ? side(p.back, `The back of ${front.filename}`) : null;
          let sf = q.sourceFolder.get(order.id, folder);
          if (!sf) sf = { id: q.insertSourceFolder.run(order.id, folder).lastInsertRowid };
          const { id } = q.upsertPhoto.get({ order_id: order.id, source_folder_id: sf.id, ...front });
          if (back) {
            q.upsertBack.run({ photo_id: id, ...back });
            // An earlier upload may have added this back as a photo of its own
            // (before its front was recognised). It now lives with its front.
            removeStrayBack.run(sf.id, back.filename);
          }
          else q.deleteBack.run(id);
        }
        q.renumber(order.id);
      })();
      res.json({ ok: true, total: q.countPhotos.get(order.id).n });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Record raw scans (uploaded as they are, for download only).
  admin.post('/orders/:code/raw-files', (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const files = Array.isArray(req.body?.files) ? req.body.files : [];
    if (files.length === 0 || files.length > MAX_BATCH) return res.status(400).json({ error: `Send 1 to ${MAX_BATCH} files.` });
    const prefix = `orders/${order.code}/raw/`;
    try {
      db.transaction(() => {
        for (const f of files) {
          const p = String(f.path || '');
          // A relative path with / separators that can't climb out of the order.
          if (!p || p.length > 500 || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '' || s === '.' || s === '..') || /[\x00-\x1f\x7f]/.test(p)) {
            throw new Error(`Bad raw file path: ${p}`);
          }
          if (!SHA256.test(String(f.sha256))) throw new Error(`Bad checksum for ${p}.`);
          assertSafeKey(f.key);
          if (!f.key.startsWith(prefix)) throw new Error(`Key must start with ${prefix}`);
          q.upsertRawFile.run({ order_id: order.id, path: p, sha256: f.sha256, bytes: Number(f.bytes) || 0, key: f.key });
        }
      })();
      res.json({ ok: true, total: q.countRawFiles.get(order.id).n });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });


  // ------------------------------------------------------------ admin page API
  // Used by the admin page at /admin (signed in with the cookie above).

  const orderStats = db.prepare(`
    SELECT o.*,
      (SELECT COUNT(*) FROM photos p WHERE p.order_id = o.id) AS photos,
      (SELECT COUNT(*) FROM photo_backs b JOIN photos p ON p.id = b.photo_id WHERE p.order_id = o.id) AS backs,
      (SELECT COUNT(*) FROM photos p WHERE p.order_id = o.id AND p.enhance = 1) AS restore,
      (SELECT COUNT(*) FROM custom_folders c WHERE c.order_id = o.id) AS custom_folders,
      (SELECT COUNT(*) FROM raw_files r WHERE r.order_id = o.id) AS raw_files,
      (SELECT COALESCE(SUM(p.bytes), 0) FROM photos p WHERE p.order_id = o.id)
        + (SELECT COALESCE(SUM(b.bytes), 0) FROM photo_backs b JOIN photos p ON p.id = b.photo_id WHERE p.order_id = o.id)
        + (SELECT COALESCE(SUM(r.bytes), 0) FROM raw_files r WHERE r.order_id = o.id) AS bytes
    FROM orders o ORDER BY o.created_at DESC, o.id DESC
  `);
  const folderStats = db.prepare(`
    SELECT f.id, f.name, COUNT(p.id) AS photos FROM source_folders f
    LEFT JOIN photos p ON p.source_folder_id = f.id
    WHERE f.order_id = ? GROUP BY f.id ORDER BY f.position, f.id
  `);
  const setExpiry = db.prepare('UPDATE orders SET expires_at = ? WHERE id = ?');
  const setTitle = db.prepare('UPDATE orders SET title = ? WHERE id = ?');
  const bumpWelcome = db.prepare('UPDATE orders SET welcome_version = welcome_version + 1 WHERE id = ?');
  const deleteOrderRow = db.prepare('DELETE FROM orders WHERE id = ?');
  const deleteFolderRow = db.prepare('DELETE FROM source_folders WHERE id = ?');
  const keysInFolder = db.prepare(`
    SELECT enhanced_key AS a, screen_key AS b, thumb_key AS c FROM photos WHERE source_folder_id = ?
    UNION ALL
    SELECT bk.enhanced_key, bk.screen_key, bk.thumb_key FROM photo_backs bk JOIN photos p ON p.id = bk.photo_id WHERE p.source_folder_id = ?
  `);
  const keysInOrder = db.prepare(`
    SELECT enhanced_key AS a, screen_key AS b, thumb_key AS c FROM photos WHERE order_id = ?
    UNION ALL
    SELECT bk.enhanced_key, bk.screen_key, bk.thumb_key FROM photo_backs bk JOIN photos p ON p.id = bk.photo_id WHERE p.order_id = ?
    UNION ALL
    SELECT key, NULL, NULL FROM raw_files WHERE order_id = ?
  `);
  const flatKeys = (rows) => new Set(rows.flatMap((r) => [r.a, r.b, r.c]).filter(Boolean));

  const describeOrder = (o) => ({
    code: o.code,
    title: o.title,
    url: galleryUrl(o),
    createdAt: o.created_at,
    expiresOn: o.expires_at ? o.expires_at.slice(0, 10) : null,
    expired: isExpired(o),
    photos: o.photos,
    backs: o.backs,
    restore: o.restore,
    customFolders: o.custom_folders,
    rawFiles: o.raw_files,
    bytes: o.bytes,
    folders: folderStats.all(o.id).map((f) => ({ name: f.name, photos: f.photos })),
  });

  admin.get('/overview', async (req, res) => {
    let backup;
    try {
      backup = await backups.status();
    } catch (err) {
      backup = { backups: [], lastError: { message: err.message }, keep: 0 };
    }
    res.set('Cache-Control', 'no-store').json({
      today: todayLocal(),
      galleryDays: config.galleryDays,
      orders: orderStats.all().map(describeOrder),
      backup: {
        latest: backup.backups[0] || null,
        count: backup.backups.length,
        keep: backup.keep,
        lastError: backup.lastError,
      },
    });
  });

  admin.post('/backup', async (req, res) => {
    try {
      const out = await backups.run();
      res.json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ error: `Backup failed: ${err.message}` });
    }
  });

  // { expiresOn: "2027-03-01" } or { expiresOn: null } for no end date.
  admin.post('/orders/:code/expiry', (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const v = req.body?.expiresOn ?? null;
    if (v !== null && (!DATE.test(String(v)) || Number.isNaN(Date.parse(v)))) {
      return res.status(400).json({ error: 'Pick a date, or no end date.' });
    }
    setExpiry.run(v, order.id);
    res.json({ ok: true, expiresOn: v, expired: isExpired({ expires_at: v }) });
  });

  // The customer sees the welcome screen again on their next visit, on any device.
  admin.post('/orders/:code/welcome', (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    bumpWelcome.run(order.id);
    res.json({ ok: true });
  });

  admin.post('/orders/:code/title', (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const title = String(req.body?.title || '').trim();
    if (!title || title.length > 120) return res.status(400).json({ error: 'The title needs 1 to 120 characters.' });
    setTitle.run(title, order.id);
    res.json({ ok: true, title });
  });

  // Deleting needs the order code typed again in the body, so a slip can't do it.
  const confirmCode = (req, res, order) => {
    if (String(req.body?.confirm || '').trim().toUpperCase() !== order.code) {
      res.status(400).json({ error: `Type ${order.code} to confirm.` });
      return false;
    }
    return true;
  };

  // The whole gallery: database rows first (so it disappears at once), then
  // every file stored for it.
  admin.delete('/orders/:code', async (req, res) => {
    const order = findOrder(req, res);
    if (!order || !confirmCode(req, res, order)) return;
    deleteOrderRow.run(order.id);
    try {
      const files = await storage.list(`orders/${order.code}/`);
      await storage.remove(files.map((f) => f.key));
      res.json({ ok: true, filesDeleted: files.length });
    } catch (err) {
      res.status(500).json({ error: `The gallery is gone, but some files could not be removed from storage: ${err.message}` });
    }
  });

  // One scanned folder and its photos (with backs). Customers' custom folders
  // lose those copies. A file is only removed from storage when no photo left
  // in the order uses it (identical scans share one file).
  admin.delete('/orders/:code/folders', async (req, res) => {
    const order = findOrder(req, res);
    if (!order || !confirmCode(req, res, order)) return;
    const name = String(req.body?.folder || '');
    const folder = q.sourceFolder.get(order.id, name);
    if (!folder) return res.status(404).json({ error: `No scanned folder called "${name}".` });
    const gone = db.transaction(() => {
      const keys = flatKeys(keysInFolder.all(folder.id, folder.id));
      const photos = q.photosInFolder.all(folder.id).length;
      deleteFolderRow.run(folder.id);
      q.renumber(order.id);
      const still = flatKeys(keysInOrder.all(order.id, order.id, order.id));
      return { photos, keys: [...keys].filter((k) => !still.has(k)) };
    })();
    try {
      await storage.remove(gone.keys);
      res.json({ ok: true, photosDeleted: gone.photos, filesDeleted: gone.keys.length });
    } catch (err) {
      res.status(500).json({ error: `The folder is gone, but some files could not be removed from storage: ${err.message}` });
    }
  });

  app.use('/api/admin', admin);

  // ------------------------------------------------------------ customer side

  const loadOrder = (req) => q.orderBySlug.get(String(req.params.slug));
  const signedIn = (req, order) =>
    readSession(config.sessionSecret, parseCookies(req.get('cookie'))[sessionCookieName(order.id)], order.id);


  app.get('/g/:slug', (req, res) => {
    const order = loadOrder(req);
    if (!order) return page(res, 'not-found.html', 404);
    if (isExpired(order)) return page(res, 'expired.html', 410);
    page(res, signedIn(req, order) ? 'gallery.html' : 'sign-in.html');
  });

  app.post('/api/g/:slug/sign-in', (req, res) => {
    const order = loadOrder(req);
    if (!order || isExpired(order)) return res.status(404).json({ error: 'This gallery could not be found.' });
    const key = `${order.id}|${req.ip}`;
    const gate = limiter.check(key);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfterSec));
      return res.status(429).json({
        error: `Too many tries. Please wait ${Math.ceil(gate.retryAfterSec / 60)} minutes and try again.`,
      });
    }
    if (!verifyAccessCode(req.body?.code, order.access_hash)) {
      limiter.fail(key);
      return res.status(401).json({ error: "That code didn't match. Check the code on your card or email and try again." });
    }
    limiter.succeed(key);
    const cookie = [
      `${sessionCookieName(order.id)}=${makeSession(config.sessionSecret, order.id)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${SESSION_DAYS * 24 * 3600}`,
    ];
    if (secureCookies) cookie.push('Secure');
    res.set('Set-Cookie', cookie.join('; ')).json({ ok: true });
  });

  app.post('/api/g/:slug/sign-out', (req, res) => {
    const order = loadOrder(req);
    if (!order) return res.status(404).end();
    res.set('Set-Cookie', `${sessionCookieName(order.id)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`).json({ ok: true });
  });

  // Signed-in customer for this gallery, or an error response.
  const customerOrder = (req, res) => {
    const order = loadOrder(req);
    if (!order || isExpired(order)) {
      res.status(404).json({ error: 'This gallery could not be found.' });
      return null;
    }
    if (!signedIn(req, order)) {
      res.status(401).json({ error: 'Please enter your access code.' });
      return null;
    }
    return order;
  };

  app.get('/api/g/:slug/gallery', async (req, res) => {
    const order = customerOrder(req, res);
    if (!order) return;
    const rows = q.photosForOrder.all(order.id);
    const org = loadOrganizing(db, order.id);
    const photos = await Promise.all(
      rows.map(async (p) => ({
        id: p.id,
        folder: p.source_folder,
        filename: p.filename,
        width: p.width,
        height: p.height,
        thumb: await storage.viewUrl(p.thumb_key),
        screen: await storage.viewUrl(p.screen_key),
        back: p.back_screen_key
          ? {
              filename: p.back_filename,
              rotation: p.back_rotation,
              width: p.back_width,
              height: p.back_height,
              thumb: await storage.viewUrl(p.back_thumb_key),
              screen: await storage.viewUrl(p.back_screen_key),
            }
          : null,
        customFolders: org.foldersByPhoto.get(p.id) || [],
        people: org.peopleByPhoto.get(p.id) || [],
        year: p.year || '',
        place: p.place || '',
        event: p.event || '',
        caption: p.caption || '',
        enhance: Boolean(p.enhance),
        rotation: p.rotation,
        bytes: p.bytes + (p.back_bytes || 0),
      }))
    );
    const folders = q.sourceFolders.all(order.id).map((f) => ({
      name: f.name,
      count: rows.filter((p) => p.source_folder_id === f.id).length,
    }));
    res.set('Cache-Control', 'no-store').json({
      order: { code: order.code, title: order.title, welcomeVersion: order.welcome_version },
      folders,
      customFolders: org.customFolders,
      people: org.people,
      maxCustomFolders: MAX_CUSTOM_FOLDERS,
      raw: q.rawTotals.get(order.id),
      photos,
    });
  });

  // The zip download. ?raw=1&scanned=<folder>&custom=<folder> (repeatable)
  // picks what goes in. Built while it downloads; see server/download.js.
  app.get('/api/g/:slug/download', async (req, res) => {
    const order = customerOrder(req, res);
    if (!order) return;
    const list = (v) => new Set((Array.isArray(v) ? v : v == null ? [] : [v]).map(String));
    const parts = { raw: req.query.raw === '1', scanned: list(req.query.scanned), custom: list(req.query.custom) };
    const org = loadOrganizing(db, order.id);
    const photos = q.photosForOrder.all(order.id).map((p) => ({
      ...p,
      folder: p.source_folder,
      customFolders: org.foldersByPhoto.get(p.id) || [],
      people: org.peopleByPhoto.get(p.id) || [],
      back: p.back_enhanced_key ? { filename: p.back_filename, enhanced_key: p.back_enhanced_key, rotation: p.back_rotation } : null,
    }));
    const plan = planDownload({ order, photos, rawFiles: parts.raw ? q.rawFilesForOrder.all(order.id) : [], parts });
    if (!plan.items.length) return res.status(400).json({ error: 'Choose at least one folder to download.' });
    const filename = `${plan.root}.zip`;
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
    await sendZip({ res, storage, plan });
  });

  // A batch of customer edits, applied in order. See server/changes.js.
  app.post('/api/g/:slug/changes', (req, res) => {
    const order = customerOrder(req, res);
    if (!order) return;
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : null;
    if (!changes || changes.length > MAX_CHANGES_PER_REQUEST) {
      return res.status(400).json({ error: `Send up to ${MAX_CHANGES_PER_REQUEST} changes at a time.` });
    }
    res.json({ results: applyChanges(order.id, changes) });
  });

  app.use((req, res) => page(res, 'not-found.html', 404));

  return {
    app,
    db,
    storage,
    backups,
    close: async () => {
      backups.stop();
      await backups.idle();
      await closeExifTool();
      db.close();
    },
  };
}
