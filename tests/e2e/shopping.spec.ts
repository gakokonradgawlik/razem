import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ORIGIN = 'http://127.0.0.1:4319';
test.use({ baseURL: ORIGIN });
test.describe.configure({ timeout: 120_000 });
const badge = (page: Page) => page.locator('.sync-badge').first();
async function signIn(page: Page, who: 'Anna' | 'Tomek' = 'Anna') {
  await page.goto('/logowanie');
  await page.getByLabel('Login').fill(who === 'Anna' ? 'anna@example.test' : 'tomek@example.test');
  await page.getByLabel('Hasło', { exact: true }).fill(`Syntetyczne haslo ${who === 'Anna' ? 'Anny' : 'Tomka'} 2026`);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(badge(page)).toContainText('Zsynchronizowano', { timeout: 20_000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
async function sync(page: Page, conflict = false) {
  await page.goto('/ustawienia');
  await page.getByRole('button', { name: 'Synchronizuj teraz', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Synchronizuj teraz', exact: true })).toBeEnabled();
  await expect(badge(page)).toContainText(conflict ? 'wymaga sprawdzenia' : 'Zsynchronizowano', { timeout: 20_000 });
}
async function list(page: Page, name: string, visibility = 'Wspólne') {
  await page.goto('/zakupy/nowa');
  await page.getByLabel('Nazwa listy').fill(name);
  await expect(page.getByRole('radio', { name: /Wspólne/ })).toBeChecked();
  await page.locator('.privacy__option', { hasText: visibility }).click();
  await page.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/zakupy`);
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  return new URL(page.url()).pathname;
}
async function quick(page: Page, name: string) {
  await page.getByLabel('Nazwa produktu').fill(name);
  await page.getByLabel('Nazwa produktu').press('Enter');
  await expect(page.getByLabel('Nazwa produktu')).toHaveValue('');
  await expect(page.getByRole('list', { name: 'Do kupienia' }).getByText(name, { exact: true })).toBeVisible();
}
async function edit(page: Page, name: string, quantity: string) {
  await page.getByRole('link', { name: new RegExp(`^${name}`) }).click();
  await page.getByLabel('Ilość (opcjonalnie)').fill(quantity);
  await page.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page.getByRole('heading', { name: 'Edytuj pozycję' })).toHaveCount(0);
}
async function queueIds(page: Page) {
  return page.evaluate(async () => {
    const account = JSON.parse(localStorage.getItem('razem:account')!);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(`razem:${account.householdId}:${account.userId}`);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const rows = await new Promise<{ clientMutationId: string }[]>((resolve, reject) => {
      const request = db.transaction('queue').objectStore('queue').getAll();
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); return rows.map((r) => r.clientMutationId);
  });
}

test('zakupy offline → restart procesu → sync → partner; kosz, polskie ilości i negatywna prywatność', async ({ playwright, browserName, browser }, info) => {
  const tag = `${info.project.name}-${Date.now()}`;
  const profile = await mkdtemp(join(tmpdir(), 'razem-shopping-profile-'));
  const options = { headless: true, baseURL: ORIGIN, locale: 'pl-PL', timezoneId: 'Europe/Warsaw' };
  let context = await playwright[browserName].launchPersistentContext(profile, options);
  const partner = await browser.newContext({ baseURL: ORIGIN });
  try {
    let a = await context.newPage(); const b = await partner.newPage();
    await signIn(a); await signIn(b, 'Tomek');
    await context.setOffline(true);
    // Terminate the whole browser before the first write: the shell and account
    // must open with the network already cut, not just survive an offline tab.
    await context.close();
    context = await playwright[browserName].launchPersistentContext(profile, { ...options, offline: true });
    a = await context.newPage();
    const shared = await list(a, `Sobotnie zakupy ${tag}`);
    await a.getByRole('link', { name: 'Dodaj pozycję', exact: true }).click();
    await a.getByLabel('Nazwa', { exact: true }).fill('Żółty ser');
    await a.getByLabel('Ilość (opcjonalnie)').fill('2 opakowania');
    await a.getByLabel('Uwaga (opcjonalnie)').fill('świeży, bez ziół');
    await a.getByRole('button', { name: 'Zapisz' }).click();
    await quick(a, 'Świeże bułki');
    await edit(a, 'Żółty ser', '3 opakowania');
    // The controlled value changes only after the IndexedDB transaction commits.
    await a.getByRole('checkbox', { name: 'Kupione: Żółty ser', exact: true }).click();
    await expect(a.getByRole('list', { name: 'Kupione' }).getByText('Żółty ser', { exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Cofnij' }).click();
    await expect(a.getByRole('list', { name: 'Do kupienia' }).getByRole('link')).toHaveText(['Żółty ser3 opakowania · świeży, bez ziół', 'Świeże bułki']);
    await a.getByRole('checkbox', { name: 'Kupione: Świeże bułki', exact: true }).click();
    await expect(a.getByRole('list', { name: 'Kupione' })).toContainText('Świeże bułki');
    await a.getByRole('link', { name: /^Żółty ser/ }).click();
    await a.getByRole('button', { name: 'Usuń pozycję' }).click();
    await a.getByRole('group', { name: /Potwierdź usunięcie/ }).getByRole('button', { name: 'Usuń', exact: true }).click();
    await expect(a).toHaveURL(ORIGIN + shared);
    await a.goto('/kosz');
    const row = a.getByRole('listitem').filter({ has: a.getByText('Żółty ser', { exact: true }) });
    await row.getByRole('button', { name: 'Przywróć' }).click();
    await expect(row).toHaveCount(0);
    await a.goto(shared);
    await a.getByRole('link', { name: 'Zmień nazwę listy' }).click();
    await a.getByLabel('Nazwa listy').fill(`Targ i sklep ${tag}`);
    await expect(a.getByRole('radio')).toHaveCount(0);
    await a.getByRole('button', { name: 'Zapisz' }).click();
    await expect(a.getByRole('heading', { level: 1, name: `Targ i sklep ${tag}` })).toBeVisible();
    const privatePath = await list(a, `Prywatne zakupy ${tag}`, 'Tylko ja');
    const secret = `Prywatny produkt ${tag}`;
    await quick(a, secret);
    await a.getByRole('link', { name: secret, exact: true }).click();
    const privateItem = new URL(a.url()).pathname;
    const before = await queueIds(a); expect(before.length).toBeGreaterThan(5);
    await context.close();
    context = await playwright[browserName].launchPersistentContext(profile, { ...options, offline: true });
    a = await context.newPage(); await a.goto(shared);
    await expect(a.getByRole('heading', { level: 1, name: `Targ i sklep ${tag}` })).toBeVisible();
    await expect(a.getByRole('list', { name: 'Do kupienia' })).toContainText('3 opakowania · świeży, bez ziół');
    await expect(a.getByRole('list', { name: 'Kupione' })).toContainText('Świeże bułki');
    expect(await queueIds(a)).toEqual(before);
    await a.goto(privatePath); await expect(a.getByRole('list', { name: 'Do kupienia' })).toContainText(secret);
    await context.setOffline(false); await sync(a); await sync(b);
    expect(await queueIds(a)).toEqual([]);
    await b.goto(shared);
    await expect(b.getByRole('heading', { level: 1, name: `Targ i sklep ${tag}` })).toBeVisible();
    await expect(b.getByRole('list', { name: 'Do kupienia' })).toContainText('3 opakowania · świeży, bez ziół');
    await expect(b.getByRole('list', { name: 'Kupione' })).toContainText('Świeże bułki');
    await b.goto('/zakupy'); await expect(b.getByRole('link', { name: new RegExp(`Prywatne zakupy ${tag}`) })).toHaveCount(0);
    for (const path of [privatePath, privateItem, `${shared}/pozycje/${privateItem.split('/').at(-1)}`]) {
      await b.goto(path); await expect(b.getByText('Nie znaleziono wpisu', { exact: true })).toBeVisible();
      await expect(b.getByText(secret, { exact: true })).toHaveCount(0);
    }
    const me = await (await partner.request.get('/api/me')).json();
    const headers = { origin: ORIGIN, 'x-razem-protocol': '2', 'x-razem-account': me.user.id };
    let cursor: string | undefined;
    do {
      const response = await partner.request.get(`/api/sync/pull${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { headers });
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain(secret); expect(JSON.stringify(body)).not.toContain(privatePath.split('/').at(-1));
      cursor = body.hasMore ? body.nextCursor : undefined;
    } while (cursor);
    for (const command of ['update', 'delete', 'restore']) {
      const response = await partner.request.post('/api/sync/push', { headers, data: {
        protocolVersion: 2, deviceId: crypto.randomUUID(), mutations: [{ clientMutationId: crypto.randomUUID(), entityType: 'shopping_item',
          entityId: privateItem.split('/').at(-1), command, baseVersion: 1, ...(command === 'update' ? { patch: { checked: true } } : {}) }],
      } });
      expect(response.ok()).toBe(true);
      const result = (await response.json()).results[0];
      expect(result).toMatchObject({ status: 'error', code: 'not_found' }); expect(result).not.toHaveProperty('state');
    }
    await b.goto('/kosz'); await expect(b.getByText(secret, { exact: true })).toHaveCount(0);
  } finally { await context.close(); await partner.close(); await rm(profile, { recursive: true, force: true }); }
});

test('zakupy: edycje różnych pozycji łączą się; sprzeczna ilość ma obie wersje i działające rozwiązanie', async ({ browser }, info) => {
  const aContext = await browser.newContext({ baseURL: ORIGIN }), bContext = await browser.newContext({ baseURL: ORIGIN });
  try {
    const a = await aContext.newPage(), b = await bContext.newPage(); await signIn(a); await signIn(b, 'Tomek');
    const path = await list(a, `Konflikt zakupów ${info.project.name}-${Date.now()}`);
    await quick(a, 'Mleko'); await quick(a, 'Chleb'); await sync(a); await sync(b);
    await a.goto(path); await b.goto(path);
    await aContext.setOffline(true); await bContext.setOffline(true);
    await edit(a, 'Mleko', '2 opakowania'); await edit(b, 'Chleb', '3 sztuki');
    await aContext.setOffline(false); await sync(a); await bContext.setOffline(false); await sync(b); await sync(a);
    for (const page of [a, b]) {
      await page.goto(path);
      await expect(page.getByRole('list', { name: 'Do kupienia' })).toContainText('2 opakowania');
      await expect(page.getByRole('list', { name: 'Do kupienia' })).toContainText('3 sztuki');
    }
    await aContext.setOffline(true); await bContext.setOffline(true);
    await edit(a, 'Mleko', '4 opakowania'); await edit(b, 'Mleko', '5 opakowań');
    await aContext.setOffline(false); await sync(a); await bContext.setOffline(false); await sync(b, true);
    await b.goto('/zmiany'); await b.getByRole('link', { name: /^Mleko/ }).click();
    await expect(b.getByText('4 opakowania', { exact: true })).toBeVisible();
    await expect(b.getByText('5 opakowań', { exact: true })).toBeVisible();
    await b.getByRole('button', { name: 'Zachowaj moją wersję' }).click();
    await expect(b.getByText('Wszystko w porządku', { exact: true })).toBeVisible();
    await sync(b); await sync(a); await a.goto(path);
    await expect(a.getByRole('list', { name: 'Do kupienia' })).toContainText('5 opakowań');
    await expect(a.getByRole('list', { name: 'Do kupienia' }).getByRole('link')).toHaveCount(2);
  } finally { await aContext.close(); await bContext.close(); }
});
