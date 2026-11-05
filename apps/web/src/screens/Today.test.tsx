// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { taskDataSchema } from '@razem/contracts';
import { App } from '../App.js';
import { navigate } from '../router.js';
import { addDays, isoDate, todayIn } from '../dates.js';
import { todayTasks } from './Today.js';
import { calendarEntries } from './Calendar.js';
import type { Typed } from './records.js';
import { useControllerServices } from '../offline/live.js';
import { Phone, startServer } from '../offline/test-harness.js';
import type { Server } from '../offline/test-harness.js';
import type { AppController } from '../offline/controller.js';
import { ACCOUNTS } from '../offline/test-harness.js';
let server: Server;
const tabs: AppController[] = [];
beforeEach(async () => { server = await startServer(); window.history.replaceState(null, '', '/'); });
afterEach(async () => { cleanup(); vi.restoreAllMocks(); for (const tab of tabs.splice(0)) await tab.dispose(); await server.close(); });
function Root({ controller }: { controller: AppController }) { return <App services={useControllerServices(controller)} />; }
const go = (path: string) => act(() => navigate(path));
async function signed(device: Phone, who: 'a' | 'b') {
  const tab = device.tab(); tabs.push(tab); await tab.init(); await tab.login(ACCOUNTS[who].login, ACCOUNTS[who].password); await tab.syncNow(); return tab;
}
function task(patch: Record<string, unknown>): Typed<'task'> {
  return { id: crypto.randomUUID(), entityType: 'task', mine: true, version: 1, visibility: 'shared', data: taskDataSchema.parse({ title: 'Termin', description: '', assignee: 'self', dueDate: null, dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null, ...patch }) };
}
it('Dzisiaj: zadania bez terminu/przyszłe/ukończone pominięte; najstarszy cykl, DST i własna strefa', () => {
  const now = new Date('2026-03-29T00:30:00Z');
  const due = task({ dueDate: '2026-03-29' }), overdue = task({ dueDate: '2026-03-28' });
  const future = task({ dueDate: '2026-03-30' }), done = task({ dueDate: '2026-03-29', completedAt: '2026-03-28T10:00:00Z' });
  const ownZone = task({ dueAt: '2026-03-29T08:00:00Z', timezone: 'America/Los_Angeles' });
  const repeating = task({ dueDate: '2026-03-27', recurrence: { frequency: 'daily', interval: 1, startDate: '2026-03-27', time: null } });
  const occurrence: Typed<'task_occurrence'> = { id: crypto.randomUUID(), entityType: 'task_occurrence', version: 1, mine: true, visibility: 'shared', data: { taskId: repeating.id, occurrenceKey: '2026-03-27', completedAt: '2026-03-27T10:00:00Z' } };
  const result = todayTasks([due, overdue, future, done, ownZone, repeating, task({})], [occurrence], now);
  expect(result.map((r) => r.id).sort()).toEqual([due.id, overdue.id, repeating.id].sort());
  expect(result.find((r) => r.id === repeating.id)?.data.dueDate).toBe('2026-03-28');
});
it('okno siedmiu dni: trwające wielodniowe, koniec wyłączny, przełom roku i 29.02', () => {
  const record = { id: crypto.randomUUID(), entityType: 'calendar_event' as const, mine: true, version: 1, visibility: 'shared' as const };
  const events: Typed<'calendar_event'>[] = [
    { ...record, data: { title: 'Trwające', description: '', allDay: true, timezone: 'Europe/Warsaw', startDate: '2026-12-27', endDate: '2026-12-31', startAt: null, endAt: null } },
    { ...record, id: crypto.randomUUID(), data: { title: 'Poza', description: '', allDay: true, timezone: 'Europe/Warsaw', startDate: '2027-01-05', endDate: '2027-01-06', startAt: null, endAt: null } },
  ];
  const dates: Typed<'important_date'>[] = [{ ...record, id: crypto.randomUUID(), entityType: 'important_date', data: { name: 'Nowy rok', month: 1, day: 1, startYear: null, kind: 'other' } }];
  expect(calendarEntries(events, dates, '2026-12-29').filter((r) => r.end > '2026-12-29' && r.start < '2027-01-05').map((r) => r.title)).toEqual(['Trwające', 'Nowy rok']);
  expect(calendarEntries([], [{ ...dates[0]!, data: { ...dates[0]!.data, month: 2, day: 29, startYear: 2024 } }], '2027-02-27')[0]?.start).toBe('2027-02-28');
});
it('prawdziwe lokalne podsumowania offline, odhacz/Cofnij, szybkie dodawanie i brak prywatnych danych partnera', async () => {
  const device = new Phone(server), a = await signed(device, 'a');
  const today = isoDate(todayIn());
  const due = await a.store!.create('task', task({ title: 'Paczka dziś', dueDate: today }).data, 'shared');
  expect(due.ok).toBe(true);
  await a.store!.create('task', task({ title: 'Tajny obowiązek', dueDate: today }).data, 'private');
  await a.store!.create('calendar_event', { title: 'Wizyta', description: '', timezone: 'Europe/Warsaw', allDay: true, startDate: today, endDate: addDays(today, 1), startAt: null, endAt: null }, 'shared');
  const list = await a.store!.create('shopping_list', { name: 'Aktywna lista' }, 'shared');
  if (!list.ok) throw new Error('list');
  await a.store!.create('shopping_item', { listId: list.value, name: 'Mleko', quantity: '', note: '', checked: false, sortKey: 1 });
  await a.syncNow();
  const b = await signed(new Phone(server), 'b');
  render(<Root controller={b} />);
  expect(await screen.findByText('Paczka dziś')).toBeTruthy(); expect(screen.queryByText('Tajny obowiązek')).toBeNull();
  cleanup(); device.setOffline(true); render(<Root controller={a} />);
  expect(await screen.findByText('Paczka dziś')).toBeTruthy(); expect(await screen.findByText('Do kupienia: 1')).toBeTruthy(); expect(await screen.findByText('Wizyta')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Ukończ: Paczka dziś' }));
  await waitFor(() => expect(screen.queryByRole('checkbox', { name: 'Ukończ: Paczka dziś' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Cofnij' }));
  expect(await screen.findByRole('checkbox', { name: 'Ukończ: Paczka dziś' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Dodaj' }));
  fireEvent.click(within(screen.getByRole('list', { name: 'Dodaj' })).getByRole('link', { name: 'Notatka' }));
  fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Własna notatka' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(window.location.pathname).toBe('/notatki'));
  expect((await a.store!.list('note'))[0]?.visibility).toBe('private');
  go('/'); expect(await screen.findByText('Aktywna lista')).toBeTruthy();
});
it('profil: spóźniony odczyt wypełnia formularz, późniejszy refresh nie nadpisuje nietkniętych pól', async () => {
  const device = new Phone(server), a = await signed(device, 'a');
  render(<Root controller={a} />); go('/ustawienia/profil');
  fireEvent.change(screen.getByLabelText('Twoja nazwa'), { target: { value: 'Tylko nazwa' } });
  // Another phone changes the zone while this form edits the name.
  const other = await signed(new Phone(server), 'b');
  await act(async () => { await other.updateSettings({ timezone: 'Pacific/Kiritimati' }, other.getSnapshot().generation); await a.syncNow(); });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(window.location.pathname).toBe('/ustawienia'));
  expect(a.getSnapshot().settings?.household.timezone).toBe('Pacific/Kiritimati');
  expect(a.getSnapshot().settings?.members.find((m) => m.id === ACCOUNTS.a.id)?.displayName).toBe('Tylko nazwa');
});
