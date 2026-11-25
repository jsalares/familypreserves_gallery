import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { app, close, backups } = createApp(config);
backups.start(); // nightly database backup (see server/backup.js)

const server = app.listen(config.port, config.host, () => {
  console.log(`Family Preserves gallery running at ${config.publicUrl} (listening on ${config.host}:${config.port}, storage: ${config.storage})`);
});

// NSSM stops the service with Ctrl+C / SIGINT; close the database cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await close();
      process.exit(0);
    });
    // Don't wait forever for a long download to finish.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
