// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App, findRoute, routes, tabs } from './App.js';
import { localDatabaseName } from './local-db.js';
import { navigate } from './router.js';
import { unavailableServices } from './services.js';
import type { AppServices } from './services.js';
import { THEME_STORAGE_KEY } from './theme.js';

const go = (path: string) => act(() => navigate(path));
beforeEach(() => { window.history.replaceState(null, '', '/'); localStorage.clear(); delete document.documentElement.dataset.theme; });
afterEach(cleanup);

it('dolna nawigacja ma pięć polskich zakładek i przełącza ekrany', () => {
  render(<App />);
  const nav = screen.getByRole('navigation', { name: 'Główna nawigacja' });
  expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Dzisiaj', 'Zakupy', 'Zadania', 'Kalendarz', 'Więcej']);
  expect(within(nav).getByRole('link', { name: 'Dzisiaj' }).getAttribute('aria-current')).toBe('page');
  for (const tab of tabs) {
    fireEvent.click(within(nav).getByRole('link', { name: tab.label }));
    expect(screen.getByRole('heading', { level: 1, name: tab.label })).toBeTruthy();
    expect(window.location.pathname).toBe(tab.path);
    expect(within(nav).getByRole('link', { name: tab.label }).getAttribute('aria-current')).toBe('page');
  }
});

const SAMPLE_ID = '0b6f5a62-3c1d-4e8f-9a7b-1c2d3e4f5a6b';
it('każdy ekran MVP (także szczegóły i edycja) ma polski tytuł; bez magazynu wpisów stany są uczciwe', async () => {
  render(<App />);
  for (const route of routes) {
    const path = route.path.replace(/:\w+/g, SAMPLE_ID);
    go(path);
    expect(findRoute(path)[0]).toBe(route);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent?.length).toBeGreaterThan(0);
    expect(document.title).toContain(route.path === '/' ? 'Razem' : route.title);
    if (route.path === '/zmiany/:conflictId') expect(await screen.findByText('Ten konflikt jest już rozwiązany')).toBeTruthy();
    else if (route.path.includes(':')) expect(await screen.findByText('Nie można wyświetlić wpisu')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\b(undefined|null|NaN|api\/|TODO|lorem)\b/i);
  }
  for (const path of ['/zakupy', '/zadania', '/kalendarz', '/notatki', '/wazne-daty']) {
    go(path);
    if (path === '/kalendarz') {
      expect(await screen.findByText('Nie można wczytać kalendarza z tego urządzenia.')).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Nowe wydarzenie' })).toBeTruthy();
    } else await waitFor(() => expect(screen.getAllByRole('link').some((link) => link.classList.contains('button'))).toBe(true));
  }
  go('/kosz');
  expect(await screen.findByText('Kosz jest pusty')).toBeTruthy();
  go('/nie-ma-takiej');
  expect(screen.getByRole('heading', { level: 1, name: 'Nie znaleziono' })).toBeTruthy();
});

it('ekrany z Więcej są osiągalne z listy i mają powrót', () => {
  render(<App />);
  go('/wiecej');
  for (const name of ['Notatki', 'Ważne daty', 'Kosz', 'Ustawienia']) {
    fireEvent.click(screen.getByRole('link', { name }));
    expect(screen.getByRole('heading', { level: 1, name })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('link', { name: 'Więcej' }).find((link) => link.classList.contains('nav-back'))!);
    expect(screen.getByRole('heading', { level: 1, name: 'Więcej' })).toBeTruthy();
  }
  const nav = screen.getByRole('navigation', { name: 'Główna nawigacja' });
  go('/notatki');
  expect(within(nav).getByRole('link', { name: 'Więcej' }).getAttribute('aria-current')).toBe('true');
});

it('menu dodawania na ekranie Dzisiaj otwiera się, ma nazwy i zamyka Escape', () => {
  render(<App />);
  const button = screen.getByRole('button', { name: 'Dodaj' });
  expect(button.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(button);
  const menu = screen.getByRole('list', { name: 'Dodaj' });
  expect(within(menu).getAllByRole('link').map((link) => link.textContent)).toEqual(['Zadanie', 'Wydarzenie', 'Lista zakupów', 'Notatka', 'Ważna data']);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('list', { name: 'Dodaj' })).toBeNull();
});

