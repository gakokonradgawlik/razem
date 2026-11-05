import { afterEach, beforeEach, expect, it } from 'vitest';
import { nextTaskOccurrence, rescheduleTask, taskDataSchema, taskOccurrenceId } from '@razem/contracts';
import { ACCOUNTS, ORIGIN, Phone, startServer } from './test-harness.js';
import type { Server } from './test-harness.js';
import type { AppController } from './controller.js';

let server: Server;
const tabs: AppController[] = [];
beforeEach(async () => { server = await startServer(); });
afterEach(async () => { for (const tab of tabs.splice(0)) await tab.dispose(); await server.close(); });
const ok = <T>(r: { ok: true; value: T } | { ok: false; reason: string }): T => {
  if (!r.ok) throw new Error(r.reason); return r.value;
};
async function login(phone: Phone, who: 'a' | 'b') {
  const tab = phone.tab(); tabs.push(tab); await tab.init();
  expect(await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password)).toEqual({ ok: true });
  await tab.syncNow(); return tab;
}
const task = (repeat = false) => ({ title: 'Podlać kwiaty', description: 'Paprocie', assignee: 'both', dueDate: '2026-01-31', dueAt: null,
  timezone: 'Europe/Warsaw', completedAt: null, recurrence: repeat ? { frequency: 'monthly', interval: 1, startDate: '2026-01-31', time: null } : null });

it('zadania CRUD offline: restart zachowuje całą kolejkę, zgubiony ACK i sync partnera; completion/edit konflikt', async () => {
  const pa = new Phone(server), pb = new Phone(server);
  let a = await login(pa, 'a'); const b = await login(pb, 'b');
  pa.setOffline(true);
  const id = ok(await a.command((s) => s.create('task', task(), 'shared')));
  ok(await a.command((s) => s.update('task', id, { title: 'Podlać paprocie', assignee: 'partner' })));
  ok(await a.command((s) => s.update('task', id, { completedAt: '2026-11-05T08:00:00Z' })));
  ok(await a.command((s) => s.update('task', id, { completedAt: null })));
  const before = await a.store!.db.queue.toArray();
  await a.dispose(); tabs.splice(tabs.indexOf(a), 1);
  a = pa.tab(); tabs.push(a); await a.init();
  expect(await a.store!.db.queue.toArray()).toEqual(before);
  pa.setOffline(false); pa.network.losePushResponses = 1;
  await a.syncNow(); await a.syncNow(); await b.syncNow();
  expect(await b.store!.get(id)).toMatchObject({ data: { title: 'Podlać paprocie', assignee: 'partner', completedAt: null } });
  expect(a.getSnapshot()).toMatchObject({ unsent: 0, attention: 0 });
  pa.setOffline(true); pb.setOffline(true);
  ok(await a.command((s) => s.update('task', id, { title: 'Edycja Anny' })));
  ok(await b.command((s) => s.update('task', id, { completedAt: '2026-11-05T09:00:00Z' })));
  pa.setOffline(false); await a.syncNow(); pb.setOffline(false); await b.syncNow();
  const [conflict] = await b.store!.db.conflicts.toArray();
  expect(conflict).toMatchObject({ local: { data: { title: 'Podlać paprocie', completedAt: '2026-11-05T09:00:00Z' } }, server: { record: { data: { title: 'Edycja Anny', completedAt: null } } } });
  ok(await b.command((s) => s.resolve(conflict!.id, { choice: 'server' })));
  await b.syncNow();
  ok(await b.command((s) => s.update('task', id, { completedAt: '2026-11-05T09:00:01Z' })));
  await b.syncNow(); await a.syncNow();
  expect(await a.store!.get(id)).toMatchObject({ data: { title: 'Edycja Anny', completedAt: '2026-11-05T09:00:01Z' } });
});

