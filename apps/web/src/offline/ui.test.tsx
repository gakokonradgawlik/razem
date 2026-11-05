// @vitest-environment jsdom
// Screens on the real data layer (AppController + Dexie on fake-indexeddb) and the real
// server: honest status with ACK and unsent count, both versions of a conflict with a
// merge that is re-checked by the server, storage-full message with export, logout warning.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { navigate } from '../router.js';
import { IDBKeyRange } from 'fake-indexeddb';
import { useControllerServices } from './live.js';
import { LocalDatabase } from '../local-db.js';
import type { AppServices } from '../services.js';
import { ACCOUNTS, HOUSEHOLD, Phone, startServer } from './test-harness.js';
import type { Server } from './test-harness.js';
import type { AppController } from './controller.js';

let server: Server;
const tabs: AppController[] = [];
beforeEach(async () => { server = await startServer(); window.history.replaceState(null, '', '/'); });
afterEach(async () => {
  cleanup();
  for (const tab of tabs.splice(0)) await tab.dispose();
  await server.close();
  vi.restoreAllMocks();
});

async function signedIn(phone: Phone, who: 'a' | 'b') {
  const tab = phone.tab(); tabs.push(tab);
  await tab.init();
  expect(await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password)).toEqual({ ok: true });
  await tab.syncNow();
  return tab;
}
function Root({ controller }: { controller: AppController }) { return <App services={useControllerServices(controller)} />; }
const go = (path: string) => act(() => navigate(path));
const status = () => screen.getAllByRole('status').find((node) => node.classList.contains('sync-badge'))!;

it('start offline nie udostępnia formularza przed otwarciem bazy i nie gubi wpisanej nazwy przy odświeżeniu stanu', async () => {
  const phone = new Phone(server);
  const first = await signedIn(phone, 'a');
  await first.dispose(); tabs.splice(tabs.indexOf(first), 1);
  phone.setOffline(true);
  const controller = phone.tab(); tabs.push(controller);
  render(<Root controller={controller} />);
  go('/zakupy/nowa');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.getByText('Otwieranie danych na tym urządzeniu…')).toBeTruthy();
  await act(async () => { await controller.init(); });
  fireEvent.change(screen.getByLabelText('Nazwa listy'), { target: { value: 'Zakupy po restarcie' } });
  await act(async () => { await controller.refresh(); });
  expect((screen.getByLabelText('Nazwa listy') as HTMLInputElement).value).toBe('Zakupy po restarcie');
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(window.location.pathname).toBe('/zakupy'));
  expect(await controller.store!.list('shopping_list')).toMatchObject([{ data: { name: 'Zakupy po restarcie' } }]);
});

it('status: zmiany czekają (liczba), Zsynchronizowano dopiero po ACK; offline i brak miejsca z eksportem', async () => {
  const phone = new Phone(server);
  const tab = await signedIn(phone, 'a');
  render(<Root controller={tab} />);
  await waitFor(() => expect(status().textContent).toMatch(/^Zsynchronizowano \d\d:\d\d/));

  phone.network.outage = 502;
  await act(async () => { await tab.command((s) => s.create('note', { title: 'Kod do domofonu', body: '' }, 'private')); });
  await act(async () => { await tab.syncNow(); });
  await waitFor(() => expect(status().textContent).toBe('Serwer niedostępny · zmiany czekają na wysłanie (1)'));
  phone.network.outage = null;
  await act(async () => { await tab.syncNow(); });
  await waitFor(() => expect(status().textContent).toMatch(/^Zsynchronizowano/));

  // Quota: the failed write is reported, never confirmed, and the export is offered.
  const failQueue = () => { throw new DOMException('full', 'QuotaExceededError'); };
  tab.store!.db.queue.hook('creating', failQueue);
  go('/notatki/nowa');
  fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Nie zmieści się' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect(await screen.findByText(/brak miejsca na urządzeniu/)).toBeTruthy();
  expect(window.location.pathname).toBe('/notatki/nowa');
  expect((screen.getByLabelText('Tytuł') as HTMLInputElement).value).toBe('Nie zmieści się');
  go('/');
  await waitFor(() => expect(status().textContent).toContain('Brak miejsca na urządzeniu'));
  expect(within(status()).getByRole('link', { name: 'Eksportuj' })).toBeTruthy();
  tab.store!.db.queue.hook('creating').unsubscribe(failQueue);
});

