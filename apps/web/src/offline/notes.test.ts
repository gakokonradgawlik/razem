import Dexie from 'dexie';
import { IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { localDatabaseName } from '../local-db.js';
import { servicesFor } from './live.js';
import { ACCOUNTS, HOUSEHOLD, ORIGIN, Phone, startServer } from './test-harness.js';
import type { Server } from './test-harness.js';
import type { AppController } from './controller.js';

let server: Server;
const tabs: AppController[] = [];
beforeEach(async () => { server = await startServer(); });
afterEach(async () => { for (const tab of tabs.splice(0)) await tab.dispose(); await server.close(); });
const ok = <T>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};
async function login(phone: Phone, who: 'a' | 'b') {
  const tab = phone.tab(); tabs.push(tab); await tab.init();
  expect(await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password)).toEqual({ ok: true });
  await tab.syncNow(); return tab;
}
const data = { title: 'Żółw i łódź 🐢', body: 'Zażółć gęślą jaźń\n🧑‍🍳 <img src=x onerror=alert(1)>' };

it('notatki: prywatny oryginał, niezależna wspólna kopia, kosz/restore offline, restart i utrata odpowiedzi bez duplikatu', async () => {
  const phone = new Phone(server), partner = new Phone(server);
  let a = await login(phone, 'a'); const b = await login(partner, 'b');
  phone.setOffline(true);
  const id = ok(await a.command((s) => s.create('note', data, 'private')));
  const input = { sourceId: id, copyId: crypto.randomUUID(), data };
  ok(await a.command((s) => s.shareNote(input)));
  ok(await a.command((s) => s.shareNote(input)));
  expect(await a.store!.db.queue.count()).toBe(2);
  const copyMutation = (await a.store!.db.queue.toArray()).find((q) => q.entityId === input.copyId)!;
  expect(JSON.stringify(copyMutation)).not.toContain(id);
  ok(await a.command((s) => s.update('note', id, { body: 'Prywatna poprawka 🔐' })));
  ok(await a.command((s) => s.remove('note', input.copyId)));
  expect((await a.store!.trash()).map((r) => r.id)).toEqual([input.copyId]);
  ok(await a.command((s) => s.restore('note', input.copyId)));
  const before = await a.store!.db.queue.toArray();
  await a.dispose(); tabs.splice(tabs.indexOf(a), 1);
  a = phone.tab(); tabs.push(a); await a.init();
  expect(await a.store!.db.queue.toArray()).toEqual(before);
  expect(await a.store!.get(id)).toMatchObject({ visibility: 'private', data: { body: 'Prywatna poprawka 🔐' } });
  expect(await a.store!.get(input.copyId)).toMatchObject({ visibility: 'shared', data });
  phone.setOffline(false); phone.network.losePushResponses = 1;
  await a.syncNow(); await a.syncNow(); await b.syncNow();
  expect(server.count('notes')).toBe(2);
  expect(a.getSnapshot()).toMatchObject({ unsent: 0, attention: 0 });
  expect(await b.store!.list('note')).toMatchObject([{ id: input.copyId, data }]);
  expect(await b.store!.get(id)).toBeUndefined();
  ok(await b.command((s) => s.update('note', input.copyId, { title: 'Wspólna poprawka' })));
  await b.syncNow(); await a.syncNow();
  expect(await a.store!.get(id)).toMatchObject({ visibility: 'private', data: { title: data.title } });
  expect(await a.store!.get(input.copyId)).toMatchObject({ data: { title: 'Wspólna poprawka' } });
});

