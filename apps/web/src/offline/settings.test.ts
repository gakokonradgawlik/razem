import Dexie from 'dexie';
import { IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localDatabaseName } from '../local-db.js';
import { servicesFor } from './live.js';
import { ACCOUNTS, HOUSEHOLD, ORIGIN, Phone, startServer } from './test-harness.js';
import type { Server } from './test-harness.js';
import type { AppController } from './controller.js';
let server: Server;
const tabs: AppController[] = [];
beforeEach(async () => { server = await startServer(); });
afterEach(async () => { vi.restoreAllMocks(); for (const tab of tabs.splice(0)) await tab.dispose(); await server.close(); });
async function signed(device: Phone, who: 'a' | 'b') {
  const tab = device.tab(); tabs.push(tab); await tab.init();
  expect(await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password)).toEqual({ ok: true });
  await tab.syncNow(); return tab;
}
const task = { title: 'Przed zmianą strefy', description: '', assignee: 'self', dueDate: null, dueAt: '2026-10-25T00:30:00Z', timezone: 'Europe/Warsaw', completedAt: null, recurrence: null };

it('HTTP ustawień: sesja, CSRF, konto tego żądania, strict patch, bez cudzych preferencji i sekretów', async () => {
  const device = new Phone(server); await signed(device, 'a');
  const headers = { cookie: device.network.cookie!, origin: ORIGIN, 'content-type': 'application/json', 'x-razem-account': ACCOUNTS.a.id };
  expect((await server.app.inject({ method: 'GET', url: '/api/settings' })).statusCode).toBe(401);
  for (const method of ['GET', 'PATCH'] as const) {
    const response = await server.app.inject({ method, url: '/api/settings', headers: { ...headers, 'x-razem-account': ACCOUNTS.b.id }, ...(method === 'PATCH' ? { payload: { displayName: 'Niedozwolone' } } : {}) });
    expect(response.statusCode).toBe(409); expect(response.json()).toEqual({ error: 'account_mismatch' });
  }
  for (const payload of [{ userId: ACCOUNTS.b.id, displayName: 'X' }, { pushEnabled: true }, { timezone: 'Nie/Strefa' }, { displayName: '' }])
    expect((await server.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload })).statusCode).toBe(400);
  expect((await server.app.inject({ method: 'PATCH', url: '/api/settings', headers: { ...headers, origin: 'https://obce.test' }, payload: { displayName: 'X' } })).statusCode).toBe(403);
  const response = await server.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload: { displayName: 'Moja nazwa', timezone: 'Pacific/Kiritimati', includeTitles: true } });
  expect(response.statusCode).toBe(200);
  expect(response.json().members).toContainEqual({ id: ACCOUNTS.a.id, displayName: 'Moja nazwa' });
  expect(JSON.stringify(response.json())).not.toMatch(/password|token|hash|login/i);
  const other = new Phone(server), b = await signed(other, 'b');
  expect(b.getSnapshot().settings?.notifications).toEqual({ includeTitles: false, shoppingNotifications: false });
  expect(b.getSnapshot().settings?.household.timezone).toBe('Pacific/Kiritimati');
  expect((await server.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { ...headers, cookie: other.network.cookie! }, payload: {} })).statusCode).toBe(409);
});

it('profil i strefa przetrwają restart offline, nie zmieniają rekordów/outbox; partner widzi nazwy, własne preferencje', async () => {
  const device = new Phone(server), a = await signed(device, 'a');
  const services = servicesFor(a, a.getSnapshot());
  expect((await a.store!.create('task', task, 'private')).ok).toBe(true);
  const records = await a.store!.db.records.toArray(), queue = await a.store!.db.queue.toArray();
  expect(await services.updateSettings!({ displayName: 'Nowa nazwa', timezone: 'America/Los_Angeles', includeTitles: true, shoppingNotifications: true })).toEqual({ ok: true });
  expect(await a.store!.db.records.toArray()).toEqual(records); expect(await a.store!.db.queue.toArray()).toEqual(queue);
  await a.dispose(); device.setOffline(true);
  const restarted = device.tab(); tabs.push(restarted); await restarted.init();
  const offline = servicesFor(restarted, restarted.getSnapshot());
  expect(offline.session?.displayName).toBe('Nowa nazwa'); expect(offline.settings?.household.timezone).toBe('America/Los_Angeles');
  expect(await offline.updateSettings!({ timezone: 'Europe/Warsaw' })).toEqual({ ok: false, reason: 'unavailable' });
  expect(restarted.getSnapshot().settings?.household.timezone).toBe('America/Los_Angeles');
  expect(await restarted.store!.db.queue.toArray()).toEqual(queue);
  device.setOffline(false); await restarted.syncNow();
  const b = await signed(new Phone(server), 'b');
  expect(await b.store!.list('task')).toHaveLength(0);
  expect(b.getSnapshot().settings?.members).toContainEqual({ id: ACCOUNTS.a.id, displayName: 'Nowa nazwa' });
  expect(b.getSnapshot().settings?.notifications).toEqual({ includeTitles: false, shoppingNotifications: false });
});

