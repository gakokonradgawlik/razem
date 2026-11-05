import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountRepository, migrate, openDatabase, PushSubscriptions, RecordRepository } from '@razem/db';
import type { Database, PushTransport } from '@razem/db';
import { dispatchSchema } from '@razem/contracts/server';
import type { AccountScope } from '@razem/contracts';
import { ReminderWorker } from './worker.js';

const H = randomUUID(), A: AccountScope = { householdId: H, userId: randomUUID() }, B: AccountScope = { householdId: H, userId: randomUUID() };
const START = Date.parse('2026-11-05T07:00:00.000Z');
let dir: string, db: Database, now: number, repo: RecordRepository, worker: ReminderWorker;
const send = vi.fn<PushTransport>(async () => undefined);
const clock = () => new Date(now);
const task = { title: 'PRYWATNY TYTUŁ', description: 'sekret', assignee: 'self', dueDate: '2026-11-05', dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null };
const open: Database[] = [];
beforeEach(() => {
  now = START; dir = mkdtempSync(join(tmpdir(), 'raz-12-worker-')); db = openDatabase(join(dir, 'db.sqlite')); open.push(db); migrate(db.sqlite);
  db.sqlite.prepare('INSERT INTO households VALUES (?,?,?,?)').run(H, 'Test', 'Europe/Warsaw', clock().toISOString());
  for (const scope of [A, B]) {
    db.sqlite.prepare('INSERT INTO users VALUES (?,?,?,?,?,0,?,?)').run(scope.userId, H, `${scope.userId}@example.test`, 'Test', '$argon2id$v=19$m=8,t=1,p=1$c3ludGhldGlj$c3ludGhldGlj', clock().toISOString(), clock().toISOString());
    subscribe(scope);
    new AccountRepository(db).updateSettings(new AccountRepository(db).userById(scope.userId)!, { taskAssignments: false }, clock().toISOString());
  }
  repo = new RecordRepository(db, clock); send.mockReset(); send.mockResolvedValue(undefined); worker = new ReminderWorker(db, send, clock);
});
afterEach(() => { for (const item of open.splice(0)) { try { item.close(); } catch { /* restart */ } } rmSync(dir, { recursive: true, force: true }); });
function subscribe(scope: AccountScope) {
  const session = randomUUID(), device = randomUUID(), at = new Date(now - 1000).toISOString();
  db.sqlite.prepare('INSERT INTO sessions VALUES (?,?,?,NULL,NULL,?,?,?)').run(session, scope.userId, randomUUID().replaceAll('-', '').repeat(2), at, at, new Date(now + 30 * 86400000).toISOString());
  new PushSubscriptions(db).subscribe(scope.userId, session, { deviceId: device, subscription: { endpoint: `https://web.push.apple.com/${randomUUID()}`, expirationTime: null, keys: { p256dh: 'synthetic', auth: 'synthetic' } } }, at);
  return session;
}
function create(type: 'task' | 'calendar_event' | 'important_date' | 'reminder' | 'shopping_list' | 'shopping_item', data: Record<string, unknown>, visibility: 'private' | 'shared' = 'private') {
  const result = repo.create(A, { id: randomUUID(), entityType: type, data, ...(['reminder','shopping_item'].includes(type) ? {} : { visibility }) });
  if (result.status !== 'ack') throw new Error(JSON.stringify(result)); return result.record;
}
const jobs = () => db.sqlite.prepare('SELECT * FROM reminder_dispatches ORDER BY scheduled_at').all() as Array<{ state: string; scheduled_at: string; kind: string; attempts: number; user_id: string; id: string }>;
const due = () => { now = Date.parse('2026-11-05T08:00:00.000Z'); };

it('pełny skan starszych zadań, restart i dwa połączenia planują jeden dispatch na urządzenie; prywatność i treść ogólna', async () => {
  const t = create('task', task);
  db.sqlite.prepare('DELETE FROM task_events').run(); // pre-RAZ-8 records have no semantic events
  worker.plan(); expect(jobs()).toHaveLength(1); expect(jobs()[0]).toMatchObject({ user_id: A.userId, scheduled_at: '2026-11-05T08:00:00.000Z' });
  const persisted = db.sqlite.prepare('SELECT * FROM reminder_dispatches').get() as Record<string, unknown>;
  const projection = Object.fromEntries(Object.entries(persisted).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value]));
  expect(dispatchSchema.safeParse(projection).success).toBe(true);
  db.close(); db = openDatabase(join(dir, 'db.sqlite')); open.push(db);
  const other = openDatabase(db.path); open.push(other);
  worker = new ReminderWorker(db, send, clock); const second = new ReminderWorker(other, send, clock);
  worker.plan(); second.plan(); expect(jobs()).toHaveLength(1);
  due(); await Promise.all([worker.tick(), second.tick()]);
  expect(send).toHaveBeenCalledTimes(1); expect(jobs()[0]?.state).toBe('sent');
  expect(send.mock.calls[0]).toMatchObject([{ user_id: A.userId }, { body: 'Masz przypomnienie w Razem', url: `/powiadomienie/task/${t.id}` }]);
  expect(JSON.stringify(send.mock.calls)).not.toContain(task.title);
});

