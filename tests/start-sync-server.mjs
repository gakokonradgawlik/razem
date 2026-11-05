// E2E-only server for signed-in sync scenarios: the real built app (apps/server/dist,
// apps/web/dist) on 127.0.0.1:4319 with a temporary SQLite and two synthetic accounts.
// Differs from production only in secureCookies=false, because WebKit on Linux does not
// keep Secure cookies over plain http (also on loopback). Removed on exit.
import { cp, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../apps/server/dist/app.js';
import { hashPassword } from '../apps/server/dist/auth/passwords.js';
import { migrate, openDatabase } from '../packages/db/dist/index.js';
import webpush from 'web-push';
import { buildPwa } from '../scripts/build-pwa.mjs';

const directory = await mkdtemp(join(tmpdir(), 'razem-e2e-sync-'));
const database = openDatabase(resolve(directory, 'test.sqlite'));
migrate(database.sqlite);
const now = new Date().toISOString();
const household = '00000000-0000-4000-8000-000000000001';
database.sqlite.prepare('INSERT INTO households VALUES (?, ?, ?, ?)').run(household, 'Dom testowy', 'Europe/Warsaw', now);
const user = database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, 0, ?, ?)');
user.run('00000000-0000-4000-8000-0000000000aa', household, 'anna@example.test', 'Anna', await hashPassword('Syntetyczne haslo Anny 2026'), now, now);
user.run('00000000-0000-4000-8000-0000000000bb', household, 'tomek@example.test', 'Tomek', await hashPassword('Syntetyczne haslo Tomka 2026'), now, now);

// PWA tests use two independently switchable origins (one per browser project).
const pwa = process.argv[2] === '--pwa';
const push = process.argv[2] === '--push';
const port = pwa || push || process.argv[2] === '--port' ? Number(process.argv[3]) : 4319;
const webRoot = pwa ? resolve(directory, 'web') : resolve('apps/web/dist');
if (pwa) {
  for (const release of ['A', 'B']) {
    const target = resolve(directory, release);
    await cp(resolve('apps/web/dist'), target, { recursive: true });
    let html = await readFile(resolve(target, 'index.html'), 'utf8');
    for (const asset of await readdir(resolve(target, 'assets'))) {
      const next = asset.replace(/\.(js|css)$/, `-${release}.$1`);
      await rename(resolve(target, 'assets', asset), resolve(target, 'assets', next));
      html = html.replaceAll(asset, next);
      if (next.endsWith('.js')) await writeFile(resolve(target, 'assets', next),
        (await readFile(resolve(target, 'assets', next), 'utf8')) + `\ndocument.documentElement.dataset.pwaRelease = '${release}';\n`);
    }
    await writeFile(resolve(target, 'index.html'), html);
    await buildPwa(target);
  }
  await cp(resolve(directory, 'A'), webRoot, { recursive: true });
}
const vapid = push ? { ...webpush.generateVAPIDKeys(), subject: 'mailto:synthetic@example.test' } : undefined;
const app = await buildApp({ ...(vapid ? { vapid } : {}), database, secureCookies: false, publicOrigin: `http://127.0.0.1:${port}`, webRoot });
if (pwa) {
  let unavailable = false;
  app.addHook('onRequest', async (request, reply) => {
    if (unavailable && request.url.startsWith('/api/')) return reply.code(503).send({ error: 'unavailable' });
  });
  app.post('/__test/api/:state', async (request) => {
    unavailable = request.params.state === 'off';
    return { unavailable };
  });
}
if (pwa) app.post('/__test/release/:release', async (request, reply) => {
  const { release } = request.params;
  if (!['A', 'B', 'broken'].includes(release)) return reply.code(400).send();
  const staged = resolve(directory, 'staged');
  await cp(resolve(directory, release === 'broken' ? 'B' : release), staged, { recursive: true });
  if (release === 'broken') {
    const asset = (await readdir(resolve(staged, 'assets'))).find((file) => file.endsWith('.js'));
    await rm(resolve(staged, 'assets', asset));
  }
  // Never briefly expose a complete B before deleting the deliberately missing file.
  await rm(webRoot, { recursive: true, force: true });
  await rename(staged, webRoot);
  return { release };
});
await app.listen({ host: '127.0.0.1', port });
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
