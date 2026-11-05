import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createECDH, randomUUID } from 'node:crypto';

// Feature harness only. Neither Playwright WebKit nor these browser API doubles prove iPhone delivery.
async function browserPush(page: Page, ios = false) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  await page.addInitScript(({ p256dh, ios }) => {
    if (ios) { Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }); }
    let prompts = 0;
    Object.defineProperty(window, '__pushPrompts', { get: () => prompts });
    Object.defineProperty(window, 'Notification', { configurable: true, value: {
      get permission() { return localStorage.getItem('test:permission') ?? 'default'; },
      requestPermission: async () => { prompts++; localStorage.setItem('test:permission', 'granted'); return 'granted'; },
    } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
    const subscription = () => ({ endpoint: `https://web.push.apple.com/${localStorage.getItem('test:endpoint')}`,
      expirationTime: null, unsubscribe: async () => { localStorage.removeItem('test:endpoint'); return true; },
      toJSON: () => ({ keys: { p256dh, auth: 'A'.repeat(22) } }),
    });
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { configurable: true, get: () => ({
      getSubscription: async () => localStorage.getItem('test:endpoint') ? subscription() : null,
      subscribe: async () => { localStorage.setItem('test:endpoint', crypto.randomUUID()); return subscription(); },
    }) });
  }, { p256dh: ecdh.getPublicKey().toString('base64url'), ios });
}
async function login(page: Page, origin: string, partner = false) {
  await page.goto(origin + '/logowanie'); await page.getByLabel('Login').fill(partner ? 'tomek@example.test' : 'anna@example.test');
  await page.getByLabel('Hasło', { exact: true }).fill(`Syntetyczne haslo ${partner ? 'Tomka' : 'Anny'} 2026`);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await expect(page.locator('.sync-badge').first()).toContainText('Zsynchronizowano');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
}
async function api(page: Page, path: string, body?: object) {
  return page.evaluate(async ({ path, body }) => {
    const me = await (await fetch('/api/me')).json();
    const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-razem-account': me.user.id, 'x-razem-notifications': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }, { path, body });
}

test('świadomy opt-in, preferencje, ACL linku i logout urządzenia (API przeglądarki symulowane)', async ({ page, browser, browserName }) => {
  const origin = `http://127.0.0.1:${browserName === 'webkit' ? 4325 : 4324}`;
  const other = await browser.newContext(); const b = await other.newPage();
  try {
    await browserPush(page, browserName === 'webkit'); await login(page, origin); await login(b, origin, true);
    await page.goto(origin + '/ustawienia/powiadomienia');
    const enable = page.getByRole('button', { name: 'Włącz powiadomienia', exact: true });
    await expect(enable).toBeEnabled(); expect(await page.evaluate(() => (window as unknown as { __pushPrompts: number }).__pushPrompts)).toBe(0);
    await enable.click(); await expect(page.getByRole('button', { name: 'Wyłącz powiadomienia na tym urządzeniu' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __pushPrompts: number }).__pushPrompts)).toBe(1);
    await page.screenshot({ path: test.info().outputPath('push-settings.png'), fullPage: true });
    const device = await page.evaluate(() => localStorage.getItem('razem:push-device'));
    expect((await api(page, `/api/push/devices/${device}`)).body).toEqual({ enabled: true });
    await page.getByLabel('Godzina przypomnienia zadania bez godziny', { exact: true }).fill('10:15');
    await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
    expect((await api(page, '/api/settings')).body.notifications.taskReminderTime).toBe('10:15');
    const id = randomUUID(), title = `Private ${randomUUID()}`;
    const response = await api(page, '/api/sync/push', { protocolVersion: 2, deviceId: randomUUID(), mutations: [{ command: 'create', entityType: 'task', entityId: id, clientMutationId: randomUUID(), baseVersion: 0, visibility: 'private', data: { title, description: '', assignee: 'self', dueDate: null, dueAt: null, timezone: 'Europe/Warsaw', completedAt: null, recurrence: null } }] });
    expect(response.body.results[0].status).toBe('ack');
    await page.goto(origin + `/powiadomienie/task/${id}`); await expect(page).toHaveURL(origin + `/zadania/${id}`);
    await b.goto(origin + `/powiadomienie/task/${id}`); await expect(b.getByText(/Wpis jest niedostępny/)).toBeVisible(); await expect(b.getByText(title)).toHaveCount(0);
    await page.goto(origin + '/ustawienia'); await page.getByRole('button', { name: 'Wyloguj', exact: true }).click(); await expect(page).toHaveURL(origin + '/logowanie');
    await page.goto(origin + `/powiadomienie/task/${id}`); await expect(page.getByText(/Zaloguj się i połącz/)).toBeVisible();
    await page.getByRole('link', { name: 'Zaloguj się', exact: true }).click();
    await page.getByLabel('Login').fill('anna@example.test'); await page.getByLabel('Hasło', { exact: true }).fill('Syntetyczne haslo Anny 2026');
    await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click(); await expect(page).toHaveURL(origin + `/zadania/${id}`);
    expect((await api(page, `/api/push/devices/${device}`)).body).toEqual({ enabled: false });
    await page.goto(origin + '/ustawienia/powiadomienia'); await expect(page.getByRole('button', { name: 'Włącz powiadomienia', exact: true })).toBeEnabled();
  } finally { await other.close(); }
});
