import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ORIGIN = 'http://127.0.0.1:4319';
test.use({ baseURL: ORIGIN });
test.describe.configure({ timeout: 120_000 });
const badge = (p: Page) => p.locator('.sync-badge').first();
async function signIn(p: Page, partner = false) {
  await p.goto('/logowanie'); await p.getByLabel('Login').fill(partner ? 'tomek@example.test' : 'anna@example.test');
  await p.getByLabel('Hasło', { exact: true }).fill(`Syntetyczne haslo ${partner ? 'Tomka' : 'Anny'} 2026`);
  await p.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(badge(p)).toContainText('Zsynchronizowano', { timeout: 20_000 });
  await p.evaluate(async () => { await navigator.serviceWorker.ready; }); await p.reload();
  await expect.poll(() => p.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
async function sync(p: Page) {
  await p.goto('/ustawienia'); await p.getByRole('button', { name: 'Synchronizuj teraz', exact: true }).click();
  await expect(p.getByRole('button', { name: 'Synchronizuj teraz', exact: true })).toBeEnabled();
  await expect(badge(p)).toContainText('Zsynchronizowano', { timeout: 20_000 });
}
async function calendar(p: Page) { await p.goto('/kalendarz'); await p.getByLabel('Agenda od dnia').fill('2026-12-01'); }
async function event(p: Page, name: string, allDay: boolean, secret = false) {
  await p.goto('/kalendarz/nowe'); await p.getByLabel('Nazwa', { exact: true }).fill(name);
  if (allDay) await p.getByRole('switch', { name: 'Cały dzień', exact: true }).click();
  await p.getByLabel('Początek – dzień').fill('2026-12-30'); await p.getByLabel('Koniec – dzień').fill('2027-01-02');
  if (!allDay) { const times = p.getByLabel('Godzina', { exact: true }); await times.nth(0).fill('18:30'); await times.nth(1).fill('19:30'); }
  await p.getByLabel('Strefa czasowa').fill('Pacific/Kiritimati');
  await p.getByRole('switch', { name: 'Przypomnienie', exact: true }).click();
  if (secret) await p.locator('.privacy__option', { hasText: 'Tylko ja' }).click();
  await p.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(p).toHaveURL(ORIGIN + '/kalendarz'); await calendar(p);
  await p.getByRole('link', { name: new RegExp(name) }).click();
  await expect(p.getByRole('heading', { level: 1, name })).toBeVisible(); return new URL(p.url()).pathname;
}
async function annual(p: Page, name: string, secret = false) {
  await p.goto('/wazne-daty/nowa'); await p.getByLabel('Nazwa', { exact: true }).fill(name);
  await p.getByLabel('Rodzaj').selectOption('anniversary'); await p.getByLabel('Miesiąc').selectOption('12'); await p.getByLabel('Dzień', { exact: true }).selectOption('31');
  await expect(p.getByLabel('Rok początkowy (opcjonalnie)')).toHaveValue('');
  await p.getByRole('switch', { name: 'Przypomnienie', exact: true }).click();
  if (secret) await p.locator('.privacy__option', { hasText: 'Tylko ja' }).click();
  await p.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(p).toHaveURL(ORIGIN + '/wazne-daty'); await p.getByRole('link', { name: new RegExp(name) }).click();
  return new URL(p.url()).pathname;
}
async function month(p: Page, title: string) {
  await p.getByRole('radio', { name: 'Miesiąc', exact: true }).click();
  // Initial month is November 2026 in the task environment; determine steps from browser's real date.
  const delta = await p.evaluate(() => { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit' }).formatToParts(new Date()); return (2026 - Number(parts.find((x) => x.type === 'year')!.value)) * 12 + 12 - Number(parts.find((x) => x.type === 'month')!.value); });
  for (let n = 0; n < Math.abs(delta); n++) await p.getByRole('button', { name: delta > 0 ? 'Następny miesiąc' : 'Poprzedni miesiąc' }).click();
  await expect(p.getByRole('table', { name: 'Grudzień 2026' })).toBeVisible();
  await expect(p.getByRole('list', { name: 'Wpisy miesiąca' }).getByRole('link', { name: new RegExp(title) })).toBeVisible();
  const sizes = await p.locator('.month__day').evaluateAll((nodes) => nodes.map((n) => ({ w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height })));
  expect(sizes.every((size) => size.w >= 44 && size.h >= 44)).toBe(true);
  expect(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

async function storedCalendar(p: Page) {
  return p.evaluate(async () => {
    const account = JSON.parse(localStorage.getItem('razem:account')!);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`razem:${account.householdId}:${account.userId}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const records = await new Promise<{ id: string; data: Record<string, unknown> }[]>((resolve, reject) => {
      const request = db.transaction('records').objectStore('records').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); return records;
  });
}

test('kalendarz offline → restart procesu → sync partnera: rodzaje, rok, strefy, oba widoki, prywatność i usuwanie', async ({ playwright, browserName, browser }, info) => {
  const tag = `${info.project.name}-${Date.now()}`, profile = await mkdtemp(join(tmpdir(), 'razem-calendar-profile-'));
  const options = { headless: true, baseURL: ORIGIN, viewport: { width: 390, height: 844 }, locale: 'pl-PL', timezoneId: 'America/Los_Angeles', ...(browserName === 'webkit' ? { isMobile: true, hasTouch: true } : {}) };
  let context = await playwright[browserName].launchPersistentContext(profile, options);
  const other = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 390, height: 844 } });
  try {
    let a = await context.newPage(); const b = await other.newPage(); await signIn(a); await signIn(b, true); await context.setOffline(true);
    const name = `Wyjazd ${tag}`, timed = `Godzinowe ${tag}`, date = `Rocznica ${tag}`, secret = `Sekret ${tag}`;
    const path = await event(a, name, true); const timedPath = await event(a, timed, false);
    const datePath = await annual(a, date); const privatePath = await event(a, secret, true, true); const privateDatePath = await annual(a, `Tajna data ${tag}`, true);
    await a.goto(path); await a.getByRole('link', { name: 'Edytuj', exact: true }).click();
    await expect(a.getByLabel('Koniec – dzień')).toHaveValue('2027-01-02'); await a.getByLabel('Opis (opcjonalnie)').fill('Zmienione offline');
    await a.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(a).toHaveURL(ORIGIN + path);
    await expect(a.getByText('Zmienione offline', { exact: true })).toBeVisible();
    expect((await storedCalendar(a)).find((r) => r.id === path.split('/').at(-1))?.data.description).toBe('Zmienione offline');
    await a.goto(datePath); await a.getByRole('link', { name: 'Edytuj', exact: true }).click();
    await a.getByLabel('Rok początkowy (opcjonalnie)').fill('2016'); await a.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(a).toHaveURL(ORIGIN + datePath);
    await expect(a.getByText(/2026-12-31 · 10 lat/)).toBeVisible();
    await calendar(a); await month(a, name);
    const day = a.getByRole('button', { name: /, 31 grudnia 2026, wpisy:/ }); await day.click();
    await expect(a.getByRole('list', { name: 'Wpisy wybranego dnia' }).getByRole('link', { name: new RegExp(date) })).toBeVisible();
    const beforeRestart = await storedCalendar(a);
    expect(beforeRestart.find((r) => r.id === path.split('/').at(-1))?.data.description).toBe('Zmienione offline');
    await context.close(); context = await playwright[browserName].launchPersistentContext(profile, { ...options, offline: true }); a = await context.newPage();
    await a.goto(path); await expect(a.getByRole('heading', { level: 1, name })).toBeVisible(); await expect(a.getByText('Zmienione offline', { exact: true })).toBeVisible();
    await expect(a.getByText(/Przypomnienie zapisane/)).toBeVisible();
    await context.setOffline(false); await sync(a); await sync(b);
    await calendar(b); for (const title of [name, timed, date]) await expect(b.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    await expect(b.getByRole('link', { name: new RegExp(secret) })).toHaveCount(0); await month(b, date);
    await expect(b.getByText(secret, { exact: true })).toHaveCount(0);
    for (const hidden of [privatePath, privateDatePath]) { await b.goto(hidden); await expect(b.getByText('Nie znaleziono wpisu', { exact: true })).toBeVisible(); }
    const me = await (await other.request.get('/api/me')).json(); let cursor: string | undefined;
    do { const response = await (await other.request.get(`/api/sync/pull${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { 'x-razem-account': me.user.id, 'x-razem-protocol': '2' } })).json();
      expect(JSON.stringify(response)).not.toContain(secret); for (const hidden of [privatePath, privateDatePath]) expect(JSON.stringify(response)).not.toContain(hidden.split('/').at(-1));
      cursor = response.hasMore ? response.nextCursor : undefined;
    } while (cursor);
    await context.setOffline(true);
    for (const link of [path, timedPath, datePath]) { await a.goto(link); await a.getByRole('button', { name: /Usuń (wydarzenie|ważną datę)/ }).click(); await a.getByRole('button', { name: 'Usuń', exact: true }).click(); await expect(a).not.toHaveURL(ORIGIN + link); }
    await context.setOffline(false); await sync(a); await sync(b); await calendar(b);
    for (const title of [name, timed, date]) await expect(b.getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
  } finally { await context.close(); await other.close(); await rm(profile, { recursive: true, force: true }); }
});
