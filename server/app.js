import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import { openDb, createQueries } from './db.js';
import { createStorage, assertSafeKey } from './storage.js';
import { createChangeHandler, loadOrganizing, MAX_CHANGES_PER_REQUEST, MAX_CUSTOM_FOLDERS } from './changes.js';
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
  // folder and filename. Each photo is the enhanced file customers see, plus
  // (usually) the raw scan it was made from, which is only used for downloads.
  admin.post('/orders/:code/photos', (req, res) => {
    const order = findOrder(req, res);
    if (!order) return;
    const photos = Array.isArray(req.body?.photos) ? req.body.photos : [];
    if (photos.length === 0 || photos.length > MAX_BATCH) return res.status(400).json({ error: `Send 1 to ${MAX_BATCH} photos.` });
    const prefix = `orders/${order.code}/`;
    const checkKey = (k) => {
      assertSafeKey(k);
      if (!k.startsWith(prefix)) throw new Error(`Key must start with ${prefix}`);
    };
    try {
      db.transaction(() => {
        for (const p of photos) {
          const folder = String(p.folder || '').trim();
          const filename = String(p.filename || '').trim();
          if (!folder || !filename || folder.length > 200 || filename.length > 255) throw new Error('Each photo needs a folder and filename.');
          if (!SHA256.test(String(p.sha256))) throw new Error(`Bad checksum for ${filename}.`);
          const enhancedKey = p.enhancedKey ?? p.originalKey; // older upload tools sent originalKey
          for (const k of [enhancedKey, p.screenKey, p.thumbKey]) checkKey(k);
          const raw = p.raw || null;
          if (raw) {
            const rawName = String(raw.filename || '').trim();
            if (!rawName || rawName.length > 255) throw new Error(`The original of ${filename} needs a filename.`);
            if (!SHA256.test(String(raw.sha256))) throw new Error(`Bad checksum for the original of ${filename}.`);
            checkKey(raw.key);
          }
          let sf = q.sourceFolder.get(order.id, folder);
          if (!sf) sf = { id: q.insertSourceFolder.run(order.id, folder).lastInsertRowid };
          q.upsertPhoto.run({
            order_id: order.id,
            source_folder_id: sf.id,
            filename,
            sha256: p.sha256,
            bytes: Number(p.bytes) || 0,
            width: Number(p.width) || null,
            height: Number(p.height) || null,
            enhanced_key: enhancedKey,
            screen_key: p.screenKey,
            thumb_key: p.thumbKey,
            raw_filename: raw ? String(raw.filename).trim() : null,
            raw_sha256: raw ? raw.sha256 : null,
            raw_bytes: raw ? Number(raw.bytes) || 0 : null,
            raw_key: raw ? raw.key : null,
          });
        }
        q.renumber(order.id);
      })();
      res.json({ ok: true, total: q.countPhotos.get(order.id).n });
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
        customFolders: org.foldersByPhoto.get(p.id) || [],
        people: org.peopleByPhoto.get(p.id) || [],
        year: p.year || '',
        place: p.place || '',
        event: p.event || '',
        caption: p.caption || '',
        enhance: Boolean(p.enhance),
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
      photos,
    });
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

  return { app, db, storage, close: () => db.close() };
}
