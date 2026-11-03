import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@razem/contracts';
import { openDatabase } from '@razem/db';

// Lifecycle only; scheduling/dispatch belongs to the reminders task.
const path = resolve(process.env.DATABASE_PATH ?? './data/razem.sqlite');
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const database = openDatabase(path);
database.sqlite.prepare('SELECT 1').get();
console.info(`Razem: worker gotowy, protokół ${PROTOCOL_VERSION}; harmonogram jeszcze niezaimplementowany`);
const keepAlive = setInterval(() => {}, 60_000);
function stop() {
  clearInterval(keepAlive);
  database.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
