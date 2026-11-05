import { afterEach, beforeEach, expect, it } from 'vitest';
import { RecordRepository, openDatabase } from '@razem/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../../server/src/app.js';
import { createBackup, restoreBackup } from '../../../server/src/backup/storage.js';
import { accountExportSchema, SYNC_ACCOUNT_HEADER } from '@razem/contracts';
import { A, B, seedDomain } from '../../../../tests/fixtures/installation.js';
import { startServer, Phone, ACCOUNTS } from './test-harness.js';
import type { Server } from './test-harness.js';
import type { AppController } from './controller.js';
import { servicesFor } from './live.js';

let server: Server;
const tabs: AppController[] = [];
beforeEach(async () => { server = await startServer(); });
afterEach(async () => { for (const tab of tabs.splice(0)) await tab.dispose(); await server.close(); });
async function signed(phone: Phone, who: 'a' | 'b') {
  const tab = phone.tab(); tabs.push(tab); await tab.init();
  expect(await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password)).toEqual({ ok: true });
  await tab.syncNow(); return tab;
}
it('eksport wszystkich ośmiu typów i kosza: private A + shared, bez private B i sekretów', async () => {
  const records = seedDomain(server.database), phone = new Phone(server);
  const a = await signed(phone, 'a');
  const repo = new RecordRepository(server.database);
  const note = records.find((r) => r.ownerId === A.userId && r.entityType === 'note')!;
  expect(repo.remove(A, { entityType: 'note', id: note.id, baseVersion: 1 }).status).toBe('ack');
  const data = await a.api.exportAccount(A.userId);
  expect(accountExportSchema.safeParse(data).success).toBe(true);
  expect(data.records).toHaveLength(16);
  expect(new Set(data.records.map((r) => r.entityType)).size).toBe(8);
  expect(data.records.find((r) => r.id === note.id)?.deletedAt).not.toBeNull();
  expect(JSON.stringify(data)).toContain('PRIVATE_A'); expect(JSON.stringify(data)).toContain('SHARED');
  for (const forbidden of ['PRIVATE_B', 'password_hash', 'token_hash', 'cursor_key', 'push_subscriptions', 'p256dh', ACCOUNTS.a.password]) expect(JSON.stringify(data)).not.toContain(forbidden);
  const response = await server.app.inject({ url: '/api/export', headers: { cookie: phone.network.cookie!, [SYNC_ACCOUNT_HEADER]: A.userId } });
  expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['content-disposition']).toContain('attachment');
  expect((await server.app.inject({ url: '/api/export' })).statusCode).toBe(401);
  expect((await server.app.inject({ url: '/api/export', headers: { cookie: phone.network.cookie! } })).statusCode).toBe(409);
  await phone.network.signInElsewhere(ACCOUNTS.b);
  expect((await server.app.inject({ url: '/api/export', headers: { cookie: phone.network.cookie!, [SYNC_ACCOUNT_HEADER]: A.userId } })).statusCode).toBe(409);
  const b = await a.api.exportAccount(B.userId);
  expect(JSON.stringify(b)).not.toContain('PRIVATE_A'); expect(JSON.stringify(b)).toContain('PRIVATE_B');
  server.database.sqlite.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(B.userId);
  expect((await server.app.inject({ url: '/api/export', headers: { cookie: phone.network.cookie!, [SYNC_ACCOUNT_HEADER]: B.userId } })).statusCode).toBe(403);
});