it.each(['complete', 'delete', 'reschedule', 'disable', 'logout', 'permission', 'expire'] as const)('%s po planowaniu jest sprawdzane ponownie bez dodatkowego plan()', async (action) => {
  const t = create('task', task); worker.plan(); expect(jobs()).toHaveLength(1);
  if (action === 'complete') repo.update(A, { entityType: 'task', id: t.id, baseVersion: 1, patch: { completedAt: clock().toISOString() } });
  if (action === 'delete') repo.remove(A, { entityType: 'task', id: t.id, baseVersion: 1 });
  if (action === 'reschedule') repo.update(A, { entityType: 'task', id: t.id, baseVersion: 1, patch: { dueDate: '2026-11-06' } });
  if (action === 'disable') new AccountRepository(db).updateSettings(new AccountRepository(db).userById(A.userId)!, { taskReminders: false }, clock().toISOString());
  if (action === 'logout') db.sqlite.prepare('DELETE FROM sessions WHERE user_id=?').run(A.userId);
  if (action === 'permission') db.sqlite.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(A.userId);
  if (action === 'expire') db.sqlite.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(new Date(now + 1000).toISOString(), A.userId);
  due(); await worker.dispatchOne(); expect(send).not.toHaveBeenCalled();
  expect(jobs().every((j) => j.state === 'cancelled')).toBe(true);
});

it('retry/backoff, restart i utrata lease: jeden wiersz; nieaktualny worker nie kończy nowszej próby', async () => {
  create('task', task); due(); send.mockRejectedValueOnce({ statusCode: 503, body: 'never log transport errors' });
  await worker.tick(); expect(jobs()).toHaveLength(1); expect(jobs()[0]).toMatchObject({ state: 'pending', attempts: 1 });
  await worker.tick(); expect(send).toHaveBeenCalledTimes(1);
  now += 30000; const claimed = worker.claim(); expect(claimed).toBeTruthy();
  // Simulated process dies before calling transport. Lease is reclaimed after a restart.
  now += 60001; const restarted = new ReminderWorker(db, send, clock);
  await restarted.tick(); expect(jobs()).toHaveLength(1); expect(jobs()[0]).toMatchObject({ state: 'sent', attempts: 3 });
  expect(send).toHaveBeenCalledTimes(2);
});

it('równoległa wysyłka nie przejmuje czynnego lease; token chroni rezultat po odzyskaniu wygasłego lease', async () => {
  create('task', task); due(); worker.plan();
  let resolve!: () => void; send.mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }));
  const sending = worker.dispatchOne(); expect(send).toHaveBeenCalledTimes(1);
  const other = new ReminderWorker(db, send, clock);
  expect(await other.dispatchOne()).toBe(false);
  now += 60001; send.mockRejectedValueOnce({ statusCode: 503 }); await other.dispatchOne();
  expect(jobs()[0]?.state).toBe('pending'); resolve(); await sending;
  expect(jobs()[0]?.state).toBe('pending'); // stale successful response cannot mark it sent
});

it.each([404, 410])('HTTP %i usuwa martwą subskrypcję i jej kolejkę, bez retry/nowego dispatch', async (statusCode) => {
  create('task', task); due(); send.mockRejectedValueOnce({ statusCode }); await worker.tick();
  expect(jobs()).toHaveLength(0); expect(db.sqlite.prepare('SELECT count(*) n FROM push_subscriptions WHERE user_id=?').get(A.userId)).toEqual({ n: 0 });
  await worker.tick(); expect(send).toHaveBeenCalledTimes(1);
});

