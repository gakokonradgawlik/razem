import Dexie from 'dexie';
import { IDBKeyRange } from 'fake-indexeddb';
import { localDatabaseName } from '../local-db.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Phone, ACCOUNTS, HOUSEHOLD, startServer } from './test-harness.js';
import type { Server } from './test-harness.js';
import type { AppController } from './controller.js';
let server: Server;
const tabs: AppController[] = [];
beforeEach(async () => { server = await startServer(); });
afterEach(async () => { for (const tab of tabs.splice(0)) await tab.dispose(); await server.close(); });
async function phone(device: Phone, who: 'a' | 'b') {
  const tab = device.tab(); tabs.push(tab); await tab.init();
  expect(await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password)).toEqual({ ok: true }); return tab;
}
const event = { title: 'Podróż', description: 'Syntetyczny opis', allDay: true, timezone: 'Pacific/Kiritimati', startDate: '2026-12-30', endDate: '2027-01-03', startAt: null, endAt: null };
const reminder = { enabled: true, minutesBefore: 0, localTime: '09:00' };
it('offline CRUD każdego rodzaju, restart, utrata ACK i drugi telefon; private poza sync, agendą i przypomnieniami', async () => {
  const device = new Phone(server), a = await phone(device, 'a'), b = await phone(new Phone(server), 'b');
  device.setOffline(true);
  const inputs = [event, { ...event, title: 'Godzinowe', allDay: false, startDate: null, endDate: null, startAt: '2026-12-31T22:00:00Z', endAt: '2027-01-01T05:00:00Z' }];
  for (const data of inputs) expect((await a.store!.saveCalendar({ entityType: 'calendar_event', visibility: 'shared', data, reminder })).ok).toBe(true);
  const annual = { name: 'Bez roku', month: 2, day: 29, startYear: null, kind: 'anniversary' };
  expect((await a.store!.saveCalendar({ entityType: 'important_date', visibility: 'shared', data: annual, reminder })).ok).toBe(true);
  for (const entityType of ['calendar_event', 'important_date'] as const) {
    const data = entityType === 'calendar_event' ? { ...event, title: 'TAJNE' } : { ...annual, name: 'TAJNE' };
    expect((await a.store!.saveCalendar({ entityType, visibility: 'private', data, reminder })).ok).toBe(true);
  }
  const initialEvents = await a.store!.list('calendar_event');
  await a.dispose();
  const restarted = device.tab(); tabs.push(restarted); await restarted.init();
  expect(await restarted.store!.list('calendar_event')).toEqual(initialEvents);
  device.setOffline(false); device.network.losePushResponses = 1;
  await restarted.syncNow(); await restarted.syncNow(); await b.syncNow();
  expect(await restarted.store!.pendingCount()).toBe(0);
  expect(await b.store!.list('calendar_event')).toHaveLength(2);
  expect(await b.store!.list('important_date')).toHaveLength(1);
  expect(await b.store!.list('reminder')).toHaveLength(3);
  expect(JSON.stringify(await b.store!.exportPending('b'))).not.toContain('TAJNE');
  for (const privateRecord of initialEvents.filter((r) => r.visibility === 'private')) {
    expect(await b.store!.get(privateRecord.id)).toBeUndefined();
    expect(server.sync.records.get({ householdId: privateRecord.householdId, userId: ACCOUNTS.b.id }, 'calendar_event', privateRecord.id)).toBeNull();
  }
  device.setOffline(true);
  for (const record of [...await restarted.store!.list('calendar_event'), ...await restarted.store!.list('important_date')]) {
    expect((await restarted.store!.saveCalendar({ entityType: record.entityType as 'calendar_event' | 'important_date', id: record.id, visibility: record.visibility,
      data: record.entityType === 'calendar_event' ? { ...record.data, description: 'Edycja offline' } : { ...record.data, name: 'Poprawiona data' }, reminder: { ...reminder, enabled: false } })).ok).toBe(true);
  }
  device.setOffline(false); await restarted.syncNow(); await b.syncNow();
  expect((await b.store!.list('calendar_event')).every((r) => r.data.description === 'Edycja offline')).toBe(true);
  expect((await b.store!.list('reminder')).every((r) => !r.data.enabled)).toBe(true);
  device.setOffline(true);
  for (const record of [...await restarted.store!.list('calendar_event'), ...await restarted.store!.list('important_date')]) expect((await restarted.store!.remove(record.entityType, record.id)).ok).toBe(true);
  expect(await restarted.store!.list('reminder')).toHaveLength(0);
  device.setOffline(false); await restarted.syncNow(); await b.syncNow();
  expect(await b.store!.list('calendar_event')).toHaveLength(0); expect(await b.store!.list('important_date')).toHaveLength(0);
});
it('niepoprawne przypomnienie i quota wycofują także rodzica oraz outbox', async () => {
  const a = await phone(new Phone(server), 'a');
  expect((await a.store!.saveCalendar({ entityType: 'calendar_event', visibility: 'shared', data: event, reminder: { ...reminder, localTime: '27:00' } })).ok).toBe(false);
  expect(await a.store!.db.records.count()).toBe(0); expect(await a.store!.pendingCount()).toBe(0);
  const add = a.store!.db.queue.add.bind(a.store!.db.queue); let calls = 0;
  const fail = vi.spyOn(a.store!.db.queue, 'add').mockImplementation((...args) => { if (++calls === 2) throw new DOMException('Quota', 'QuotaExceededError'); return add(...args); });
  expect(await a.store!.saveCalendar({ entityType: 'calendar_event', visibility: 'shared', data: event, reminder })).toEqual({ ok: false, reason: 'storage_full' });
  fail.mockRestore(); expect(await a.store!.db.records.count()).toBe(0); expect(await a.store!.pendingCount()).toBe(0);
});

