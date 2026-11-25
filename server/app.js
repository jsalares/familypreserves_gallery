import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { openDb, createQueries } from './db.js';
import { createStorage, assertSafeKey } from './storage.js';
import { createChangeHandler, loadOrganizing, MAX_CHANGES_PER_REQUEST, MAX_CUSTOM_FOLDERS } from './changes.js';
import { planDownload, sendZip, closeExifTool } from './download.js';
import {
  generateAccessCode,
  hashAccessCode,
  verifyAccessCode,
  generateSlug,
  makeSession,
  readSession,
  sessionCookieName,
  parseCookies,
  createLimiter,
  SESSION_DAYS,
} from './auth.js';

const ORDER_CODE = /^[A-Za-z0-9][A-Za-z0-9-]{1,39}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_BATCH = 200;

export function createApp(config) {
  const db = openDb(config.dataDir);
  const q = createQueries(db);
  const storage = createStorage(config);
  const limiter = createLimiter();
  const applyChanges = createChangeHandler(db);
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

  // ---------------------------------------------------------------- admin API
  // Used by the upload tool on Jason's PC. Every call needs the ADMIN_TOKEN.

  const admin = express.Router();
  admin.use((req, res, next) => {
    const given = Buffer.from(String(req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
    const expected = Buffer.from(config.adminToken);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return res.status(401).json({ error: 'Wrong or missing admin token.' });
    }
    next();
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
    q.insertOrder.run({ code, title, slug, access_hash: hashAccessCode(accessCode) });
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
          if (back) q.upsertBack.run({ photo_id: id, ...back });
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

  app.use('/api/admin', admin);

  // ------------------------------------------------------------ customer side

  const loadOrder = (req) => q.orderBySlug.get(String(req.params.slug));
  const isExpired = (order) => Boolean(order.expires_at && Date.parse(order.expires_at) < Date.now());
  const signedIn = (req, order) =>
    readSession(config.sessionSecret, parseCookies(req.get('cookie'))[sessionCookieName(order.id)], order.id);

  const page = (res, name, status = 200) => {
    res.status(status).set('Cache-Control', 'no-store').sendFile(path.join(publicDir, name));
  };

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
      order: { code: order.code, title: order.title },
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
    close: async () => {
      await closeExifTool();
      db.close();
    },
  };
}
