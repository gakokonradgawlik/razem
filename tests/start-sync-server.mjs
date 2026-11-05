// E2E-only server for signed-in sync scenarios: the real built app (apps/server/dist,
// apps/web/dist) on 127.0.0.1:4319 with a temporary SQLite and two synthetic accounts.
// Differs from production only in secureCookies=false, because WebKit on Linux does not
// keep Secure cookies over plain http (also on loopback). Removed on exit.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/dist/app.js';
import { hashPassword } from '../apps/server/dist/auth/passwords.js';
import { migrate, openDatabase } from '../packages/db/dist/index.js';

const directory = await mkdtemp(join(tmpdir(), 'razem-e2e-sync-'));
const database = openDatabase(resolve(directory, 'test.sqlite'));
migrate(database.sqlite);
const now = new Date().toISOString();
const household = '00000000-0000-4000-8000-000000000001';
database.sqlite.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run(household, 'Dom testowy', 'Europe/Warsaw', now);
const user = database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
user.run('00000000-0000-4000-8000-0000000000aa', household, 'anna@example.test', 'Anna', await hashPassword('Syntetyczne haslo Anny 2026'), now, now);
user.run('00000000-0000-4000-8000-0000000000bb', household, 'tomek@example.test', 'Tomek', await hashPassword('Syntetyczne haslo Tomka 2026'), now, now);

const app = await buildApp({ database, secureCookies: false, publicOrigin: 'http://127.0.0.1:4319', webRoot: resolve('apps/web/dist') });
await app.listen({ host: '127.0.0.1', port: 4319 });
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await app.close();
  database.close();
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