it('IndexedDB v1 → v2 zachowuje daty, parent przypomnienia i oczekujące intencje do sync', async () => {
  const device = new Phone(server);
  const legacy = new Dexie(localDatabaseName({ userId: ACCOUNTS.a.id, householdId: HOUSEHOLD }), { indexedDB: device.indexedDB, IDBKeyRange });
  legacy.version(1).stores({ records: 'id, entityType, visibility', outbox: 'mutation.clientMutationId, queuedAt, state', conflicts: 'id', cursors: 'key' });
  const id = crypto.randomUUID(), rid = crypto.randomUUID(), deviceId = crypto.randomUUID(), now = new Date().toISOString();
  const data = [{ id, entityType: 'calendar_event', data: event, visibility: 'private' }, { id: rid, entityType: 'reminder', data: { ...reminder, targetType: 'calendar_event', targetId: id } }];
  const ids: string[] = [];
  for (const entry of data) {
    await legacy.table('records').put({ ...entry, visibility: 'private', householdId: HOUSEHOLD, ownerId: ACCOUNTS.a.id, version: 0, createdAt: now, updatedAt: now, deletedAt: null });
    const clientMutationId = crypto.randomUUID(); ids.push(clientMutationId);
    await legacy.table('outbox').put({ deviceId, queuedAt: now, attempts: 1, state: 'pending', mutation: { clientMutationId, entityType: entry.entityType, entityId: entry.id, command: 'create', baseVersion: 0, data: entry.data, ...(entry.visibility ? { visibility: entry.visibility } : {}) } });
  }
  legacy.close();
  const a = await phone(device, 'a');
  expect(await a.store!.deviceId()).toBe(deviceId);
  expect((await a.store!.get(rid))?.parentId).toBe(id);
  expect((await a.store!.get(id))?.data).toEqual(event);
  expect((await a.store!.db.queue.toArray()).map((r) => r.clientMutationId).sort()).toEqual([...ids].sort());
  await a.syncNow(); expect(await a.store!.pendingCount()).toBe(0);
  const b = await phone(new Phone(server), 'b'); await b.syncNow();
  expect(await b.store!.list('calendar_event')).toEqual([]); expect(await b.store!.list('reminder')).toEqual([]);
});