it('cykliczne: oba telefony, różne czasy odhaczeń, jedna instancja i zdarzenie; undo zachowane za utraconym ACK', async () => {
  const pa = new Phone(server), pb = new Phone(server);
  const a = await login(pa, 'a'), b = await login(pb, 'b');
  const id = ok(await a.command((s) => s.create('task', task(true), 'shared')));
  await a.syncNow(); await b.syncNow();
  pa.setOffline(true); pb.setOffline(true);
  ok(await a.command((s) => s.setTaskOccurrence(id, '2026-01-31', true)));
  await new Promise((resolve) => setTimeout(resolve, 5));
  ok(await b.command((s) => s.setTaskOccurrence(id, '2026-01-31', true)));
  pa.setOffline(false); await a.syncNow();
  pb.setOffline(false); pb.network.losePushResponses = 1; await b.syncNow();
  ok(await b.command((s) => s.setTaskOccurrence(id, '2026-01-31', false)));
  await b.syncNow(); await a.syncNow();
  expect(server.count('tasks')).toBe(1); expect(server.count('task_occurrences')).toBe(1);
  expect(server.count('task_events', "kind = 'task.completed'")).toBe(1);
  expect(server.count('task_events', "kind = 'task.reopened'")).toBe(1);
  for (const tab of [a,b]) {
    expect(tab.getSnapshot()).toMatchObject({ unsent: 0, attention: 0 });
    expect(await tab.store!.list('task_occurrence', id)).toMatchObject([{ data: { occurrenceKey: '2026-01-31', completedAt: null } }]);
  }
  ok(await a.command((s) => s.setTaskOccurrence(id, '2026-01-31', true)));
  await a.syncNow(); await b.syncNow();
  const template = taskDataSchema.parse((await b.store!.get(id))!.data);
  const done = new Set((await b.store!.list('task_occurrence', id)).filter((o) => o.data.completedAt).map((o) => String(o.data.occurrenceKey)));
  expect(nextTaskOccurrence(template, done)?.occurrenceKey).toBe('2026-02-28');
  // A rule change leaves previous completions and uncompleted February in place.
  const next = rescheduleTask(template, '2026-12-01', 'weekly', '08:00');
  ok(await b.command((s) => s.update('task', id, next)));
  await b.syncNow(); await a.syncNow();
  expect(nextTaskOccurrence(taskDataSchema.parse((await a.store!.get(id))!.data), done)?.occurrenceKey).toBe('2026-02-28');
  expect(server.count('task_occurrences')).toBe(1);
  ok(await a.command((s) => s.setTaskOccurrence(id, '2026-01-31', false)));
  await a.syncNow(); await b.syncNow();
  expect((await b.store!.list('task_occurrence', id))[0]?.data.completedAt).toBeNull();
  expect(await b.command((s) => s.setTaskOccurrence(id, '2026-12-02', true))).toMatchObject({ ok: false, reason: 'invalid' });
  ok(await a.command((s) => s.remove('task', id)));
  expect(await a.store!.list('task_occurrence', id)).toEqual([]);
});

it('private: przypisanie tylko self, brak w API/pull/conflict/list/get partnera oraz błędny rodzic', async () => {
  const pa = new Phone(server), pb = new Phone(server);
  const a = await login(pa, 'a'), b = await login(pb, 'b');
  expect(await a.command((s) => s.create('task', task(), 'private'))).toMatchObject({ ok: false, reason: 'invalid' });
  const id = ok(await a.command((s) => s.create('task', { ...task(true), assignee: 'self', title: 'Prywatny obowiązek' }, 'private')));
  ok(await a.command((s) => s.setTaskOccurrence(id, '2026-01-31', true)));
  expect(await a.command((s) => s.update('task', id, { assignee: 'partner' }))).toMatchObject({ ok: false, reason: 'invalid' });
  await a.syncNow(); await b.syncNow();
  expect(await b.store!.get(id)).toBeUndefined(); expect(await b.store!.list('task')).toEqual([]);
  expect(await b.store!.list('task_occurrence')).toEqual([]);
  const occurrenceId = await taskOccurrenceId(id, '2026-01-31');
  const headers = { origin: ORIGIN, cookie: pb.network.cookie!, 'x-razem-protocol': '2', 'x-razem-account': ACCOUNTS.b.id };
  const pull = await server.app.inject({ method: 'GET', url: '/api/sync/pull', headers });
  expect(pull.body).not.toContain('Prywatny obowiązek'); expect(pull.body).not.toContain(id); expect(pull.body).not.toContain(occurrenceId);
  const mutations = [
    ...['update','delete','restore'].map((command) => ({ entityType: 'task', entityId: id, command, baseVersion: 1, ...(command === 'update' ? { patch: { title: 'Przejęcie' } } : {}) })),
    { entityType: 'task_occurrence', entityId: crypto.randomUUID(), command: 'create', baseVersion: 0, data: { taskId: id, occurrenceKey: '2026-02-28', completedAt: new Date().toISOString() } },
    { entityType: 'task_occurrence', entityId: occurrenceId, command: 'update', baseVersion: 1, patch: { completedAt: null } },
  ];
  for (const mutation of mutations) {
    const r = await server.app.inject({ method: 'POST', url: '/api/sync/push', headers, payload: { protocolVersion: 2, deviceId: crypto.randomUUID(), mutations: [{ clientMutationId: crypto.randomUUID(), ...mutation }] } });
    expect(r.json().results[0]).toMatchObject({ status: 'error', code: 'not_found' });
    expect(r.body).not.toContain('Prywatny obowiązek'); expect(r.json().results[0]).not.toHaveProperty('state');
  }
});