it('prywatny kalendarz: domyślne 30 min, zmiana konfiguracji/terminu i usunięcie anulują starą wersję', async () => {
  const event = create('calendar_event', { title: 'Sekret', description: '', allDay: false, timezone: 'Europe/Warsaw', startAt: '2026-11-05T08:30:00.000Z', endAt: '2026-11-05T09:30:00.000Z', startDate: null, endDate: null });
  const reminder = create('reminder', { targetType: 'calendar_event', targetId: event.id, enabled: true, minutesBefore: 30, localTime: null });
  worker.plan(); expect(jobs()).toHaveLength(1); expect(jobs()[0]?.scheduled_at).toBe('2026-11-05T08:00:00.000Z');
  repo.update(A, { entityType: 'reminder', id: reminder.id, baseVersion: 1, patch: { minutesBefore: 15 } });
  due(); await worker.dispatchOne(); expect(send).not.toHaveBeenCalled(); worker.plan(); expect(jobs().filter((j) => j.state === 'pending')[0]?.scheduled_at).toBe('2026-11-05T08:15:00.000Z');
  repo.remove(A, { entityType: 'calendar_event', id: event.id, baseVersion: 1 }); now += 15 * 60000; await worker.tick(); expect(send).not.toHaveBeenCalled();
});

it('powtarzanie: ukończone wystąpienie znika, następny dzień zostaje; zmiana czasu preferencji nie duplikuje kolejki', async () => {
  const t = create('task', { ...task, recurrence: { frequency: 'daily', interval: 1, startDate: '2026-11-05' } });
  create('reminder', { targetType: 'task', targetId: t.id, enabled: true, minutesBefore: 0, localTime: '09:00' });
  const occ = repo.create(A, { entityType: 'task_occurrence', id: randomUUID(), data: { taskId: t.id, occurrenceKey: '2026-11-05', completedAt: clock().toISOString() } }); expect(occ.status).toBe('ack');
  worker.plan(); expect(jobs().some((j) => j.scheduled_at === '2026-11-05T08:00:00.000Z')).toBe(false);
  expect(jobs().some((j) => j.scheduled_at === '2026-11-06T08:00:00.000Z')).toBe(true);
});

it('przypisanie i zakupy: checkpoint transakcyjny, ACL oraz dodatkowy opt-in zakupów', async () => {
  const accounts = new AccountRepository(db);
  for (const scope of [A, B]) accounts.updateSettings(accounts.userById(scope.userId)!, { taskAssignments: true }, clock().toISOString());
  create('task', { ...task, dueDate: null, assignee: 'partner' }, 'shared');
  const list = create('shopping_list', { name: 'Zakupy' }, 'shared');
  create('shopping_item', { listId: list.id, name: 'Mleko', quantity: '', note: '', checked: false, sortKey: 1 }, 'shared');
  await worker.tick(); expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]?.[0]).toMatchObject({ user_id: B.userId });
  worker.plan(); await worker.tick(); expect(send).toHaveBeenCalledTimes(1);
  accounts.updateSettings(accounts.userById(B.userId)!, { shoppingNotifications: true, includeTitles: true }, clock().toISOString());
  create('shopping_item', { listId: list.id, name: 'Jabłka', quantity: '', note: '', checked: false, sortKey: 2 }, 'shared');
  await worker.tick(); expect(send).toHaveBeenCalledTimes(2); expect(send.mock.calls[1]).toMatchObject([{ user_id: B.userId }, { body: 'Jabłka' }]);
  const privateList = create('shopping_list', { name: 'PRIVATE A' });
  create('shopping_item', { listId: privateList.id, name: 'SECRET', quantity: '', note: '', checked: false, sortKey: 1 });
  await worker.tick(); expect(send).toHaveBeenCalledTimes(2);
});

it('DST, strefa domu i 29 lutego: wspólne reguły trafiają do rzeczywistej kolejki', () => {
  now = Date.parse('2027-02-27T00:00:00.000Z');
  // Refresh the synthetic sessions before testing a later year.
  db.sqlite.prepare('UPDATE sessions SET expires_at=?').run('2028-12-01T00:00:00.000Z');
  const d = create('important_date', { name: 'Rocznica', month: 2, day: 29, startYear: null, kind: 'anniversary' });
  create('reminder', { targetType: 'important_date', targetId: d.id, enabled: true, minutesBefore: 0, localTime: '09:00' });
  worker.plan(); expect(jobs()[0]?.scheduled_at).toBe('2027-02-28T08:00:00.000Z');
  const accounts = new AccountRepository(db); accounts.updateSettings(accounts.userById(A.userId)!, { timezone: 'Pacific/Kiritimati' }, clock().toISOString());
  worker.plan(); expect(jobs().filter((j) => j.state === 'pending')[0]?.scheduled_at).toBe('2027-02-27T19:00:00.000Z');
  now = Date.parse('2027-03-27T00:00:00.000Z');
  create('task', { ...task, dueDate: '2027-03-28' });
  accounts.updateSettings(accounts.userById(A.userId)!, { taskReminderTime: '02:30' }, clock().toISOString()); worker.plan();
  expect(jobs().some((j) => j.state === 'pending' && j.scheduled_at === '2027-03-28T01:00:00.000Z')).toBe(true);
});

