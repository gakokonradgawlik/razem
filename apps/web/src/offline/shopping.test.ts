import Dexie from 'dexie';
import { IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { localDatabaseName } from '../local-db.js';
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
const item = (listId: string, name = 'Żółty ser', sortKey = 7) => ({ listId, name, quantity: '2 opakowania', note: 'świeży, bez ziół', checked: false, sortKey });

it('zakupy: CRUD, odhaczenie/Cofnij, kosz pozycji i całej listy offline; restart i sync do partnera', async () => {
  const phone = new Phone(server), partner = new Phone(server);
  let a = await login(phone, 'a'); const b = await login(partner, 'b');
  phone.setOffline(true);
  const list = ok(await a.command((s) => s.create('shopping_list', { name: 'Targ' }, 'shared')));
  const id = ok(await a.command((s) => s.create('shopping_item', item(list))));
  const removed = ok(await a.command((s) => s.create('shopping_item', item(list, 'Do kosza', 8))));
  ok(await a.command((s) => s.update('shopping_list', list, { name: 'Targ w sobotę' })));
  ok(await a.command((s) => s.update('shopping_item', id, { name: 'Żółty ser i twaróg', quantity: '3 opakowania' })));
  ok(await a.command((s) => s.update('shopping_item', id, { checked: true })));
  ok(await a.command((s) => s.update('shopping_item', id, { checked: false })));
  ok(await a.command((s) => s.remove('shopping_item', id)));
  expect((await a.store!.trash()).map((r) => r.id)).toEqual([id]);
  ok(await a.command((s) => s.restore('shopping_item', id)));
  ok(await a.command((s) => s.remove('shopping_item', removed)));
  ok(await a.command((s) => s.remove('shopping_list', list)));
  expect(await a.store!.list('shopping_item', list)).toEqual([]);
  expect(await a.store!.get(id)).toBeUndefined();
  expect((await a.store!.trash()).map((r) => r.id)).toEqual([list]);
  expect(await a.command((s) => s.update('shopping_item', id, { checked: true }))).toMatchObject({ ok: false, reason: 'not_found' });
  expect(await a.command((s) => s.restore('shopping_item', removed))).toMatchObject({ ok: false, reason: 'not_found' });
  ok(await a.command((s) => s.restore('shopping_list', list)));
  const before = await a.store!.db.queue.toArray();
  await a.dispose(); tabs.splice(tabs.indexOf(a), 1);
  a = phone.tab(); tabs.push(a); await a.init();
  expect(await a.store!.db.queue.toArray()).toEqual(before);
  expect(await a.store!.get(id)).toMatchObject({ data: { name: 'Żółty ser i twaróg', quantity: '3 opakowania', checked: false, sortKey: 7 } });
  phone.setOffline(false);
  phone.network.losePushResponses = 1;
  await a.syncNow(); await a.syncNow(); await b.syncNow();
  expect(a.getSnapshot()).toMatchObject({ unsent: 0, attention: 0 });
  expect(await b.store!.list('shopping_item', list)).toMatchObject([{ id, data: { name: 'Żółty ser i twaróg', checked: false, sortKey: 7 } }]);
  expect((await b.store!.trash()).map((r) => r.id)).toEqual([removed]);
  expect(server.count('shopping_lists')).toBe(1); expect(server.count('shopping_items')).toBe(2);
});

it('zakupy: różne pozycje łączą się; ten sam wpis zachowuje obie wersje i rozwiązuje konflikt', async () => {
  const phoneA = new Phone(server), phoneB = new Phone(server);
  const a = await login(phoneA, 'a'), b = await login(phoneB, 'b');
  const list = ok(await a.command((s) => s.create('shopping_list', { name: 'Wspólne' }, 'shared')));
  const first = ok(await a.command((s) => s.create('shopping_item', item(list))));
  const second = ok(await a.command((s) => s.create('shopping_item', item(list, 'Bułki'))));
  await a.syncNow(); await b.syncNow();
  phoneA.setOffline(true); phoneB.setOffline(true);
  ok(await a.command((s) => s.update('shopping_item', first, { quantity: '4 opakowania' })));
  ok(await b.command((s) => s.update('shopping_item', second, { checked: true })));
  phoneA.setOffline(false); phoneB.setOffline(false);
  await a.syncNow(); await b.syncNow(); await a.syncNow();
  for (const tab of [a, b]) {
    expect(tab.getSnapshot().attention).toBe(0);
    expect(await tab.store!.get(first)).toMatchObject({ data: { quantity: '4 opakowania', sortKey: 7 } });
    expect(await tab.store!.get(second)).toMatchObject({ data: { checked: true, sortKey: 7 } });
  }
  phoneA.setOffline(true); phoneB.setOffline(true);
  ok(await a.command((s) => s.update('shopping_item', first, { note: 'Wersja Anny' })));
  ok(await b.command((s) => s.update('shopping_item', first, { note: 'Wersja Tomka' })));
  phoneA.setOffline(false); await a.syncNow(); phoneB.setOffline(false); await b.syncNow();
  const [conflict] = await b.store!.db.conflicts.toArray();
  expect(conflict).toMatchObject({ local: { data: { note: 'Wersja Tomka' } }, server: { record: { data: { note: 'Wersja Anny' } } } });
  ok(await b.command((s) => s.resolve(conflict!.id, { choice: 'mine' })));
  await b.syncNow(); await a.syncNow();
  expect(await a.store!.get(first)).toMatchObject({ data: { note: 'Wersja Tomka', sortKey: 7 } });
  expect(b.getSnapshot()).toMatchObject({ attention: 0, unsent: 0 });
});

it('zakupy: prywatna lista i dzieci nie wyciekają; guessed ID i podmiana listId są odrzucane', async () => {
  const pa = new Phone(server), pb = new Phone(server);
  const a = await login(pa, 'a'), b = await login(pb, 'b');
  const privateList = ok(await a.command((s) => s.create('shopping_list', { name: 'Prywatna apteka' }, 'private')));
  const secret = ok(await a.command((s) => s.create('shopping_item', item(privateList, 'Prywatny produkt'))));
  const shared = ok(await a.command((s) => s.create('shopping_list', { name: 'Wspólna' }, 'shared')));
  const publicItem = ok(await a.command((s) => s.create('shopping_item', item(shared))));
  const wrongParent = ok(await a.command((s) => s.create('note', { title: 'Nie lista', body: '' }, 'shared')));
  expect(await a.command((s) => s.create('shopping_item', item(wrongParent)))).toMatchObject({ ok: false, reason: 'not_found' });
  expect(await a.command((s) => s.update('shopping_item', publicItem, { listId: privateList }))).toMatchObject({ ok: false, reason: 'invalid' });
  await a.syncNow(); await b.syncNow();
  expect(await b.store!.get(secret)).toBeUndefined(); expect(await b.store!.get(privateList)).toBeUndefined();
  const rawPush = async (mutations: Record<string, unknown>[]) => {
    const response = await server.app.inject({ method: 'POST', url: '/api/sync/push',
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: pb.network.cookie!, 'x-razem-protocol': '2', 'x-razem-account': ACCOUNTS.b.id },
      payload: { protocolVersion: 2, deviceId: crypto.randomUUID(), mutations } });
    expect(response.statusCode).toBe(200); return response.json();
  };
  for (const entityId of [secret, crypto.randomUUID()]) {
    for (const command of ['update', 'delete', 'restore']) {
      const response = await rawPush([{ clientMutationId: crypto.randomUUID(), entityType: 'shopping_item', entityId, command, baseVersion: 1,
        ...(command === 'update' ? { patch: { name: 'Przejęte' } } : {}) }]);
      expect(response.results[0]).toMatchObject({ status: 'error', code: 'not_found' });
      expect(response.results[0]).not.toHaveProperty('state');
    }
  }
  const changed = await rawPush([{ clientMutationId: crypto.randomUUID(), entityType: 'shopping_item', entityId: publicItem, command: 'update', baseVersion: 1, patch: { listId: privateList } }]);
  expect(changed.results[0]).toMatchObject({ status: 'error', code: 'validation_error' });
  const forged = await rawPush([{ clientMutationId: crypto.randomUUID(), entityType: 'shopping_item', entityId: crypto.randomUUID(), command: 'create', baseVersion: 0, data: item(privateList) }]);
  expect(forged.results[0]).toMatchObject({ status: 'error', code: 'not_found' });
  ok(await a.command((s) => s.remove('shopping_item', secret)));
  await a.syncNow(); await b.syncNow(); expect(await b.store!.trash()).toEqual([]);
  expect(JSON.stringify(await b.store!.db.records.toArray())).not.toContain('Prywatny');
});

