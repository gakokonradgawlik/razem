// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Api } from './api.js';
import { PushOptIn } from './push.js';
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';
let permission: NotificationPermission, supported: boolean, installed: boolean;
let registration: { active: object; pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> } };
const requestPermission = vi.fn(), remove = vi.fn(), subscribe = vi.fn(), status = vi.fn(), unsubscribe = vi.fn(async () => true);
let permissionStatus: EventTarget;
const originalAgent = navigator.userAgent;
beforeEach(() => {
  localStorage.clear(); permission = 'default'; installed = false; supported = true;
  requestPermission.mockReset().mockImplementation(async () => { permission = 'granted'; return permission; });
  remove.mockReset().mockResolvedValue(undefined); subscribe.mockReset().mockResolvedValue({ enabled: true }); status.mockReset().mockResolvedValue({ enabled: false }); unsubscribe.mockClear();
  vi.stubGlobal('Notification', { get permission() { return permission; }, requestPermission });
  vi.stubGlobal('PushManager', class {}); vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: originalAgent });
  Object.defineProperty(navigator, 'standalone', { configurable: true, get: () => installed });
  registration = { active: {}, pushManager: { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => ({ endpoint: 'https://web.push.apple.com/test', expirationTime: null, unsubscribe,
    toJSON: () => ({ keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } }) })) } };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, get: () => supported ? { getRegistration: async () => registration } : undefined });
  permissionStatus = new EventTarget(); Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query: async () => permissionStatus } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function client() {
  const api = new Api(); vi.spyOn(api, 'pushConfig').mockResolvedValue({ publicKey: 'B' + 'A'.repeat(86) });
  api.removePush = remove; api.subscribePush = subscribe; api.pushStatus = status;
  return api;
}
it('nie prosi automatycznie; kliknięcie prosi synchronicznie i rejestruje dopiero po zgodzie; wyłączenie odpina serwer', async () => {
  render(<PushOptIn account={ACCOUNT} api={client()} />);
  const button = screen.getByRole('button', { name: 'Włącz powiadomienia' });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(requestPermission).not.toHaveBeenCalled(); fireEvent.click(button); expect(requestPermission).toHaveBeenCalledTimes(1);
  await screen.findByRole('button', { name: 'Wyłącz powiadomienia na tym urządzeniu' });
  expect(registration.pushManager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true })); expect(subscribe).toHaveBeenCalledWith(ACCOUNT, expect.objectContaining({ deviceId: expect.any(String) }));
  fireEvent.click(screen.getByRole('button', { name: 'Wyłącz powiadomienia na tym urządzeniu' })); await waitFor(() => expect(remove).toHaveBeenCalledWith(ACCOUNT, expect.any(String)));
  await screen.findByRole('button', { name: 'Włącz powiadomienia' });
});
it('iPhone w karcie wymaga instalacji; brak wsparcia i odmowa nie wywołują promptu', async () => {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone' });
  const first = render(<PushOptIn account={ACCOUNT} api={client()} />);
  expect(screen.getByText(/Udostępnij → Do ekranu początkowego/)).toBeTruthy(); expect(requestPermission).not.toHaveBeenCalled(); first.unmount();
  installed = true; vi.stubGlobal('isSecureContext', false);
  const second = render(<PushOptIn account={ACCOUNT} api={client()} />); expect(screen.getByText(/nie obsługuje powiadomień/)).toBeTruthy(); second.unmount();
  vi.stubGlobal('isSecureContext', true); permission = 'denied';
  render(<PushOptIn account={ACCOUNT} api={client()} />); expect(screen.getByText(/Zgoda na powiadomienia jest wyłączona/)).toBeTruthy();
  await waitFor(() => expect(remove).toHaveBeenCalled()); expect(requestPermission).not.toHaveBeenCalled();
});
it('odmowa po kliknięciu i zmiana uprawnień po powrocie nie rejestrują samowolnie subskrypcji', async () => {
  requestPermission.mockImplementation(async () => { permission = 'denied'; return permission; });
  render(<PushOptIn account={ACCOUNT} api={client()} />);
  const button = screen.getByRole('button', { name: 'Włącz powiadomienia' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); await screen.findByText(/Zgoda na powiadomienia jest wyłączona/); expect(subscribe).not.toHaveBeenCalled();
  permission = 'granted'; fireEvent.focus(window); await screen.findByRole('button', { name: 'Włącz powiadomienia' }); expect(requestPermission).toHaveBeenCalledTimes(1);
  permission = 'denied'; permissionStatus.dispatchEvent(new Event('change')); await waitFor(() => expect(remove).toHaveBeenCalled());
});
it('zmiana konta w trakcie promptu nie dopina urządzenia ze starego ekranu', async () => {
  let resolve!: (value: NotificationPermission) => void; requestPermission.mockImplementation(() => new Promise<NotificationPermission>((r) => { resolve = r; }));
  const view = render(<PushOptIn account={ACCOUNT} api={client()} />);
  const button = screen.getByRole('button', { name: 'Włącz powiadomienia' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); view.unmount(); resolve('granted'); await new Promise((r) => setTimeout(r, 0));
  expect(subscribe).not.toHaveBeenCalled(); expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
});
it('błąd rejestracji nie pokazuje fałszywego włączenia i usuwa nową subskrypcję przeglądarki', async () => {
  subscribe.mockRejectedValue(new Error('network'));
  render(<PushOptIn account={ACCOUNT} api={client()} />);
  const button = screen.getByRole('button', { name: 'Włącz powiadomienia' }); await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button); await screen.findByText(/Nie udało się włączyć/); expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Włącz powiadomienia' })).toBeTruthy();
});
