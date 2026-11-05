import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '@razem/contracts';
import { ReminderWorker } from './worker.js';
import { vapidFromEnv, webPushTransport, MigrationError, assertSchemaCurrent, openDatabase } from '@razem/db';

// The worker never migrates: it waits (bounded) until the app has applied migrations.
const path = resolve(process.env.DATABASE_PATH ?? './data/razem.sqlite');
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const database = openDatabase(path);
const deadline = Date.now() + Number(process.env.WORKER_SCHEMA_WAIT_MS ?? 60_000);
for (;;) {
  try { assertSchemaCurrent(database.sqlite); break; } catch (error) {
    if (!(error instanceof MigrationError) || Date.now() > deadline) {
      console.error('Razem: worker – schemat bazy nie odpowiada wersji aplikacji');
      database.close();
      process.exit(1);
    }
    await sleep(1000);
  }
}
const vapid = vapidFromEnv();
console.info(`Razem: worker gotowy, protokół ${PROTOCOL_VERSION}; push ${vapid ? 'włączony' : 'nieskonfigurowany'}`);
const worker = vapid ? new ReminderWorker(database, webPushTransport(vapid)) : null;
let stopping = false;
let running: Promise<void> = Promise.resolve();
let busy = false;
const run = () => {
  if (stopping || busy || !worker) return;
  busy = true;
  running = worker.tick().catch(() => { console.error('Razem: cykl przypomnień nie powiódł się'); }).finally(() => { busy = false; });
};
const timer = setInterval(run, 15_000);
run();
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  await running; database.close();
}
process.once('SIGINT', () => { void stop(); });
process.once('SIGTERM', () => { void stop(); });
