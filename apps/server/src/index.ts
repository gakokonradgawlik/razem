import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '@razem/db';
import { buildApp } from './app.js';

const path = resolve(process.env.DATABASE_PATH ?? './data/razem.sqlite');
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const database = openDatabase(path);
const webRoot = process.env.NODE_ENV === 'production'
  ? fileURLToPath(new URL('../../web/dist', import.meta.url)) : undefined;
const app = await buildApp({ database, ...(webRoot ? { webRoot } : {}) });
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
  await app.listen({ host: process.env.HOST ?? '127.0.0.1', port: Number(process.env.PORT ?? 3100) });
  console.info('Razem: serwer uruchomiony');
} catch {
  await stop();
  console.error('Razem: nie można uruchomić serwera');
  process.exitCode = 1;
}
