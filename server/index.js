import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { app, close } = createApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`Family Preserves gallery running at ${config.publicUrl} (listening on ${config.host}:${config.port}, storage: ${config.storage})`);
});

// NSSM stops the service with Ctrl+C / SIGINT; close the database cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      close();
      process.exit(0);
    });
  });
}