it('wiele urządzeń: deduplikacja per subskrypcja i przywrócenie wyłączonego przyszłego przypomnienia', async () => {
  subscribe(A); create('task', task); worker.plan(); expect(jobs()).toHaveLength(2);
  const accounts = new AccountRepository(db);
  accounts.updateSettings(accounts.userById(A.userId)!, { taskReminders: false }, clock().toISOString()); worker.plan(); expect(jobs().every((j) => j.state === 'cancelled')).toBe(true);
  accounts.updateSettings(accounts.userById(A.userId)!, { taskReminders: true }, clock().toISOString()); worker.plan(); expect(jobs().filter((j) => j.state === 'pending')).toHaveLength(2);
  due(); await worker.tick(); expect(send).toHaveBeenCalledTimes(2); worker.plan(); expect(jobs()).toHaveLength(2);
});

it('edycja tytułu po wysłaniu i zmiana godziny dla terminu godzinowego nie powtarzają tego samego przypomnienia', async () => {
  const t = create('task', { ...task, dueDate: null, dueAt: '2026-11-05T08:00:00.000Z' }); due(); await worker.tick(); expect(send).toHaveBeenCalledTimes(1);
  repo.update(A, { entityType: 'task', id: t.id, baseVersion: 1, patch: { title: 'Poprawiony' } });
  const accounts = new AccountRepository(db); accounts.updateSettings(accounts.userById(A.userId)!, { taskReminderTime: '10:00' }, clock().toISOString());
  await worker.tick(); expect(send).toHaveBeenCalledTimes(1); expect(jobs()).toHaveLength(1);
});

it('błąd zapisu kolejki cofa także checkpoint, po restarcie powstaje jedno przypisanie', async () => {
  const accounts = new AccountRepository(db); accounts.updateSettings(accounts.userById(A.userId)!, { taskAssignments: true }, clock().toISOString());
  create('task', { ...task, dueDate: null });
  db.sqlite.exec("CREATE TRIGGER test_fail BEFORE INSERT ON reminder_dispatches BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
  expect(() => worker.plan()).toThrow('synthetic'); expect(db.sqlite.prepare('SELECT task_sequence FROM worker_state').get()).toEqual({ task_sequence: 0 });
  expect(jobs()).toHaveLength(0); db.sqlite.exec('DROP TRIGGER test_fail');
  await new ReminderWorker(db, send, clock).tick(); expect(jobs()).toHaveLength(1); expect(send).toHaveBeenCalledTimes(1);
});

it('kilka starych konfiguracji tego samego kalendarza daje jedno przypomnienie', async () => {
  const event = create('calendar_event', { title: 'Test', description: '', allDay: true, timezone: 'Europe/Warsaw', startDate: '2026-11-05', endDate: '2026-11-06', startAt: null, endAt: null });
  for (let n = 0; n < 2; n++) create('reminder', { targetType: 'calendar_event', targetId: event.id, enabled: true, minutesBefore: 0, localTime: '09:00' });
  due(); await worker.tick(); expect(jobs()).toHaveLength(1); expect(send).toHaveBeenCalledTimes(1);
});

it('opcjonalne usunięcie produktu prowadzi do żywej listy, nadal z ACL rodzica', async () => {
  const accounts = new AccountRepository(db); accounts.updateSettings(accounts.userById(B.userId)!, { shoppingNotifications: true }, clock().toISOString());
  const list = create('shopping_list', { name: 'Lista' }, 'shared');
  const item = create('shopping_item', { listId: list.id, name: 'Produkt', quantity: '', note: '', checked: false, sortKey: 0 }, 'shared');
  worker.plan(); await worker.tick(); send.mockClear(); now += 1000;
  repo.remove(A, { entityType: 'shopping_item', id: item.id, baseVersion: 1 }); await worker.tick();
  expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]).toMatchObject([{ user_id: B.userId }, { url: `/powiadomienie/shopping_list/${list.id}` }]);
});