it('konflikt: obie wersje, połączenie ręczne i ponowne sprawdzenie wersji na serwerze', async () => {
  const phoneA = new Phone(server), phoneB = new Phone(server);
  const a = await signedIn(phoneA, 'a'), b = await signedIn(phoneB, 'b');
  const created = await a.command((s) => s.create('note', { title: 'Zakupy na święta', body: 'karp' }, 'shared'));
  const id = created.ok ? created.value : '';
  await a.syncNow(); await b.syncNow();
  phoneB.setOffline(true);
  await a.command((s) => s.update('note', id, { body: 'karp, barszcz' }));
  await a.syncNow();
  await b.command((s) => s.update('note', id, { body: 'karp, pierogi' }));
  phoneB.setOffline(false);
  await b.syncNow();

  render(<Root controller={b} />);
  await waitFor(() => expect(status().textContent).toBe('1 zmiana wymaga sprawdzenia' + 'Sprawdź'));
  fireEvent.click(within(status()).getByRole('link', { name: 'Sprawdź' }));
  fireEvent.click(await screen.findByRole('link', { name: /Zakupy na święta/ }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Moja wersja (to urządzenie)' })).toBeTruthy();
  expect(screen.getAllByText('karp, pierogi').length).toBeGreaterThan(0);
  expect(screen.getAllByText('karp, barszcz').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('radio', { name: 'Połącz ręcznie' }));
  const merged = screen.getByLabelText('Treść – połączona treść') as HTMLTextAreaElement;
  expect(merged.value).toBe('karp, pierogi\nkarp, barszcz');
  fireEvent.change(merged, { target: { value: 'karp, barszcz, pierogi' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz połączoną wersję' }));
  await waitFor(() => expect(window.location.pathname).toBe('/zmiany'));
  await act(async () => { await b.syncNow(); });
  const row = server.database.sqlite.prepare('SELECT body, version FROM notes WHERE id = ?').get(id);
  expect(row).toEqual({ body: 'karp, barszcz, pierogi', version: 3 });
  expect(await screen.findByText('Wszystko w porządku')).toBeTruthy();
});

// Child records carry immutable parent references/keys (listId, taskId+occurrenceKey,
// targetType+targetId) that the merge screen does not show; the merged version must keep them.
type ChildCase = {
  type: 'shopping_item' | 'task_occurrence' | 'reminder'; table: string; columns: string;
  make: (parents: { list: string; task: string }) => Record<string, unknown>;
  mine: Record<string, unknown>; theirs: Record<string, unknown>;
  pick: () => void; expected: (parents: { list: string; task: string }) => Record<string, unknown>;
};
const T1 = '2026-11-05T08:00:00.000Z', T2 = '2026-11-05T09:30:00.000Z';
const childCases: ChildCase[] = [
  {
    type: 'shopping_item', table: 'shopping_items', columns: 'list_id AS listId, name, note, version',
    make: ({ list }) => ({ listId: list, name: 'Mleko', quantity: '', note: '', checked: false, sortKey: 1 }),
    mine: { note: 'bez laktozy' }, theirs: { note: '2 kartony' },
    pick: () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Połącz ręcznie' }));
      fireEvent.change(screen.getByLabelText('Uwaga – połączona treść'), { target: { value: '2 kartony, bez laktozy' } });
    },
    expected: ({ list }) => ({ listId: list, name: 'Mleko', note: '2 kartony, bez laktozy', version: 3 }),
  },
  {
    type: 'task_occurrence', table: 'task_occurrences', columns: 'task_id AS taskId, occurrence_key AS occurrenceKey, completed_at AS completedAt, version',
    make: ({ task }) => ({ taskId: task, occurrenceKey: '2026-11-05', completedAt: T2 }),
    // Complete vs reopen is a conflict; two completion timestamps express the same intent.
    mine: { completedAt: T1 }, theirs: { completedAt: null },
    pick: () => fireEvent.click(screen.getByRole('radio', { name: `Moja: ${T1}` })),
    expected: ({ task }) => ({ taskId: task, occurrenceKey: '2026-11-05', completedAt: T1, version: 3 }),
  },
  {
    type: 'reminder', table: 'reminders', columns: 'target_type AS targetType, target_id AS targetId, minutes_before AS minutesBefore, version',
    make: ({ task }) => ({ targetType: 'task', targetId: task, enabled: true, minutesBefore: 15, localTime: null }),
    mine: { minutesBefore: 30 }, theirs: { minutesBefore: 60 },
    pick: () => fireEvent.click(screen.getByRole('radio', { name: 'Moja: 30' })),
    expected: ({ task }) => ({ targetType: 'task', targetId: task, minutesBefore: 30, version: 3 }),
  },
];

it.each(childCases)('konflikt $type: połączona wersja zachowuje ukryte powiązanie i dostaje ACK', async (c) => {
  const phoneA = new Phone(server), phoneB = new Phone(server);
  const a = await signedIn(phoneA, 'a'), b = await signedIn(phoneB, 'b');
  const value = (result: { ok: boolean; value?: unknown }) => { expect(result.ok).toBe(true); return String(result.value); };
  const list = value(await a.command((s) => s.create('shopping_list', { name: 'Dom' }, 'shared')));
  const task = value(await a.command((s) => s.create('task', {
    title: 'Podlać kwiaty', description: '', assignee: 'both', dueDate: '2026-11-05', dueAt: null, timezone: 'Europe/Warsaw',
    completedAt: null, recurrence: { frequency: 'daily', interval: 1, startDate: '2026-11-01' },
  }, 'shared')));
  const parents = { list, task };
  const id = value(await a.command((s) => s.create(c.type, c.make(parents))));
  await a.syncNow(); await b.syncNow();
  phoneB.setOffline(true);
  expect((await a.command((s) => s.update(c.type, id, c.theirs))).ok).toBe(true);
  await a.syncNow();
  expect((await b.command((s) => s.update(c.type, id, c.mine))).ok).toBe(true);
  phoneB.setOffline(false);
  await b.syncNow();

  render(<Root controller={b} />);
  go('/zmiany');
  fireEvent.click(await screen.findByRole('link', { name: /Wpis bez nazwy|Mleko/ }));
  expect(await screen.findByRole('heading', { level: 2, name: 'Moja wersja (to urządzenie)' })).toBeTruthy();
  c.pick();
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz połączoną wersję' }));
  await waitFor(() => expect(window.location.pathname).toBe('/zmiany'));
  await act(async () => { await b.syncNow(); });
  expect(server.database.sqlite.prepare(`SELECT ${c.columns} FROM ${c.table} WHERE id = ?`).get(id)).toEqual(c.expected(parents));
  expect(await screen.findByText('Wszystko w porządku')).toBeTruthy();
  expect(await b.store!.db.queue.count()).toBe(0);
});

it('wylogowanie z niewysłanymi zmianami ostrzega i daje eksport; inne konto nie widzi danych', async () => {
  const phone = new Phone(server);
  const tab = await signedIn(phone, 'a');
  phone.network.outage = 503;
  await tab.command((s) => s.create('note', { title: 'Prywatny numer PIN', body: '' }, 'private'));
  const created: Blob[] = [];
  Object.assign(URL, { createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:razem-test'; }, revokeObjectURL: () => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  render(<Root controller={tab} />);
  go('/ustawienia');
  fireEvent.click(await screen.findByRole('button', { name: 'Wyloguj' }));
  expect(await screen.findByText('Niewysłane zmiany: 1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Eksportuj zmiany do pliku' }));
  await waitFor(() => expect(created).toHaveLength(1));
  const file = JSON.parse(await created[0]!.text());
  expect(file).toMatchObject({ format: 'razem-pending-changes', account: { login: ACCOUNTS.a.login }, changes: [{ content: { title: 'Prywatny numer PIN' } }] });
  phone.network.outage = null;
  fireEvent.click(screen.getByRole('button', { name: 'Wyloguj i usuń niewysłane zmiany' }));
  await waitFor(() => expect(window.location.pathname).toBe('/logowanie'));
  expect(tab.getSnapshot().phase).toBe('signed_out');

  await act(async () => { await tab.login(ACCOUNTS.b.login, ACCOUNTS.b.password); await tab.syncNow(); });
  go('/notatki');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Notatki' })).toBeTruthy());
  expect(document.body.textContent).not.toContain('Prywatny numer PIN');
});

// Account switch adopted from another tab while a screen of A is open: React state of A
// (form values, loaded records, callbacks) must neither stay on screen nor reach B.
function RecordingRoot({ controller, seen }: { controller: AppController; seen: AppServices[] }) {
  const services = useControllerServices(controller);
  seen.push(services);
  return <App services={services} />;
}
async function adoptB(phone: Phone, tab: AppController) {
  await phone.network.signInElsewhere(ACCOUNTS.b);
  await act(async () => { await tab.syncNow(); });
  await waitFor(() => expect(tab.getSnapshot().account?.userId).toBe(ACCOUNTS.b.id));
  await waitFor(() => expect(tab.getSnapshot().phase).toBe('ready'));
}

it('zmiana konta w innej karcie przy otwartym formularzu A: treść A znika, nie trafia do B, pending A czeka na A', async () => {
  const phone = new Phone(server);
  const tab = await signedIn(phone, 'a');
  // A has an unsent private note (server unreachable for now).
  phone.network.outage = 503;
  await tab.command((s) => s.create('note', { title: 'Pending A', body: 'tylko dla A' }, 'private'));
  phone.network.outage = null;

  const seen: AppServices[] = [];
  render(<RecordingRoot controller={tab} seen={seen} />);
  go('/notatki/nowa');
  fireEvent.change(await screen.findByLabelText('Tytuł'), { target: { value: 'Sekret A w formularzu' } });
  fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'PIN 4321' } });
  const servicesOfA = seen[seen.length - 1]!;

  await adoptB(phone, tab);

  // The screen was remounted for B: nothing of A on it, the form is empty, the user is told why.
  await waitFor(() => expect((screen.getByLabelText('Tytuł') as HTMLInputElement).value).toBe(''));
  expect(document.body.textContent).not.toContain('Sekret A w formularzu');
  expect(document.body.textContent).not.toContain('PIN 4321');
  expect(screen.getByRole('alert').textContent).toContain('Otwarto konto: Konto B');
  // Saving the (now empty) form writes nothing.
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect(await screen.findByText(/Popraw zaznaczone pole/)).toBeTruthy();

  // A stale callback of A (e.g. a save already clicked) is refused, it does not write into B.
  expect(await servicesOfA.saveRecord({ entityType: 'note', visibility: 'private', data: { title: 'Sekret A w formularzu', body: 'PIN 4321' } }))
    .toEqual({ ok: false, reason: 'account_changed' });
  expect(await servicesOfA.listRecords({ entityType: 'note' })).toEqual({ status: 'unavailable' });

  const storeB = tab.store!;
  expect(storeB.scope.userId).toBe(ACCOUNTS.b.id);
  expect(await storeB.db.records.count()).toBe(0);
  expect(await storeB.db.queue.count()).toBe(0);
  await act(async () => { await tab.syncNow(); });
  expect(server.count('notes')).toBe(0);
  expect(server.count('notes', `owner_id = '${ACCOUNTS.b.id}'`)).toBe(0);

  // A's pending change waited in A's database and goes out as A after A signs in again.
  await act(async () => { expect(await tab.login(ACCOUNTS.a.login, ACCOUNTS.a.password)).toEqual({ ok: true }); await tab.syncNow(); });
  expect(server.database.sqlite.prepare('SELECT title, owner_id AS owner, visibility FROM notes').all())
    .toEqual([{ title: 'Pending A', owner: ACCOUNTS.a.id, visibility: 'private' }]);
});

it.each([
  { view: 'szczegóły', path: (id: string) => `/notatki/${id}` },
  { view: 'lista', path: () => '/notatki' },
])('zmiana konta przy otwartej prywatnej notatce A ($view), równe rewizje obu baz: B nie widzi treści A', async ({ path }) => {
  const phone = new Phone(server);
  // B used this device before, so its database exists; then A signs in on the same tab.
  const tab = await signedIn(phone, 'b');
  expect(await tab.login(ACCOUNTS.a.login, ACCOUNTS.a.password)).toEqual({ ok: true });
  await tab.syncNow();
  const created = await tab.command((s) => s.create('note', { title: 'Prywatna notatka A', body: 'numer konta A' }, 'private'));
  const id = created.ok ? created.value : '';
  await tab.syncNow();
  // Make the revisions of both databases equal, so a view keyed only by revision would not reload.
  const revisionA = Number((await tab.store!.db.meta.get('revision'))?.value);
  const dbB = new LocalDatabase({ userId: ACCOUNTS.b.id, householdId: HOUSEHOLD }, { indexedDB: phone.indexedDB, IDBKeyRange });
  await dbB.meta.put({ key: 'revision', value: revisionA });
  dbB.close();

  await tab.refresh();
  expect(tab.getSnapshot().revision).toBe(revisionA);
  render(<Root controller={tab} />);
  go(path(id));
  expect((await screen.findAllByText('Prywatna notatka A')).length).toBeGreaterThan(0);

  await adoptB(phone, tab);
  await waitFor(() => expect(tab.getSnapshot().revision).toBe(revisionA));
  await waitFor(() => expect(document.body.textContent).not.toContain('Prywatna notatka A'));
  expect(document.body.textContent).not.toContain('numer konta A');
  // A's data stays in A's database only; nothing of it was written for B.
  expect(await tab.store!.db.records.count()).toBe(0);
  expect(server.count('notes', `owner_id = '${ACCOUNTS.b.id}'`)).toBe(0);
});

it('notatki: pull podczas otwartego edytora zachowuje szkic, blokuje stary zapis i umożliwia ręczne połączenie z aktualną podstawą', async () => {
  const pa = new Phone(server), pb = new Phone(server);
  const a = await signedIn(pa, 'a'), b = await signedIn(pb, 'b');
  const created = await a.command((s) => s.create('note', { title: 'Wspólny plan', body: 'Początek' }, 'shared'));
  const id = created.ok ? created.value : '';
  await a.syncNow(); await b.syncNow();
  render(<Root controller={b} />); go(`/notatki/${id}/edycja`);
  fireEvent.change(await screen.findByLabelText('Treść'), { target: { value: 'Mój szkic ⛵' } });
  await act(async () => { await a.command((s) => s.update('note', id, { body: 'Nowy tekst 🐢' })); await a.syncNow(); await b.syncNow(); });
  expect(await screen.findByText('Notatka zmieniła się podczas edycji')).toBeTruthy();
  expect(screen.getByText('Nowy tekst 🐢')).toBeTruthy();
  expect((screen.getByLabelText('Treść') as HTMLTextAreaElement).value).toBe('Mój szkic ⛵');
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Porównaj obie wersje');
  expect((await b.store!.get(id))!.data.body).toBe('Nowy tekst 🐢');
  fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Nowy tekst 🐢\nMój szkic ⛵' } });
  fireEvent.click(screen.getByRole('button', { name: 'Użyj bieżącej wersji jako podstawy' }));
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(window.location.pathname).toBe(`/notatki/${id}`));
  await act(async () => { await b.syncNow(); });
  expect(server.database.sqlite.prepare('SELECT body FROM notes WHERE id = ?').get(id)).toEqual({ body: 'Nowy tekst 🐢\nMój szkic ⛵' });
});