it('pending offline zachowuje kolejne patche, delete/restore, bazę i pełny konflikt; nie mutuje kolejki', async () => {
  const phone = new Phone(server), a = await signed(phone, 'a');
  const b = await signed(new Phone(server), 'b');
  const shared = await a.store!.create('note', { title: 'Wspólna', body: 'baza' }, 'shared');
  if (!shared.ok) throw new Error('create');
  await a.syncNow(); await b.syncNow(); phone.setOffline(true);
  await a.store!.update('note', shared.value, { body: 'lokalny konflikt' });
  await b.store!.update('note', shared.value, { body: 'wersja serwera' }); await b.syncNow();
  phone.setOffline(false); await a.syncNow(); phone.setOffline(true);
  const priv = await a.store!.create('note', { title: 'PRIVATE_A', body: 'pierwsza' }, 'private');
  if (!priv.ok) throw new Error('create');
  await a.store!.update('note', priv.value, { body: 'druga' });
  await a.store!.remove('note', priv.value); await a.store!.restore('note', priv.value);
  const before = { queue: await a.store!.db.queue.toArray(), conflicts: await a.store!.db.conflicts.toArray(), bases: await a.store!.db.bases.toArray() };
  const requests = phone.network.requests.length;
  const data = await a.store!.exportPending(ACCOUNTS.a.login);
  expect(phone.network.requests).toHaveLength(requests);
  expect(data.account.userId).toBe(A.userId); expect(data.formatVersion).toBe(2);
  expect(data.changes.map((q) => q.command)).toEqual(['create', 'update', 'delete', 'restore']);
  expect(data.changes[0]?.data).toEqual({ title: 'PRIVATE_A', body: 'pierwsza' });
  expect(data.changes[1]?.patch).toEqual({ body: 'druga' });
  expect(data.changes.map(({ content: _content, ...q }) => q)).toEqual(before.queue);
  expect(data.conflicts).toEqual(before.conflicts); expect(data.conflicts).toHaveLength(1);
  expect(data.conflicts[0]?.local?.data.body).toBe('lokalny konflikt');
  expect(data.conflicts[0]?.server.kind).toBe('record'); expect(data.conflicts[0]?.mutations).toHaveLength(1);
  expect(data.bases).toEqual(before.bases);
  expect(await a.store!.db.queue.toArray()).toEqual(before.queue);
  expect(JSON.stringify(await b.store!.exportPending(ACCOUNTS.b.login))).not.toContain('PRIVATE_A');
});

it('odpowiedź eksportu starego konta nie pobiera pliku po przełączeniu konta', async () => {
  const phone = new Phone(server), a = await signed(phone, 'a');
  const stale = servicesFor(a, a.getSnapshot());
  phone.network.afterResponse = async (request) => {
    if (request !== 'GET /api/export') return;
    phone.network.afterResponse = null; await a.login(ACCOUNTS.b.login, ACCOUNTS.b.password);
  };
  expect(await stale.exportAccount!()).toEqual({ ok: false, reason: 'account_changed' });
  expect(await stale.exportPending!()).toEqual({ ok: false, reason: 'storage_unavailable' });
});

it('restore odwołuje starą sesję; ponowne logowanie i resync zachowują niewysłaną intencję telefonu', async () => {
  const phone = new Phone(server), a = await signed(phone, 'a');
  const created = await a.store!.create('note', { title: 'Przed backupem', body: 'baza' }, 'private');
  if (!created.ok) throw new Error('create');
  await a.syncNow();
  const dir = mkdtempSync(join(tmpdir(), 'razem-restore-sync-'));
  try {
    const archive = createBackup(server.database.path, join(dir, 'backups'));
    phone.setOffline(true); await a.store!.update('note', created.value, { body: 'zachowaj intencję offline' });
    const before = await a.store!.db.queue.toArray();
    const target = join(dir, 'isolated'); restoreBackup(archive, target);
    const restored = openDatabase(join(target, 'razem.sqlite'));
    const app = await buildApp({ database: restored, publicOrigin: 'https://razem.test', auth: { argon2: { memory: 1024, passes: 1, parallelism: 1 } } });
    const original = server.app;
    try {
      server.app = app; // This synthetic phone now talks to the isolated recovered server.
      phone.setOffline(false); await a.syncNow();
      expect(a.getSnapshot().status.connection).toBe('auth_required');
      expect(await a.store!.db.queue.toArray()).toEqual(before);
      expect(await a.login(ACCOUNTS.a.login, ACCOUNTS.a.password)).toEqual({ ok: true });
      await a.syncNow();
      expect(await a.store!.pendingCount()).toBe(0);
      expect(new RecordRepository(restored).get(A, 'note', created.value)?.data).toMatchObject({ body: 'zachowaj intencję offline' });
      expect(new RecordRepository(restored).get(B, 'note', created.value)).toBeNull();
    } finally { server.app = original; await app.close(); restored.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
