import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

// Load .env from the project folder when present. On the server, NSSM can set
// the same variables instead (see docs/deploy-kamatera.md).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required setting ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export function loadConfig(overrides = {}) {
  const env = { ...process.env, ...overrides };
  const storage = env.STORAGE || 'local';
  const config = {
    root,
    port: Number(env.PORT || 3000),
    host: env.HOST || '127.0.0.1',
    publicUrl: (env.PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
    dataDir: env.DATA_DIR || path.join(root, 'data'),
    sessionSecret: env.SESSION_SECRET || required('SESSION_SECRET'),
    adminToken: env.ADMIN_TOKEN || required('ADMIN_TOKEN'),
    storage,
    // How long a new gallery stays open, in days (0 = no end date).
    galleryDays: env.GALLERY_DAYS === undefined || env.GALLERY_DAYS === '' ? 90 : Math.max(0, Number(env.GALLERY_DAYS) || 0),
    r2: storage === 'r2'
      ? {
          accountId: env.R2_ACCOUNT_ID || required('R2_ACCOUNT_ID'),
          accessKeyId: env.R2_ACCESS_KEY_ID || required('R2_ACCESS_KEY_ID'),
          secretAccessKey: env.R2_SECRET_ACCESS_KEY || required('R2_SECRET_ACCESS_KEY'),
          bucket: env.R2_BUCKET || required('R2_BUCKET'),
        }
      : null,
  };
  if (config.sessionSecret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
  if (config.adminToken.length < 24) throw new Error('ADMIN_TOKEN must be at least 24 characters.');
  return config;
}
