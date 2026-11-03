import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PROTOCOL_VERSION } from '@razem/contracts';
import { MigrationError, assertSchemaCurrent, openDatabase } from '@razem/db';

// Lifecycle only; scheduling/dispatch belongs to the reminders task.
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
console.info(`Razem: worker gotowy, protokół ${PROTOCOL_VERSION}; harmonogram jeszcze niezaimplementowany`);
const keepAlive = setInterval(() => {}, 60_000);
function stop() {
  clearInterval(keepAlive);
  database.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
