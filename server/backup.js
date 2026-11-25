// Nightly copy of the database to R2 (or the local files folder when
// STORAGE=local). The photos are already in R2; the database holds everything
// else: orders, access codes, and every customer's folders and details.
//
// Backups are named backups/gallery-YYYY-MM-DD.sqlite and the newest
// KEEP_BACKUPS are kept. To restore one, stop the service, download the file
// from the R2 dashboard, and put it in place of DATA_DIR\gallery.sqlite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BACKUP_PREFIX = 'backups/';
export const KEEP_BACKUPS = 30;
const BACKUP_HOUR = 3; // 3 AM server time, when nobody is sorting photos
const CHECK_EVERY_MS = 20 * 60 * 1000;

const day = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function createBackups({ db, storage, log = console.log }) {
  let running = null;
  let lastError = null;
  let timer = null;

  async function list() {
    const files = (await storage.list(BACKUP_PREFIX)).filter((f) => /\/gallery-\d{4}-\d{2}-\d{2}\.sqlite$/.test(f.key));
    return files.sort((a, b) => b.key.localeCompare(a.key));
  }

  // Copies the live database safely (better-sqlite3's online backup), uploads
  // it, then removes the oldest copies beyond KEEP_BACKUPS.
  async function run() {
    if (running) return running;
    running = (async () => {
      const tmp = path.join(os.tmpdir(), `fpg-backup-${process.pid}-${Date.now()}.sqlite`);
      try {
        await db.backup(tmp);
        const key = `${BACKUP_PREFIX}gallery-${day()}.sqlite`;
        await storage.putFile(key, tmp, 'application/vnd.sqlite3');
        const all = await list();
        const old = all.slice(KEEP_BACKUPS).map((f) => f.key);
        if (old.length) await storage.remove(old);
        lastError = null;
        log(`Database backed up to ${key}`);
        return { key, bytes: fs.statSync(tmp).size };
      } catch (err) {
        lastError = { at: new Date().toISOString(), message: err.message };
        log(`Database backup failed: ${err.message}`);
        throw err;
      } finally {
        fs.rmSync(tmp, { force: true });
        running = null;
      }
    })();
    return running;
  }

  // Runs once a day after BACKUP_HOUR, and on start-up if today's is missing
  // and it's past that hour (so a server restart never skips a night).
  async function tick() {
    if (new Date().getHours() < BACKUP_HOUR) return;
    try {
      const newest = (await list())[0];
      if (newest && newest.key.endsWith(`gallery-${day()}.sqlite`)) return;
      await run();
    } catch {
      // Logged in run(); try again on the next tick.
    }
  }

  return {
    run,
    list,
    status: async () => ({ backups: await list(), lastError, keep: KEEP_BACKUPS }),
    start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, CHECK_EVERY_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    idle: () => running ?? Promise.resolve(),
  };
}
