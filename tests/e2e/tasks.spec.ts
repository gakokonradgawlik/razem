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
  await p.goto('/logowanie');
  await p.getByLabel('Login').fill(partner ? 'tomek@example.test' : 'anna@example.test');
  await p.getByLabel('Hasło', { exact: true }).fill(`Syntetyczne haslo ${partner ? 'Tomka' : 'Anny'} 2026`);
  await p.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(badge(p)).toContainText('Zsynchronizowano', { timeout: 20_000 });
  await p.evaluate(async () => { await navigator.serviceWorker.ready; });
  await p.reload();
  await expect.poll(() => p.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
async function sync(p: Page) {
  await p.goto('/ustawienia');
  await p.getByRole('button', { name: 'Synchronizuj teraz', exact: true }).click();
  await expect(p.getByRole('button', { name: 'Synchronizuj teraz', exact: true })).toBeEnabled();
  await expect(badge(p)).toContainText('Zsynchronizowano', { timeout: 20_000 });
}
async function create(p: Page, title: string, repeat = false, secret = false, date = '2026-01-31') {
  await p.goto('/zadania/nowe');
  await p.getByLabel('Tytuł', { exact: true }).fill(title);
  await p.getByLabel('Opis (opcjonalnie)').fill('Sprawdzić wszystkie paprocie');
  if (secret) {
    await p.locator('.privacy__option', { hasText: 'Tylko ja' }).click();
    await expect(p.getByLabel('Kto to zrobi?')).toHaveValue('me');
    await expect(p.getByLabel('Kto to zrobi?').getByRole('option', { name: 'Druga osoba' })).toBeDisabled();
    await expect(p.getByLabel('Kto to zrobi?').getByRole('option', { name: 'Oboje' })).toBeDisabled();
  }
  await p.getByLabel('Termin – dzień').fill(date);
  if (repeat) await p.getByLabel('Powtarzaj').selectOption('monthly');
  await p.getByRole('button', { name: 'Zapisz' }).click();
  await expect(p).toHaveURL(ORIGIN + '/zadania');
  await p.getByRole('link', { name: new RegExp(title) }).click();
  await expect(p.getByRole('heading', { level: 1, name: title })).toBeVisible();
  return new URL(p.url()).pathname;
}

test('zadania offline: edycja, przypisanie, ukończenie/cofnięcie, filtry, restart i konto partnera; private nie wycieka', async ({ playwright, browserName, browser }, info) => {
  const tag = `${info.project.name}-${Date.now()}`;
  const profile = await mkdtemp(join(tmpdir(), 'razem-tasks-profile-'));
  const options = { headless: true, baseURL: ORIGIN, locale: 'pl-PL', timezoneId: 'Europe/Warsaw' };
  let context = await playwright[browserName].launchPersistentContext(profile, options);
  const partner = await browser.newContext({ baseURL: ORIGIN });
  try {
    let a = await context.newPage(); const b = await partner.newPage();
    await signIn(a); await signIn(b, true);
    await context.setOffline(true);
    // Terminate the whole browser before the first write: the shell and account
    // must open with the network already cut, not just survive an offline tab.
    await context.close();
    context = await playwright[browserName].launchPersistentContext(profile, { ...options, offline: true });
    a = await context.newPage();
    const title = `Obowiązek ${tag}`, edited = `Zmieniony obowiązek ${tag}`, secret = `Prywatny obowiązek ${tag}`;
    const path = await create(a, title);
    await a.getByRole('link', { name: 'Edytuj', exact: true }).click();
    await a.getByLabel('Tytuł', { exact: true }).fill(edited);
    await a.getByLabel('Kto to zrobi?').selectOption('other');
    await a.getByLabel('Godzina (opcjonalnie)').fill('09:30');
    await a.getByRole('button', { name: 'Zapisz' }).click();
    await expect(a.getByRole('heading', { level: 1, name: edited })).toBeVisible();
    await a.getByRole('button', { name: 'Oznacz jako ukończone' }).click();
    await expect(a.getByRole('button', { name: 'Przywróć do zrobienia' })).toBeVisible();
    await a.goto('/zadania'); await a.getByRole('radio', { name: 'Ukończone', exact: true }).click();
    await a.getByRole('link', { name: new RegExp(edited) }).click();
    await a.getByRole('button', { name: 'Przywróć do zrobienia' }).click();
    await expect(a.getByRole('button', { name: 'Oznacz jako ukończone' })).toBeVisible();
    await a.goto('/zadania');
    await expect(a.getByRole('link', { name: new RegExp(edited) })).toHaveCount(0);
    await a.getByRole('radio', { name: 'Wspólne', exact: true }).click();
    await expect(a.getByRole('link', { name: new RegExp(edited) })).toBeVisible();
    await a.getByRole('radio', { name: 'Zaległe', exact: true }).click();
    await expect(a.getByRole('link', { name: new RegExp(edited) })).toBeVisible();
    const privatePath = await create(a, secret, false, true);
    await context.close();
    context = await playwright[browserName].launchPersistentContext(profile, { ...options, offline: true });
    a = await context.newPage(); await a.goto(path);
    await expect(a.getByRole('heading', { level: 1, name: edited })).toBeVisible();
    await expect(a.getByText('Sprawdzić wszystkie paprocie', { exact: true })).toBeVisible();
    await expect(a.getByRole('button', { name: 'Oznacz jako ukończone' })).toBeVisible();
    await context.setOffline(false); await sync(a); await sync(b);
    await b.goto('/zadania');
    await expect(b.getByRole('link', { name: new RegExp(edited) })).toBeVisible();
    await b.goto(path); await expect(b.getByText('Ja', { exact: true })).toBeVisible();
    await b.goto(privatePath); await expect(b.getByText('Nie znaleziono wpisu', { exact: true })).toBeVisible();
    for (const filter of ['Moje','Wspólne','Zaległe','Ukończone']) {
      await b.goto('/zadania'); await b.getByRole('radio', { name: filter, exact: true }).click();
      await expect(b.getByText(secret, { exact: true })).toHaveCount(0);
    }
    const me = await (await partner.request.get('/api/me')).json();
    const headers = { 'x-razem-account': me.user.id, 'x-razem-protocol': '2', origin: ORIGIN };
    let cursor: string | undefined;
    do {
      const body = await (await partner.request.get(`/api/sync/pull${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, { headers })).json();
      expect(JSON.stringify(body)).not.toContain(secret); expect(JSON.stringify(body)).not.toContain(privatePath.split('/').at(-1));
      cursor = body.hasMore ? body.nextCursor : undefined;
    } while (cursor);
    await b.goto(path); await b.getByRole('button', { name: 'Oznacz jako ukończone' }).click();
    await expect(b.getByRole('button', { name: 'Przywróć do zrobienia' })).toBeVisible();
    await sync(b); await sync(a); await a.goto(path);
    await expect(a.getByRole('button', { name: 'Przywróć do zrobienia' })).toBeVisible();
  } finally { await context.close(); await partner.close(); await rm(profile, { recursive: true, force: true }); }
});

test('cykliczne: dwa telefony odhaczają ten sam termin; jeden następny, Cofnij i reguła od przyszłej daty', async ({ browser }, info) => {
  const ac = await browser.newContext({ baseURL: ORIGIN }), bc = await browser.newContext({ baseURL: ORIGIN });
  try {
    const a = await ac.newPage(), b = await bc.newPage(); await signIn(a); await signIn(b, true);
    const title = `Cykliczne ${info.project.name}-${Date.now()}`;
    const path = await create(a, title, true); await sync(a); await sync(b);
    await a.goto(path); await b.goto(path); await ac.setOffline(true); await bc.setOffline(true);
    for (const p of [a,b]) {
      await p.getByRole('button', { name: 'Ukończ termin 2026-01-31', exact: true }).click();
      await expect(p.getByRole('button', { name: 'Ukończ termin 2026-02-28', exact: true })).toBeVisible();
    }
    await ac.setOffline(false); await sync(a); await bc.setOffline(false); await sync(b); await sync(a);
    for (const p of [a,b]) {
      await p.goto(path); await expect(p.getByRole('button', { name: 'Ukończ termin 2026-02-28', exact: true })).toBeVisible();
      await expect(p.getByRole('button', { name: 'Przywróć termin 2026-01-31', exact: true })).toHaveCount(1);
    }
    await a.getByRole('button', { name: 'Przywróć termin 2026-01-31', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Ukończ termin 2026-01-31', exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Ukończ termin 2026-01-31', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Cofnij', exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Cofnij', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Ukończ termin 2026-01-31', exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Ukończ termin 2026-01-31', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Ukończ termin 2026-02-28', exact: true })).toBeVisible();
    await a.getByRole('link', { name: 'Edytuj', exact: true }).click();
    await a.getByLabel('Powtarzaj').selectOption('weekly');
    await a.getByRole('button', { name: 'Zapisz' }).click();
    await expect(a.getByText('Wybierz przyszły dzień zmiany harmonogramu.', { exact: true })).toBeVisible();
    await a.getByLabel('Nowy harmonogram od').fill('2030-01-01');
    await a.getByRole('button', { name: 'Zapisz' }).click();
    await expect(a.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(a.getByRole('button', { name: 'Ukończ termin 2026-02-28', exact: true })).toBeVisible();
    await expect(a.getByRole('button', { name: 'Przywróć termin 2026-01-31', exact: true })).toBeVisible();
    await sync(a); await sync(b); await b.goto(path);
    await expect(b.getByText('Co tydzień', { exact: true })).toBeVisible();
    await expect(b.getByRole('button', { name: 'Przywróć termin 2026-01-31', exact: true })).toHaveCount(1);
    await b.goto('/zadania'); await b.getByRole('radio', { name: 'Ukończone', exact: true }).click();
    await expect(b.getByRole('link', { name: new RegExp(title) })).toBeVisible();
    const futureTitle = `Przyszły ${title}`;
    const futurePath = await create(a, futureTitle, true, false, '2030-01-31');
    await a.getByRole('link', { name: 'Edytuj', exact: true }).click();
    await a.getByLabel('Powtarzaj').selectOption('weekly');
    await a.getByRole('button', { name: 'Zapisz' }).click();
    await expect(a).toHaveURL(ORIGIN + futurePath);
    await a.getByRole('link', { name: 'Edytuj', exact: true }).click();
    await a.getByLabel('Powtarzaj').selectOption('none');
    await a.getByRole('button', { name: 'Zapisz' }).click();
    await expect(a).toHaveURL(ORIGIN + futurePath);
    await expect(a.getByText('Harmonogram zakończony', { exact: true })).toHaveCount(2);
    await sync(a); await sync(b); await b.goto('/zadania');
    await b.getByRole('radio', { name: 'Ukończone', exact: true }).click();
    await b.getByRole('link', { name: new RegExp(futureTitle) }).click();
    await expect(b).toHaveURL(ORIGIN + futurePath);
    await b.getByRole('link', { name: 'Edytuj', exact: true }).click();
    await b.getByLabel('Powtarzaj').selectOption('daily');
    await b.getByRole('button', { name: 'Zapisz' }).click();
    await expect(b.getByRole('button', { name: 'Ukończ termin 2030-01-31', exact: true })).toBeVisible();
  } finally { await ac.close(); await bc.close(); }
});
