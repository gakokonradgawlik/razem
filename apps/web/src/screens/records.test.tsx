// @vitest-environment jsdom
// Detail, edit and item screens on a test-only in-memory port (fixtures are synthetic;
// the app itself never ships sample data).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EntityType } from '@razem/contracts';
import { App } from '../App.js';
import { matchPath, navigate, pathFor } from '../router.js';
import { unavailableServices } from '../services.js';
import type { AppServices, StoredRecord } from '../services.js';
import { changedFields } from './records.js';

const go = (path: string) => act(() => navigate(path));
beforeEach(() => { window.history.replaceState(null, '', '/'); localStorage.clear(); });
afterEach(cleanup);

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const EMPTY_LIST = id(11), LIST = id(1), MILK = id(2), BREAD = id(3), OTHER_LIST = id(4), FOREIGN_ITEM = id(5), TASK = id(6), PARTNER_TASK = id(7), EVENT = id(8), NOTE = id(9), DATE = id(10);
const rec = (n: string, entityType: EntityType, data: Record<string, unknown>, extra: Partial<StoredRecord> = {}): StoredRecord =>
  ({ id: n, entityType, visibility: 'shared', version: 3, mine: true, data, ...extra });

const fixtures: StoredRecord[] = [
  rec(LIST, 'shopping_list', { name: 'Biedronka w sobotę' }),
  rec(OTHER_LIST, 'shopping_list', { name: 'Apteka' }, { visibility: 'private' }),
  rec(EMPTY_LIST, 'shopping_list', { name: 'Na działkę' }, { visibility: 'private' }),
  rec(MILK, 'shopping_item', { listId: LIST, name: 'Mleko', quantity: '2 l', note: 'bez laktozy', checked: false, sortKey: 2 }),
  rec(BREAD, 'shopping_item', { listId: LIST, name: 'Chleb', quantity: '', note: '', checked: true, sortKey: 1 }),
  rec(FOREIGN_ITEM, 'shopping_item', { listId: OTHER_LIST, name: 'Witamina D', quantity: '', note: '', checked: false, sortKey: 1 }),
  rec(TASK, 'task', { title: 'Zapłacić za prąd', description: 'Do 10.', assignee: 'self', dueDate: null, dueAt: '2026-03-28T17:00:00Z', timezone: 'Europe/Warsaw', completedAt: null, recurrence: null }),
  rec(PARTNER_TASK, 'task', { title: 'Odebrać paczkę', description: '', assignee: 'self', dueDate: null, dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null }, { mine: false }),
  rec(EVENT, 'calendar_event', { title: 'Wyjazd w góry', description: '', allDay: true, timezone: 'Europe/Warsaw', startDate: '2099-03-28', endDate: '2099-03-30', startAt: null, endAt: null }),
  rec(NOTE, 'note', { title: 'Pomysły na prezenty', body: 'Książka o żeglarstwie\nSzalik' }, { visibility: 'private' }),
  rec(DATE, 'important_date', { name: 'Rocznica ślubu', kind: 'anniversary', month: 6, day: 14, startYear: 2015 }),
];

it('zakupy: szybkie dodawanie zachowuje tekst przy błędzie i czyści dopiero po lokalnym zapisie', async () => {
  const services = memoryServices();
  services.saveRecord.mockResolvedValueOnce({ ok: false, reason: 'storage_full' });
  render(<App services={services} />);
  go(`/zakupy/${LIST}`);
  const input = await screen.findByLabelText('Nazwa produktu') as HTMLInputElement;
  const form = screen.getByRole('form', { name: 'Szybkie dodawanie' });
  fireEvent.submit(form);
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(services.saveRecord).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '  Świeże bułki  ' } });
  fireEvent.submit(form);
  expect((await screen.findByRole('alert')).textContent).toContain('brak miejsca');
  expect(input.value).toBe('  Świeże bułki  ');
  fireEvent.submit(form);
  await waitFor(() => expect(input.value).toBe(''));
  expect(document.activeElement).toBe(input);
  expect(window.location.pathname).toBe(`/zakupy/${LIST}`);
  expect(services.saveRecord).toHaveBeenLastCalledWith({ entityType: 'shopping_item', data: {
    listId: LIST, name: 'Świeże bułki', quantity: '', note: '', checked: false, sortKey: expect.any(Number),
  } });
});

