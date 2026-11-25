import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import crypto from 'node:crypto';
import { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { sign, unsign } from './auth.js';

const VIEW_LINK_SECONDS = 6 * 3600; // thumbnails and screen copies
const UPLOAD_LINK_SECONDS = 2 * 3600;

// Keys look like orders/FP-1042/enhanced/<sha256>.jpg. Folder and file
// names come from Jason's PC, so refuse anything that could escape the order.
export function assertSafeKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 1024) throw new Error('Bad storage key');
  if (key.startsWith('/') || key.includes('\\') || /[\x00-\x1f\x7f]/.test(key)) throw new Error('Bad storage key');
  for (const seg of key.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') throw new Error('Bad storage key');
  }
  return key;
}

export function createStorage(config) {
  return config.storage === 'r2' ? r2Storage(config) : localStorage(config);
}

// ---- Cloudflare R2 (production) ----

function r2Storage(config) {
  const { accountId, accessKeyId, secretAccessKey, bucket } = config.r2;
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return {
    kind: 'r2',
    async exists(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: assertSafeKey(key) }));
        return true;
      } catch (err) {
        if (err?.$metadata?.httpStatusCode === 404 || err?.name === 'NotFound') return false;
        throw err;
      }
    },
    viewUrl(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(key) }), {
        expiresIn: VIEW_LINK_SECONDS,
      });
    },
    // A stream of the file's bytes, for building downloads on the server.
    async read(key) {
      const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(key) }));
      return out.Body;
    },
    uploadUrl(key, contentType) {
      return getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucket, Key: assertSafeKey(key), ContentType: contentType }),
        { expiresIn: UPLOAD_LINK_SECONDS }
      );
    },
  };
}

// ---- Local disk (development and tests) ----
// Files live under DATA_DIR/files and are served by the app itself through
// signed links that work the same way as R2's.

function localStorage(config) {
  const base = path.join(config.dataDir, 'files');
  const fileFor = (key) => path.join(base, ...assertSafeKey(key).split('/'));
  const link = (key, method, seconds) => {
    const token = sign(config.sessionSecret, { k: key, m: method, exp: Date.now() + seconds * 1000 });
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${config.publicUrl}/files/${encoded}?t=${token}`;
  };
  return {
    kind: 'local',
    base,
    async exists(key) {
      return fs.existsSync(fileFor(key));
    },
    async viewUrl(key) {
      return link(assertSafeKey(key), 'GET', VIEW_LINK_SECONDS);
    },
    async uploadUrl(key) {
      return link(assertSafeKey(key), 'PUT', UPLOAD_LINK_SECONDS);
    },
    async read(key) {
      return fs.createReadStream(fileFor(key));
    },
    // Express handlers for the signed links above.
    routes(app) {
      const check = (req, method) => {
        const key = decodeURIComponent(req.path.replace(/^\/files\//, ''));
        const data = unsign(config.sessionSecret, req.query.t);
        if (!data || data.m !== method || data.k !== key || data.exp < Date.now()) return null;
        return key;
      };
      app.get(/^\/files\/.+/, (req, res) => {
        const key = check(req, 'GET');
        if (!key) return res.status(403).end();
        const file = fileFor(key);
        if (!fs.existsSync(file)) return res.status(404).end();
        res.sendFile(file);
      });
      app.put(/^\/files\/.+/, async (req, res) => {
        const key = check(req, 'PUT');
        if (!key) return res.status(403).end();
        const file = fileFor(key);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.part`;
        try {
          await pipeline(req, fs.createWriteStream(tmp));
          fs.renameSync(tmp, file);
          res.status(200).end();
        } catch (err) {
          fs.rmSync(tmp, { force: true });
          res.status(500).end();
        }
      });
    },
  };
}
