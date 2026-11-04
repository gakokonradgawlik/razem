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