it('notatki: quota wycofuje całą kopię; retry zachowuje ID, błędny zakres/ID i cudzy oryginał są odrzucane', async () => {
  const phone = new Phone(server); const a = await login(phone, 'a'); phone.setOffline(true);
  const sourceId = ok(await a.command((s) => s.create('note', data, 'private')));
  const input = { sourceId, copyId: crypto.randomUUID(), data };
  const fail = () => { throw new DOMException('full', 'QuotaExceededError'); };
  a.store!.db.queue.hook('creating', fail);
  expect(await a.command((s) => s.shareNote(input))).toEqual({ ok: false, reason: 'storage_full' });
  expect(await a.store!.get(input.copyId)).toBeUndefined();
  expect(await a.store!.db.queue.count()).toBe(1);
  a.store!.db.queue.hook('creating').unsubscribe(fail);
  ok(await a.command((s) => s.shareNote(input)));
  const queue = await a.store!.db.queue.toArray();
  await Promise.all([a.command((s) => s.shareNote(input)), a.command((s) => s.shareNote(input))]);
  expect(await a.store!.db.queue.toArray()).toEqual(queue);
  for (const invalid of [{ ...input, copyId: sourceId }, { ...input, copyId: 'bad' }, { ...input, sourceId: input.copyId }, { ...input, data: { ...data, body: 'inny payload' } }]) {
    expect(await a.command((s) => s.shareNote(invalid))).toMatchObject({ ok: false, reason: 'invalid' });
  }
  phone.setOffline(false); await a.syncNow();
  const stale = servicesFor(a, a.getSnapshot());
  await a.login(ACCOUNTS.b.login, ACCOUNTS.b.password); await a.syncNow();
  expect(await stale.shareNote!(input)).toEqual({ ok: false, reason: 'account_changed' });
  expect(await a.command((s) => s.shareNote({ ...input, copyId: crypto.randomUUID() }))).toEqual({ ok: false, reason: 'not_found' });
});