it('odpowiedź ustawień starego konta i stare callbacki nie trafiają do nowego konta', async () => {
  const device = new Phone(server), a = await signed(device, 'a');
  const stale = servicesFor(a, a.getSnapshot());
  device.network.afterResponse = async (request) => {
    if (request === 'PATCH /api/settings') {
      device.network.afterResponse = null;
      await a.login(ACCOUNTS.b.login, ACCOUNTS.b.password);
    }
  };
  expect(await stale.updateSettings!({ displayName: 'Tylko A' })).toEqual({ ok: false, reason: 'account_changed' });
  expect(a.getSnapshot().account?.userId).toBe(ACCOUNTS.b.id);
  expect(a.getSnapshot().settings).toBeUndefined();
  expect(await stale.updateSettings!({ displayName: 'Nigdy B' })).toEqual({ ok: false, reason: 'account_changed' });
  expect(await stale.logout!({ discardPending: true })).toEqual({ ok: false, reason: 'account_changed' });
  await a.syncNow(); expect(a.getSnapshot().settings?.members.find((m) => m.id === ACCOUNTS.b.id)?.displayName).toBe('Konto B');
});

it('stara IndexedDB bez cache ustawień zachowuje prywatny outbox i identyfikatory po upgrade i pobraniu ustawień', async () => {
  const device = new Phone(server), id = crypto.randomUUID(), mutationId = crypto.randomUUID(), deviceId = crypto.randomUUID(), now = new Date().toISOString();
  const legacy = new Dexie(localDatabaseName({ userId: ACCOUNTS.a.id, householdId: HOUSEHOLD }), { indexedDB: device.indexedDB, IDBKeyRange });
  legacy.version(1).stores({ records: 'id, entityType, visibility', outbox: 'mutation.clientMutationId, queuedAt, state', conflicts: 'id', cursors: 'key' });
  const data = { title: 'Prywatna stara treść', body: 'Offline przed aktualizacją' };
  await legacy.table('records').put({ id, entityType: 'note', visibility: 'private', householdId: HOUSEHOLD, ownerId: ACCOUNTS.a.id, version: 0, data, createdAt: now, updatedAt: now, deletedAt: null });
  await legacy.table('outbox').put({ deviceId, queuedAt: now, attempts: 0, state: 'pending', mutation: { clientMutationId: mutationId, entityType: 'note', entityId: id, command: 'create', baseVersion: 0, visibility: 'private', data } });
  legacy.close();
  const a = device.tab(); tabs.push(a); await a.init(); await a.login(ACCOUNTS.a.login, ACCOUNTS.a.password);
  expect(a.getSnapshot().settings).toBeUndefined();
  expect((await a.store!.db.queue.toArray())[0]?.clientMutationId).toBe(mutationId); expect(await a.store!.deviceId()).toBe(deviceId);
  await a.syncNow(); expect(a.getSnapshot().settings?.household.timezone).toBe('Europe/Warsaw');
  expect((await a.store!.get(id))?.data).toEqual(data); expect(await a.store!.pendingCount()).toBe(0);
  const b = await signed(new Phone(server), 'b'); expect(await b.store!.get(id)).toBeUndefined();
});

it('logout czyta trwałe pending i zachowuje zmiany zapisane podczas żądania; przełączenie konta nie usuwa jego danych', async () => {
  const device = new Phone(server), a = await signed(device, 'a');
  await a.store!.create('note', { title: 'Zapis przed liveQuery', body: '' }, 'private');
  expect(await a.logout({ discardPending: false })).toEqual({ ok: false, reason: 'pending_changes' });
  await a.syncNow();
  device.network.afterResponse = async (request) => {
    if (request === 'POST /api/auth/logout') {
      device.network.afterResponse = null;
      await a.store!.create('note', { title: 'Nowa zmiana podczas logout', body: '' }, 'private');
    }
  };
  expect(await a.logout({ discardPending: false })).toEqual({ ok: false, reason: 'pending_changes' });
  expect(await a.store!.pendingCount()).toBe(1);
  await a.login(ACCOUNTS.a.login, ACCOUNTS.a.password); await a.syncNow();
  device.network.afterResponse = async (request) => {
    if (request === 'POST /api/auth/logout') {
      device.network.afterResponse = null;
      await a.login(ACCOUNTS.b.login, ACCOUNTS.b.password);
      await a.store!.create('note', { title: 'Zachowaj B', body: '' }, 'private');
    }
  };
  expect(await a.logout({ discardPending: true })).toEqual({ ok: false, reason: 'account_changed' });
  expect((await a.store!.list('note'))[0]?.data.title).toBe('Zachowaj B'); expect(await a.store!.pendingCount()).toBe(1);
});