it('wybór prywatności: domyślnie notatka „Tylko ja”, zadanie i lista „Wspólne”, tekst przed zapisem', () => {
  render(<App />);
  go('/notatki/nowa');
  expect((screen.getByRole('radio', { name: /Tylko ja/ }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByText(/Zapiszesz jako:/).textContent).toContain('Tylko ja');
  for (const path of ['/zadania/nowe', '/zakupy/nowa', '/kalendarz/nowe', '/wazne-daty/nowa']) {
    go(path);
    expect((screen.getByRole('radio', { name: /Wspólne/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/Zapiszesz jako:/).textContent).toContain('Wspólne');
    expect(screen.getByText(/Widoczności nie można zmienić po zapisaniu/)).toBeTruthy();
  }
  go('/zadania/nowe');
  fireEvent.click(screen.getByRole('radio', { name: /Tylko ja/ }));
  const assignee = screen.getByRole('combobox', { name: 'Kto to zrobi?' }) as HTMLSelectElement;
  expect(assignee.value).toBe('me');
  expect([...assignee.options].filter((option) => !option.disabled).map((option) => option.value)).toEqual(['me']);
});

it('walidacja pokazuje błąd przy polu, przenosi fokus i nie wywołuje zapisu', async () => {
  const saveRecord = vi.fn<AppServices['saveRecord']>();
  render(<App services={{ ...unavailableServices, saveRecord }} />);
  go('/zadania/nowe');
  fireEvent.change(screen.getByLabelText('Opis (opcjonalnie)'), { target: { value: 'Pamiętaj o paragonie' } });
  fireEvent.change(screen.getByLabelText('Godzina (opcjonalnie)'), { target: { value: '10:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  const title = screen.getByLabelText('Tytuł');
  expect(title.getAttribute('aria-invalid')).toBe('true');
  expect(document.getElementById(title.getAttribute('aria-describedby')!.split(' ')[0]!)?.textContent).toContain('Wpisz tytuł zadania.');
  expect(screen.getByText('Godzina wymaga dnia.')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('Wpisana treść została zachowana');
  await waitFor(() => expect(document.activeElement).toBe(title));
  expect(saveRecord).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Opis (opcjonalnie)') as HTMLTextAreaElement).value).toBe('Pamiętaj o paragonie');
});

it('nieudany zapis nie udaje sukcesu i zachowuje treść formularza', async () => {
  render(<App />);
  go('/notatki/nowa');
  fireEvent.change(screen.getByLabelText('Tytuł'), { target: { value: 'Pomysły na prezenty' } });
  fireEvent.change(screen.getByLabelText('Treść'), { target: { value: 'Książka, szalik' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Nie zapisano.*zachowana/);
  expect(window.location.pathname).toBe('/notatki/nowa');
  expect((screen.getByLabelText('Tytuł') as HTMLInputElement).value).toBe('Pomysły na prezenty');
  expect((screen.getByLabelText('Treść') as HTMLTextAreaElement).value).toBe('Książka, szalik');
});

it('poprawny formularz przekazuje dane zgodne z kontraktem i wybraną widoczność', async () => {
  const saveRecord = vi.fn<AppServices['saveRecord']>(async () => ({ ok: true }));
  render(<App services={{ ...unavailableServices, saveRecord }} />);
  go('/kalendarz/nowe');
  fireEvent.change(screen.getByLabelText('Nazwa'), { target: { value: '  Wyjazd w góry ' } });
  fireEvent.click(screen.getByRole('switch', { name: 'Cały dzień' }));
  fireEvent.change(screen.getByLabelText('Początek – dzień'), { target: { value: '2026-03-28' } });
  fireEvent.change(screen.getByLabelText('Koniec – dzień'), { target: { value: '2026-03-29' } });
  fireEvent.click(screen.getByRole('radio', { name: /Tylko ja/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(saveRecord).toHaveBeenCalledOnce());
  expect(saveRecord.mock.calls[0]![0]).toEqual({ entityType: 'calendar_event', visibility: 'private', data: {
    title: 'Wyjazd w góry', description: '', allDay: true, timezone: 'Europe/Warsaw',
    startDate: '2026-03-28', endDate: '2026-03-30', startAt: null, endAt: null,
  } });
  await waitFor(() => expect(window.location.pathname).toBe('/kalendarz'));
});

it('logowanie: walidacja, wywołanie portu i zachowanie danych po błędzie bez ujawniania szczegółów', async () => {
  const login = vi.fn<AppServices['login']>(async () => ({ ok: false, reason: 'invalid_credentials' }));
  render(<App services={{ ...unavailableServices, login }} />);
  go('/logowanie');
  expect(screen.queryByRole('navigation')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Zaloguj się' }));
  expect(screen.getByText('Wpisz login.')).toBeTruthy();
  expect(login).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'ania@dom' } });
  fireEvent.change(screen.getByLabelText('Hasło'), { target: { value: 'błędne hasło' } });
  fireEvent.click(screen.getByRole('button', { name: 'Pokaż hasło' }));
  expect(screen.getByLabelText('Hasło').getAttribute('type')).toBe('text');
  fireEvent.click(screen.getByRole('button', { name: 'Zaloguj się' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Nieprawidłowy login lub hasło.');
  expect(login).toHaveBeenCalledWith({ login: 'ania@dom', password: 'błędne hasło' });
  expect((screen.getByLabelText('Login') as HTMLInputElement).value).toBe('ania@dom');
  expect(document.body.textContent).not.toContain('błędne hasło');
});

it('logowanie bez podłączonego serwera mówi uczciwie, że funkcja nie jest dostępna', async () => {
  render(<App />);
  go('/logowanie');
  fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'ania' } });
  fireEvent.change(screen.getByLabelText('Hasło'), { target: { value: 'cokolwiek' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zaloguj się' }));
  expect((await screen.findByRole('alert')).textContent).toContain('nie jest jeszcze dostępna');
});

it('zmiana hasła stosuje wspólną politykę haseł i sprawdza powtórzenie', async () => {
  const changePassword = vi.fn<AppServices['changePassword']>(async () => ({ ok: true }));
  render(<App services={{ ...unavailableServices, changePassword, session: { login: 'ania@dom', displayName: 'Ania', mustChangePassword: true } }} />);
  go('/ustawienia/haslo');
  expect(screen.getByText('Ustaw własne hasło')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Obecne hasło'), { target: { value: 'tymczasowe-123' } });
  fireEvent.change(screen.getByLabelText('Nowe hasło'), { target: { value: 'krótkie' } });
  fireEvent.change(screen.getByLabelText('Powtórz nowe hasło'), { target: { value: 'inne' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect(screen.getByText(/co najmniej 12 znaków/)).toBeTruthy();
  expect(screen.getByText('Hasła nie są takie same.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Nowe hasło'), { target: { value: 'ania-ma-kota-123' } });
  fireEvent.change(screen.getByLabelText('Powtórz nowe hasło'), { target: { value: 'ania-ma-kota-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  expect(screen.getByText('Hasło nie może zawierać loginu.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Nowe hasło'), { target: { value: 'zielony rower 42' } });
  fireEvent.change(screen.getByLabelText('Powtórz nowe hasło'), { target: { value: 'zielony rower 42' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zapisz' }));
  await waitFor(() => expect(changePassword).toHaveBeenCalledWith({ currentPassword: 'tymczasowe-123', newPassword: 'zielony rower 42' }));
});

it('motyw: wybór jest zapamiętany na urządzeniu i ustawia data-theme', () => {
  render(<App />);
  go('/ustawienia');
  fireEvent.click(screen.getByRole('radio', { name: 'Ciemny' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  fireEvent.click(screen.getByRole('radio', { name: 'Systemowy' }));
  expect(document.documentElement.dataset.theme).toBeUndefined();
});

it('status synchronizacji nie udaje synchronizacji bez sesji i rozpoznaje offline', () => {
  render(<App />);
  expect(document.querySelector('.sync-badge')!.textContent).toBe('Nie zalogowano');
  cleanup();
  render(<App services={{ ...unavailableServices, pendingChanges: 3 }} />);
  expect(document.querySelector('.sync-badge')!.textContent).toBe('Zaloguj się, aby wysłać zmiany (3)Zaloguj się');
  expect(within(document.querySelector<HTMLElement>('.sync-badge')!).getByRole('link', { name: 'Zaloguj się' }).getAttribute('href')).toBe('/logowanie');
  const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => { window.dispatchEvent(new Event('offline')); });
  expect(document.querySelector('.sync-badge')!.textContent).toBe('Offline · zmiany czekają na wysłanie (3)');
  online.mockRestore();
});

it('przestrzeń IndexedDB jest oddzielona dla konta i gospodarstwa', () => {
  const a = '11111111-1111-4111-8111-111111111111';
  const b = '22222222-2222-4222-8222-222222222222';
  const keys = [localDatabaseName({ userId: a, householdId: a }), localDatabaseName({ userId: b, householdId: a }), localDatabaseName({ userId: a, householdId: b })];
  expect(new Set(keys).size).toBe(3);
  expect(() => localDatabaseName({ userId: 'anonymous', householdId: a })).toThrow();
});
