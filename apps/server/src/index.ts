import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { argon2ParamsFromEnv } from './auth/passwords.js';
import { openMigratedDatabase, serverSettings } from './config.js';

const settings = serverSettings();
// Controlled migrations: only the app applies them (transactional, checksummed, with a
// pre-migration copy); the worker refuses to run on a different schema version.
const { database, migration } = openMigratedDatabase(settings.databasePath);
if (migration.applied.length > 0) console.info(`Razem: zastosowano migracje ${migration.applied.join(', ')}`);
if (settings.production && !settings.publicOrigin) console.warn('Razem: brak PUBLIC_ORIGIN – mutacje przyjmowane tylko z originu równego nagłówkowi Host');
const webRoot = settings.production ? fileURLToPath(new URL('../../web/dist', import.meta.url)) : undefined;
const app = await buildApp({
  database, ...(webRoot ? { webRoot } : {}), secureCookies: settings.secureCookies, trustProxy: settings.trustProxy,
  ...(settings.publicOrigin ? { publicOrigin: settings.publicOrigin } : {}), auth: { argon2: argon2ParamsFromEnv() },
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  database.close();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
try {
  await app.listen({ host: settings.host, port: settings.port });
  console.info('Razem: serwer uruchomiony');
} catch {
  await stop();
  console.error('Razem: nie można uruchomić serwera');
  process.exitCode = 1;
}
