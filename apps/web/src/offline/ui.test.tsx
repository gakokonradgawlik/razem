// @vitest-environment jsdom
// Screens on the real data layer (AppController + Dexie on fake-indexeddb) and the real
// server: honest status with ACK and unsent count, both versions of a conflict with a
// merge that is re-checked by the server, storage-full message with export, logout warning.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { navigate } from '../router.js';
import { useControllerServices } from './live.js';
import { ACCOUNTS, Phone, startServer } from './test-harness.js';
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
    make: ({ task }) => ({ taskId: task, occurrenceKey: '2026-11-05', completedAt: null }),
    mine: { completedAt: T1 }, theirs: { completedAt: T2 },
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
