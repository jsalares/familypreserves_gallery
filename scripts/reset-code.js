#!/usr/bin/env node
// Give an order a new access code (the old one stops working).
//   npm run reset-code -- FP-1042

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const code = process.argv[2];
const galleryUrl = (process.env.GALLERY_URL || process.env.PUBLIC_URL || '').replace(/\/$/, '');
if (!code || !galleryUrl || !process.env.ADMIN_TOKEN) {
  console.error('Usage: npm run reset-code -- FP-1042   (needs GALLERY_URL and ADMIN_TOKEN in .env)');
  process.exit(2);
}

const res = await fetch(`${galleryUrl}/api/admin/orders/${encodeURIComponent(code)}/reset-code`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(data.error || `Failed with HTTP ${res.status}`);
  process.exit(1);
}
console.log(`Gallery: ${data.order.url}\nNew access code: ${data.accessCode}`);