it('zakupy: równe klucze mają ten sam porządek niezależnie od kolejności odczytu', async () => {
  const items = [BREAD, MILK].map((itemId) => rec(itemId, 'shopping_item', {
    listId: LIST, name: itemId === MILK ? 'Mleko' : 'Chleb', quantity: '', note: '', checked: false, sortKey: 7,
  }));
  render(<App services={memoryServices([fixtures[0]!, ...items])} />);
  go(`/zakupy/${LIST}`);
  const list = await screen.findByRole('list', { name: 'Do kupienia' });
  expect(within(list).getAllByRole('link').map((link) => link.textContent)).toEqual(['Mleko', 'Chleb']);
});

function memoryServices(records = fixtures) {
  const services = {
    ...unavailableServices,
    listRecords: vi.fn<AppServices['listRecords']>(async ({ entityType, parentId }) => ({ status: 'ok', value: records.filter((record) =>
      record.entityType === entityType && (!parentId || record.data.listId === parentId || record.data.taskId === parentId)) })),
    getRecord: vi.fn<AppServices['getRecord']>(async (entityType, recordId) => {
      const found = records.find((record) => record.id === recordId && record.entityType === entityType);
      return found ? { status: 'ok', value: found } : { status: 'not_found' };
    }),
    saveRecord: vi.fn<AppServices['saveRecord']>(async () => ({ ok: true })),
    updateRecord: vi.fn<AppServices['updateRecord']>(async () => ({ ok: true })),
    deleteRecord: vi.fn<AppServices['deleteRecord']>(async () => ({ ok: true })),
  } satisfies AppServices;
  return services;
}

it('router: parametr pasuje tylko do UUID, więc /zakupy/nowa nie jest listą', () => {
  expect(matchPath('/zakupy/:listId', '/zakupy/nowa')).toBeNull();
  expect(matchPath('/zakupy/:listId', `/zakupy/${LIST}/`)).toEqual({ listId: LIST });
  expect(matchPath('/zakupy/:listId/pozycje/:itemId', `/zakupy/${LIST}/pozycje/${MILK}`)).toEqual({ listId: LIST, itemId: MILK });
  expect(pathFor('/zakupy/:listId/pozycje/nowa', { listId: LIST })).toBe(`/zakupy/${LIST}/pozycje/nowa`);
  expect(changedFields({ a: 1, b: { c: 1 } }, { a: 1, b: { c: 2 } })).toEqual({ b: { c: 2 } });
});