it('notatki ACL: prywatny tytuł/tekst/ID nie przechodzi do API, pull, konfliktu, kosza, lokalnego wyszukiwania ani eksportu partnera', async () => {
  const pa = new Phone(server), pb = new Phone(server);
  const a = await login(pa, 'a'), b = await login(pb, 'b');
  const id = ok(await a.command((s) => s.create('note', data, 'private')));
  await a.syncNow(); await b.syncNow();
  const headers = { origin: ORIGIN, cookie: pb.network.cookie!, 'x-razem-protocol': '2', 'x-razem-account': ACCOUNTS.b.id };
  const hidden = (value: unknown) => { const text = JSON.stringify(value); for (const secret of [id, data.title, data.body]) expect(text).not.toContain(secret); };
  for (const command of ['update', 'delete', 'restore']) {
    for (const entityId of [id, crypto.randomUUID()]) {
      const result = await server.app.inject({ method: 'POST', url: '/api/sync/push', headers, payload: {
        protocolVersion: 2, deviceId: crypto.randomUUID(), mutations: [{ entityId, entityType: 'note', command, baseVersion: 999,
          clientMutationId: crypto.randomUUID(), ...(command === 'update' ? { patch: { body: 'Próba przejęcia' } } : {}) }],
      } });
      expect(result.statusCode).toBe(200);
      const response = result.json().results[0];
      // Correlation echoes the ID supplied by the attacker; no server state or version is returned.
      expect(response).toMatchObject({ status: 'error', code: 'not_found' }); expect(response).not.toHaveProperty('state');
      expect(Object.keys(response).sort()).toEqual(['clientMutationId', 'code', 'entityId', 'entityType', 'retryable', 'status']);
    }
  }
  // Visibility cannot be changed, even by the owner.
  const forbidden = await server.app.inject({ method: 'POST', url: '/api/sync/push', headers: { ...headers, cookie: pa.network.cookie!, 'x-razem-account': ACCOUNTS.a.id }, payload: {
    protocolVersion: 2, deviceId: crypto.randomUUID(), mutations: [{ entityId: id, entityType: 'note', command: 'update', baseVersion: 1, clientMutationId: crypto.randomUUID(), patch: { visibility: 'shared' } }],
  } });
  expect(forbidden.json().results[0]).toMatchObject({ status: 'error', code: 'validation_error' });
  for (const url of [`/api/notes/${id}`, `/api/notes?search=${encodeURIComponent(data.title)}`]) {
    const result = await server.app.inject({ method: 'GET', url, headers });
    expect(result.statusCode).toBe(404); hidden(result.json());
  }
  for (const trash of [false, true]) {
    if (trash) { ok(await a.command((s) => s.remove('note', id))); await a.syncNow(); await b.syncNow(); }
    const exported = await server.app.inject({ method: 'GET', url: '/api/export', headers });
    expect(exported.statusCode).toBe(200); hidden(exported.json());
    let cursor: string | undefined;
    do {
      const response = await server.app.inject({ method: 'GET', url: `/api/sync/pull?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, headers });
      expect(response.statusCode).toBe(200); const body = response.json(); hidden(body); cursor = body.hasMore ? body.nextCursor : undefined;
    } while (cursor);
    expect(await b.store!.list('note')).toEqual([]); expect(await b.store!.trash()).toEqual([]);
    expect(await b.store!.get(id)).toBeUndefined();
    hidden(await b.store!.db.records.toArray()); hidden(await b.store!.attention()); hidden(await b.store!.exportPending(ACCOUNTS.b.login));
  }
});

it('notatki: dwie edycje zachowują tekst po restarcie i po błędzie scalania, kolejna edycja serwera daje ponowny konflikt', async () => {
  const pa = new Phone(server), pb = new Phone(server);
  const a = await login(pa, 'a'); let b = await login(pb, 'b');
  const id = ok(await a.command((s) => s.create('note', data, 'shared')));
  await a.syncNow(); await b.syncNow(); pa.setOffline(true); pb.setOffline(true);
  ok(await a.command((s) => s.update('note', id, { body: 'Żółw 🐢 – Anna' })));
  ok(await b.command((s) => s.update('note', id, { body: 'Łódź ⛵ – Tomek' })));
  pa.setOffline(false); await a.syncNow(); pb.setOffline(false); await b.syncNow();
  const [conflict] = await b.store!.db.conflicts.toArray();
  expect(conflict).toMatchObject({ local: { data: { body: 'Łódź ⛵ – Tomek' } }, server: { record: { data: { body: 'Żółw 🐢 – Anna' } } } });
  await b.dispose(); tabs.splice(tabs.indexOf(b), 1); pb.setOffline(true);
  b = pb.tab(); tabs.push(b); await b.init();
  expect(await b.store!.conflict(conflict!.id)).toEqual(conflict);
  const fail = () => { throw new DOMException('full', 'QuotaExceededError'); };
  b.store!.db.queue.hook('creating', fail);
  const merged = { ...data, body: 'Żółw 🐢 i łódź ⛵' };
  expect(await b.command((s) => s.resolve(conflict!.id, { choice: 'merge', data: merged }))).toMatchObject({ ok: false, reason: 'storage_full' });
  expect(await b.store!.conflict(conflict!.id)).toEqual(conflict);
  b.store!.db.queue.hook('creating').unsubscribe(fail);
  ok(await a.command((s) => s.update('note', id, { body: 'Jeszcze jedna zmiana ✍️' }))); await a.syncNow();
  ok(await b.command((s) => s.resolve(conflict!.id, { choice: 'merge', data: merged }))); pb.setOffline(false); await b.syncNow();
  const [again] = await b.store!.db.conflicts.toArray();
  expect(again).toMatchObject({ local: { data: merged }, server: { record: { data: { body: 'Jeszcze jedna zmiana ✍️' } } } });
  ok(await b.command((s) => s.resolve(again!.id, { choice: 'merge', data: { ...merged, body: merged.body + '\nJeszcze jedna zmiana ✍️' } })));
  await b.syncNow(); await a.syncNow();
  expect(await a.store!.get(id)).toMatchObject({ data: { body: merged.body + '\nJeszcze jedna zmiana ✍️' } });
});

it('notatki: migracja v1 zachowuje prywatny tekst Unicode, mutationId/deviceId i retry po utracie ACK', async () => {
  const phone = new Phone(server), scope = { userId: ACCOUNTS.a.id, householdId: HOUSEHOLD };
  const legacy = new Dexie(localDatabaseName(scope), { indexedDB: phone.indexedDB, IDBKeyRange });
  legacy.version(1).stores({ records: 'id, entityType, visibility', outbox: 'mutation.clientMutationId, queuedAt, state', conflicts: 'id', cursors: 'key' });
  const id = crypto.randomUUID(), deviceId = crypto.randomUUID(), clientMutationId = crypto.randomUUID(), now = new Date().toISOString();
  await legacy.table('records').put({ id, entityType: 'note', householdId: HOUSEHOLD, ownerId: ACCOUNTS.a.id, visibility: 'private', version: 0, createdAt: now, updatedAt: now, deletedAt: null, data });
  await legacy.table('outbox').put({ deviceId, queuedAt: now, attempts: 2, state: 'pending', mutation: { clientMutationId, entityId: id, entityType: 'note', command: 'create', baseVersion: 0, visibility: 'private', data } });
  legacy.close(); phone.network.losePushResponses = 1;
  const a = await login(phone, 'a'); await a.syncNow();
  expect(await a.store!.deviceId()).toBe(deviceId);
  expect(await a.store!.get(id)).toMatchObject({ version: 1, visibility: 'private', data });
  expect(new Set(server.pushes.flat())).toEqual(new Set([clientMutationId])); expect(server.count('notes')).toBe(1);
  const b = await login(new Phone(server), 'b'); expect(await b.store!.list('note')).toEqual([]);
});