it('zakupy: migracja v1 z dzieckiem przed rodzicem zachowuje payload, ID i kolejność po ACK', async () => {
  const phone = new Phone(server), scope = { userId: ACCOUNTS.a.id, householdId: HOUSEHOLD };
  const legacy = new Dexie(localDatabaseName(scope), { indexedDB: phone.indexedDB, IDBKeyRange });
  legacy.version(1).stores({ records: 'id, entityType, visibility', outbox: 'mutation.clientMutationId, queuedAt, state', conflicts: 'id', cursors: 'key' });
  const listId = crypto.randomUUID(), itemId = crypto.randomUUID(), deviceId = crypto.randomUUID();
  const now = new Date().toISOString();
  const entries = [
    { entityType: 'shopping_item', entityId: itemId, data: item(listId), clientMutationId: '00000000-0000-4000-8000-000000000001' },
    { entityType: 'shopping_list', entityId: listId, data: { name: 'Stara lista' }, clientMutationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff', visibility: 'shared' },
  ];
  for (const m of entries) {
    await legacy.table('records').put({ id: m.entityId, entityType: m.entityType, householdId: HOUSEHOLD, ownerId: ACCOUNTS.a.id,
      visibility: 'shared', version: 0, createdAt: now, updatedAt: now, deletedAt: null, data: m.data });
    await legacy.table('outbox').put({ deviceId, queuedAt: now, attempts: 2, state: 'pending', mutation: { ...m, command: 'create', baseVersion: 0 } });
  }
  legacy.close();
  const tab = await login(phone, 'a');
  expect(await tab.store!.deviceId()).toBe(deviceId);
  expect(await tab.store!.get(itemId)).toMatchObject({ parentId: listId, data: item(listId), version: 1 });
  expect(tab.getSnapshot()).toMatchObject({ unsent: 0, attention: 0 });
  expect(server.pushes.flat()).toEqual([entries[1]!.clientMutationId, entries[0]!.clientMutationId]);
});