it('zakupy: z listy list do zawartości; kupione na dole; odhaczenie zapisuje od razu i ma Cofnij', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  go('/zakupy');
  fireEvent.click(await screen.findByRole('link', { name: /Biedronka w sobotę/ }));
  expect(window.location.pathname).toBe(`/zakupy/${LIST}`);
  expect(await screen.findByRole('heading', { level: 1, name: 'Biedronka w sobotę' })).toBeTruthy();
  const open = await screen.findByRole('list', { name: 'Do kupienia' });
  const bought = screen.getByRole('list', { name: 'Kupione' });
  expect(within(open).getByText('Mleko')).toBeTruthy();
  expect(within(open).getByText('2 l · bez laktozy')).toBeTruthy();
  expect(within(bought).getByText('Chleb')).toBeTruthy();
  expect(open.compareDocumentPosition(bought) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.queryByText('Witamina D')).toBeNull();

  fireEvent.click(screen.getByRole('checkbox', { name: 'Kupione: Mleko' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenCalledWith({ entityType: 'shopping_item', id: MILK, baseVersion: 3, patch: { checked: true } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Cofnij' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenLastCalledWith({ entityType: 'shopping_item', id: MILK, baseVersion: 3, patch: { checked: false } }));
});

it('zakupy: nieudane odhaczenie jest zgłoszone, nie udaje sukcesu', async () => {
  const services = { ...memoryServices(), updateRecord: vi.fn<AppServices['updateRecord']>(async () => ({ ok: false, reason: 'storage_unavailable' })) };
  render(<App services={services} />);
  go(`/zakupy/${LIST}`);
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Kupione: Mleko' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Nie zmieniono „Mleko”');
  expect(screen.queryByRole('button', { name: 'Cofnij' })).toBeNull();
});

it('zakupy: formularz pozycji (nazwa, ilość, uwaga) dziedziczy widoczność listy i zachowuje treść po błędzie', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  go(`/zakupy/${EMPTY_LIST}`);
  expect(await screen.findByText('Lista jest pusta')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('link', { name: 'Dodaj pozycję' })[0]!);
  expect(await screen.findByText('Lista:')).toBeTruthy();
  expect(screen.getByText('Tylko ja')).toBeTruthy();
  expect(screen.getByText(/Widoczność jak lista/)).toBeTruthy();
  expect(screen.queryByRole('radio')).toBeNull();
  fireEvent.change(screen.getByLabelText('Ilość (opcjonalnie)'), { target: { value: '1 opak.' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect(screen.getByLabelText('Nazwa').getAttribute('aria-invalid')).toBe('true');
  expect((screen.getByLabelText('Ilość (opcjonalnie)') as HTMLInputElement).value).toBe('1 opak.');
  fireEvent.change(screen.getByLabelText('Nazwa'), { target: { value: ' Witamina C ' } });
  fireEvent.change(screen.getByLabelText('Uwaga (opcjonalnie)'), { target: { value: 'dla dzieci' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(services.saveRecord).toHaveBeenCalledOnce());
  const input = services.saveRecord.mock.calls[0]![0];
  expect(input).not.toHaveProperty('visibility');
  expect(input).toMatchObject({ entityType: 'shopping_item', data: { listId: EMPTY_LIST, name: 'Witamina C', quantity: '1 opak.', note: 'dla dzieci', checked: false } });
  await waitFor(() => expect(window.location.pathname).toBe(`/zakupy/${EMPTY_LIST}`));
});

it('zakupy: edycja pozycji wysyła tylko zmienione pola; pozycja z innej listy jest „nie znaleziona”', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  go(`/zakupy/${LIST}`);
  fireEvent.click(await screen.findByRole('link', { name: /Mleko/ }));
  const quantity = await screen.findByLabelText('Ilość (opcjonalnie)') as HTMLInputElement;
  expect(quantity.value).toBe('2 l');
  fireEvent.change(quantity, { target: { value: '3 l' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenCalledWith({ entityType: 'shopping_item', id: MILK, baseVersion: 3, patch: { quantity: '3 l' } }));
  await waitFor(() => expect(window.location.pathname).toBe(`/zakupy/${LIST}`));

  go(`/zakupy/${LIST}/pozycje/${FOREIGN_ITEM}`);
  expect(await screen.findByText('Nie znaleziono wpisu')).toBeTruthy();
  expect(screen.queryByText('Witamina D')).toBeNull();
});

it('zakupy: zmiana nazwy listy z pokazaniem stałej widoczności i usunięcie z potwierdzeniem', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  go(`/zakupy/${LIST}`);
  fireEvent.click(await screen.findByRole('link', { name: 'Zmień nazwę listy' }));
  const name = await screen.findByLabelText('Nazwa listy') as HTMLInputElement;
  expect(name.value).toBe('Biedronka w sobotę');
  expect(screen.queryByRole('radio')).toBeNull();
  expect(screen.getByText(/Widoczności nie można zmienić/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  // Nothing changed → nothing written, back to the list.
  await waitFor(() => expect(window.location.pathname).toBe(`/zakupy/${LIST}`));
  expect(services.updateRecord).not.toHaveBeenCalled();

  fireEvent.click(await screen.findByRole('button', { name: 'Usuń listę' }));
  expect(services.deleteRecord).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole('group', { name: /Potwierdź usunięcie/ })).getByRole('button', { name: 'Usuń' }));
  await waitFor(() => expect(services.deleteRecord).toHaveBeenCalledWith({ entityType: 'shopping_list', id: LIST, baseVersion: 3 }));
  await waitFor(() => expect(window.location.pathname).toBe('/zakupy'));
});

it('usuwanie bez magazynu zgłasza błąd i zostawia wpis na ekranie', async () => {
  const services = { ...memoryServices(), deleteRecord: unavailableServices.deleteRecord };
  render(<App services={services} />);
  go(`/notatki/${NOTE}`);
  fireEvent.click(await screen.findByRole('button', { name: 'Usuń notatkę' }));
  fireEvent.click(within(screen.getByRole('group', { name: /Potwierdź usunięcie/ })).getByRole('button', { name: 'Usuń' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Nie zapisano');
  expect(window.location.pathname).toBe(`/notatki/${NOTE}`);
});

it('zadania: lista → szczegóły → edycja; przypisanie względem właściciela; ukończenie zapisuje completedAt', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  go('/zadania');
  // "Moje": my task assigned to me, and the partner's task is assigned to its owner (not me).
  expect(await screen.findByRole('link', { name: /Zapłacić za prąd/ })).toBeTruthy();
  expect(screen.queryByRole('link', { name: /Odebrać paczkę/ })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Wspólne' }));
  fireEvent.click(await screen.findByRole('link', { name: /Odebrać paczkę/ }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Odebrać paczkę' })).toBeTruthy();
  expect(screen.getByText('Druga osoba')).toBeTruthy();

  go(`/zadania/${TASK}`);
  expect(await screen.findByText('sobota, 28 marca 2026 18:00')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Oznacz jako ukończone' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'task', id: TASK, baseVersion: 3, patch: { completedAt: expect.stringMatching(/Z$/) } })));

  fireEvent.click(screen.getByRole('link', { name: 'Edytuj' }));
  const title = await screen.findByLabelText('Tytuł') as HTMLInputElement;
  expect(title.value).toBe('Zapłacić za prąd');
  expect((screen.getByLabelText('Termin – dzień') as HTMLInputElement).value).toBe('2026-03-28');
  expect((screen.getByLabelText('Godzina (opcjonalnie)') as HTMLInputElement).value).toBe('18:00');
  expect(screen.queryByRole('radio', { name: /Tylko ja/ })).toBeNull();
  fireEvent.change(screen.getByLabelText('Godzina (opcjonalnie)'), { target: { value: '19:30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenLastCalledWith({ entityType: 'task', id: TASK, baseVersion: 3, patch: { dueAt: '2026-03-28T18:30:00Z' } }));
  await waitFor(() => expect(window.location.pathname).toBe(`/zadania/${TASK}`));
});

// Contract 'self'/'partner' is relative to the owner; the viewer of a partner's task sees it swapped.
it.each([
  { stored: 'self', shown: 'Druga osoba', value: 'other', pick: 'me', patched: 'partner' },
  { stored: 'partner', shown: 'Ja', value: 'me', pick: 'other', patched: 'self' },
] as const)('zadania: wspólne zadanie drugiej osoby z assignee=$stored — szczegóły i edycja zgodne, patch tylko po świadomym wyborze', async ({ stored, shown, value, pick, patched }) => {
  const task = rec(PARTNER_TASK, 'task', { title: 'Odebrać paczkę', description: '', assignee: stored, dueDate: null, dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null }, { mine: false });
  const services = memoryServices([task]);
  render(<App services={services} />);
  go(`/zadania/${PARTNER_TASK}`);
  expect(await screen.findByText(shown)).toBeTruthy();

  fireEvent.click(screen.getByRole('link', { name: 'Edytuj' }));
  const assignee = await screen.findByRole('combobox', { name: 'Kto to zrobi?' }) as HTMLSelectElement;
  expect(assignee.value).toBe(value);
  expect(assignee.selectedOptions[0]?.textContent).toBe(shown);
  fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Odebrać paczkę z paczkomatu' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenLastCalledWith({ entityType: 'task', id: PARTNER_TASK, baseVersion: 3, patch: { title: 'Odebrać paczkę z paczkomatu' } }));
  await waitFor(() => expect(window.location.pathname).toBe(`/zadania/${PARTNER_TASK}`));

  go(`/zadania/${PARTNER_TASK}/edycja`);
  fireEvent.change(await screen.findByRole('combobox', { name: 'Kto to zrobi?' }), { target: { value: pick } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenLastCalledWith({ entityType: 'task', id: PARTNER_TASK, baseVersion: 3, patch: { assignee: patched } }));
});

it('kalendarz: agenda → szczegóły → edycja wydarzenia całodniowego (koniec włącznie w formularzu)', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  go('/kalendarz');
  fireEvent.click(await screen.findByRole('link', { name: /Wyjazd w góry/ }));
  expect(await screen.findByText(/28 marca 2099 – .*29 marca 2099/)).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Edytuj' }));
  expect(((await screen.findByLabelText('Koniec – dzień')) as HTMLInputElement).value).toBe('2099-03-29');
  fireEvent.change(screen.getByLabelText('Koniec – dzień'), { target: { value: '2099-03-31' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenCalledWith({ entityType: 'calendar_event', id: EVENT, baseVersion: 3, patch: { endDate: '2099-04-01' } }));
});

it('notatki: wyszukiwanie lokalne bez polskich znaków, szczegóły i edycja z prywatnością jako tekst', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  go('/notatki');
  fireEvent.change(await screen.findByLabelText('Szukaj w notatkach'), { target: { value: 'ZEGLARSTW' } });
  fireEvent.click(await screen.findByRole('link', { name: /Pomysły na prezenty/ }));
  expect(await screen.findByText(/Książka o żeglarstwie/)).toBeTruthy();
  expect(screen.getByText('Tylko ja')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Edytuj' }));
  fireEvent.change(await screen.findByLabelText('Tytuł'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect(screen.getByText('Wpisz tytuł notatki.')).toBeTruthy();
  expect((screen.getByLabelText('Treść') as HTMLTextAreaElement).value).toBe('Książka o żeglarstwie\nSzalik');
  expect(services.updateRecord).not.toHaveBeenCalled();
  go('/notatki');
  fireEvent.change(await screen.findByLabelText('Szukaj w notatkach'), { target: { value: 'rower' } });
  expect(await screen.findByText('Brak wyników')).toBeTruthy();
});

it('ważne daty: lista → szczegóły → edycja', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  go('/wazne-daty');
  fireEvent.click(await screen.findByRole('link', { name: /Rocznica ślubu/ }));
  expect(await screen.findByText('14 czerwca, co roku')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Edytuj' }));
  expect(((await screen.findByLabelText('Rok początkowy (opcjonalnie)')) as HTMLInputElement).value).toBe('2015');
  fireEvent.change(screen.getByLabelText('Nazwa'), { target: { value: 'Rocznica ślubu Ani i Tomka' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(services.updateRecord).toHaveBeenCalledWith({ entityType: 'important_date', id: DATE, baseVersion: 3, patch: { name: 'Rocznica ślubu Ani i Tomka' } }));
});

it('wpis niedostępny dla konta wygląda jak usunięty, bez treści i bez działań', async () => {
  const services = memoryServices();
  render(<App services={services} />);
  const missing = id(99);
  for (const path of [`/zadania/${missing}`, `/notatki/${missing}/edycja`, `/kalendarz/${missing}`, `/wazne-daty/${missing}`, `/zakupy/${missing}`, `/zakupy/${missing}/pozycje/nowa`]) {
    go(path);
    expect(await screen.findByText('Nie znaleziono wpisu')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Usuń|Zapisz/ })).toBeNull();
  }
});

it('dane niezgodne z kontraktem nie są wyświetlane', async () => {
  render(<App services={memoryServices([rec(NOTE, 'note', { title: '', body: 'x', extra: true })])} />);
  go(`/notatki/${NOTE}`);
  expect(await screen.findByText('Nie można wyświetlić wpisu')).toBeTruthy();
  go('/notatki');
  expect(await screen.findByText('Brak notatek')).toBeTruthy();
});

it('zadanie z zakończonym harmonogramem i wszystkimi ukończeniami nie jest zaległe; historia nadal pozwala cofnąć termin', async () => {
  const services = memoryServices([
    rec(TASK, 'task', { title: 'Zakończony obowiązek', description: '', assignee: 'both', dueDate: '2026-01-31', dueAt: null,
      timezone: 'Europe/Warsaw', completedAt: null, recurrence: { frequency: 'daily', interval: 1, startDate: '2026-01-31', until: '2026-02-01', time: null } }),
    rec(id(90), 'task_occurrence', { taskId: TASK, occurrenceKey: '2026-01-31', completedAt: '2026-01-31T08:00:00Z' }),
  ]);
  render(<App services={services} />);
  go(`/zadania/${TASK}`);
  await waitFor(() => expect(screen.getAllByText('Harmonogram zakończony')).toHaveLength(2));
  expect(screen.queryByText('Zaległe', { exact: true })).toBeNull();
  expect(screen.getByRole('button', { name: 'Przywróć termin 2026-01-31' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /^Ukończ termin/ })).toBeNull();
  go('/zadania');
  fireEvent.click(await screen.findByRole('radio', { name: 'Zaległe' }));
  expect(await screen.findByText('Nic zaległego')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'Ukończone' }));
  expect(await screen.findByRole('link', { name: /Zakończony obowiązek/ })).toBeTruthy();
});

it('harmonogram zatrzymany przed pierwszym terminem pozostaje dostępny w Ukończonych', async () => {
  const services = memoryServices([rec(TASK, 'task', { title: 'Zatrzymany przed startem', description: '', assignee: 'both', dueDate: '2030-01-31', dueAt: null,
    timezone: 'Europe/Warsaw', completedAt: null, recurrence: { frequency: 'daily', interval: 1, startDate: '2030-01-31', until: '2030-01-31', time: null } })]);
  render(<App services={services} />);
  go('/zadania');
  fireEvent.click(await screen.findByRole('radio', { name: 'Ukończone' }));
  fireEvent.click(await screen.findByRole('link', { name: /Zatrzymany przed startem/ }));
  await waitFor(() => expect(screen.getAllByText('Harmonogram zakończony')).toHaveLength(2));
  expect(screen.getByRole('link', { name: 'Edytuj' })).toBeTruthy();
});

it('kalendarz: miesiąc ma poniedziałek, zakresy i ważne daty; dzień filtruje listę z prywatnością', async () => {
  const today = new Date();
  const y = today.getFullYear(), m = String(today.getMonth() + 1).padStart(2,'0');
  const data = [rec(EVENT, 'calendar_event', { ...fixtures.find((r) => r.id === EVENT)!.data, startDate: `${y}-${m}-02`, endDate: `${y}-${m}-05` }),
    rec(DATE, 'important_date', { name: 'Bez roku w miesiącu', month: today.getMonth() + 1, day: 3, startYear: null, kind: 'anniversary' }, { visibility: 'private' })];
  render(<App services={memoryServices(data)} />); go('/kalendarz');
  fireEvent.click(screen.getByRole('radio', { name: 'Miesiąc' }));
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('columnheader')[0]!.textContent).toBe('Pn');
  const list = await screen.findByRole('list', { name: 'Wpisy miesiąca' });
  expect(within(list).getByText('Bez roku w miesiącu')).toBeTruthy();
  expect(within(list).getByText('Tylko ja')).toBeTruthy();
  expect(within(list).queryByText(/lat/)).toBeNull();
  fireEvent.click(within(table).getByRole('button', { name: /, 3 .*wpisy: 2/ }));
  expect(within(screen.getByRole('list', { name: 'Wpisy wybranego dnia' })).getAllByRole('link')).toHaveLength(2);
  fireEvent.click(within(table).getByRole('button', { name: /, 5 .*wpisy: 0/ }));
  expect(await screen.findByText('Brak wydarzeń i ważnych dat w wybranym zakresie.')).toBeTruthy();
});

it('kalendarz: strefa i rozwiązanie luki DST walidowane przy polu bez utraty nazwy', async () => {
  const services = memoryServices(); render(<App services={services} />); go('/kalendarz/nowe');
  fireEvent.change(screen.getByLabelText('Nazwa'), { target: { value: 'W luce czasu' } });
  fireEvent.change(screen.getByLabelText('Początek – dzień'), { target: { value: '2026-03-29' } });
  fireEvent.change(screen.getByLabelText('Koniec – dzień'), { target: { value: '2026-03-29' } });
  const times = screen.getAllByLabelText('Godzina');
  fireEvent.change(times[0]!, { target: { value: '02:30' } }); fireEvent.change(times[1]!, { target: { value: '03:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect(await screen.findByText('Koniec po uwzględnieniu zmiany czasu musi być po początku.')).toBeTruthy();
  expect(services.saveRecord).not.toHaveBeenCalled();
  fireEvent.change(times[1]!, { target: { value: '03:30' } });
  fireEvent.change(screen.getByLabelText('Strefa czasowa'), { target: { value: 'Niepoprawna/Strefa' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect(await screen.findByText('Podaj poprawną strefę, np. Europe/Warsaw.')).toBeTruthy();
  expect((screen.getByLabelText('Nazwa') as HTMLInputElement).value).toBe('W luce czasu');
});

it('edycja kalendarza wysyła tylko zmienione pola i zachowuje równoczesne ustawienie przypomnienia', async () => {
  const reminder = rec(id(90), 'reminder', { targetType: 'calendar_event', targetId: EVENT, enabled: true, minutesBefore: 60, localTime: '10:00' });
  const services = { ...memoryServices([...fixtures, reminder]), saveCalendar: vi.fn<NonNullable<AppServices['saveCalendar']>>(async () => ({ ok: true })) };
  // The reminder query is scoped by its target (the actual services adapter applies this query).
  services.listRecords.mockImplementation(async ({ entityType }) => ({ status: 'ok', value: [...fixtures, reminder].filter((r) => r.entityType === entityType) }));
  render(<App services={services} />); go(`/kalendarz/${EVENT}/edycja`);
  fireEvent.change(await screen.findByLabelText('Nazwa'), { target: { value: 'Nowy tytuł wyjazdu' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(services.saveCalendar).toHaveBeenCalledWith({ entityType: 'calendar_event', id: EVENT, data: { title: 'Nowy tytuł wyjazdu' }, visibility: 'shared' }));
});
