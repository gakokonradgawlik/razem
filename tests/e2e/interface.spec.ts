import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { routes } from '../../apps/web/src/App.js';

// Screens of the RAZ-3 skeleton. Built app served by the real Fastify server.
// Every route pattern of App.tsx; parameters filled with a syntactically valid id
// (production build has no record store yet → "Nie można wyświetlić wpisu").
const SAMPLE = '0b6f5a62-3c1d-4e8f-9a7b-1c2d3e4f5a6b';
const screens = routes.map((route) => route.path.replace(/:\w+/g, SAMPLE));
const widths = [375, 390, 430, 1280];
// Optional visual evidence: RAZEM_SCREENSHOTS=/some/tmp/dir (not committed).
const shots = process.env.RAZEM_SCREENSHOTS;

async function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) problems.push(`poziomy scroll ${root.scrollWidth}>${root.clientWidth}`);
    const controls = document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea');
    for (const control of controls) {
      const style = getComputedStyle(control);
      if (control.closest('.skip-link') || style.visibility === 'hidden' || style.display === 'none') continue;
      const target = control.closest('label') ?? control;
      const box = target.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.width < 44 - 0.5 || box.height < 44 - 0.5) problems.push(`cel <44px: ${control.outerHTML.slice(0, 80)} ${box.width}x${box.height}`);
      if (box.right > root.clientWidth + 0.5 || box.left < -0.5) problems.push(`poza ekranem: ${control.outerHTML.slice(0, 80)}`);
      const labels = (control as HTMLInputElement).labels;
      const name = control.getAttribute('aria-label') || control.getAttribute('aria-labelledby') || (labels && labels.length ? labels[0]!.textContent : '') || control.textContent;
      if (!name?.trim()) problems.push(`brak nazwy: ${control.outerHTML.slice(0, 80)}`);
    }
    for (const input of document.querySelectorAll<HTMLElement>('input:not([type=radio]):not([type=checkbox]), textarea, select')) {
      if (parseFloat(getComputedStyle(input).fontSize) < 16) problems.push(`pole <16px: ${input.outerHTML.slice(0, 60)}`);
    }
    return problems;
  });
}

for (const width of widths) {
  test(`${width}px: wszystkie ekrany bez poziomego scrolla, cele ≥44 px, nazwy kontrolek`, async ({ page }, info) => {
    // ~35 routes per width; WebKit is slow under parallel load.
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: width > 900 ? 860 : 844 });
    for (const path of screens) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await layoutProblems(page), `${path} @${width}`).toEqual([]);
      if (path === '/zadania/nowe' || path === '/kalendarz/nowe') {
        // Open the month grid / validation state too.
        await page.getByRole('button', { name: 'Zapisz' }).click();
        await expect(page.getByRole('alert').first()).toBeVisible();
        expect(await layoutProblems(page), `${path} błędy @${width}`).toEqual([]);
      }
      if (shots && ['/', '/zadania/nowe', '/notatki/nowa', '/ustawienia', '/logowanie'].includes(path)) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, `${info.project.name}-${width}${path.replaceAll('/', '_') || '_'}.png`), fullPage: true });
      }
    }
    await page.goto('/kalendarz');
    await page.getByRole('radio', { name: 'Miesiąc' }).check();
    await expect(page.getByRole('table')).toBeVisible();
    expect(await layoutProblems(page), `miesiąc @${width}`).toEqual([]);
  });
}

test('nawigacja: pasek na dole na telefonie, boczny na desktopie, te same pozycje', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Główna nawigacja' });
  const phone = (await nav.boundingBox())!;
  expect(phone.y + phone.height).toBeCloseTo(844, 0);
  for (const label of ['Zakupy', 'Zadania', 'Kalendarz', 'Więcej', 'Dzisiaj']) {
    await nav.getByRole('link', { name: label }).click();
    await expect(page.getByRole('heading', { level: 1, name: label })).toBeVisible();
  }
  await page.setViewportSize({ width: 1280, height: 860 });
  const desktop = (await nav.boundingBox())!;
  expect(desktop.x).toBe(0);
  expect(desktop.height).toBeGreaterThan(800);
  expect(await nav.getByRole('link').count()).toBe(5);
  // Content width is limited on wide screens.
  expect((await page.locator('main').boundingBox())!.width).toBeLessThanOrEqual(760);
});

test('ciemny motyw, ograniczony ruch i duży tekst nie psują obsługi', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.goto('/');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(0, 0, 0)');
  await page.getByRole('button', { name: 'Dodaj' }).click();
  const menu = page.getByRole('list', { name: 'Dodaj' });
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Large text (≈ largest accessibility Dynamic Type): 200 % root size.
  for (const path of screens) {
    await page.goto(path);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await layoutProblems(page), `${path} duży tekst`).toEqual([]);
  }
  await page.goto('/ustawienia');
  await page.getByRole('radio', { name: 'Jasny' }).check();
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(242, 242, 247)');
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
});

test('formularz: prywatność przed zapisem, walidacja przy polu i zachowanie treści po błędzie zapisu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/notatki/nowa');
  await expect(page.getByText('Zapiszesz jako: Tylko ja')).toBeVisible();
  await page.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page.getByLabel('Tytuł')).toBeFocused();
  await expect(page.getByLabel('Tytuł')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Tytuł').fill('Lista prezentów');
  await page.getByLabel('Treść').fill('Dla Mamy: szal');
  await page.getByRole('radio', { name: /Wspólne/ }).check();
  await expect(page.getByText('Zapiszesz jako: Wspólne')).toBeVisible();
  await page.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page.getByRole('alert')).toContainText('Nie zapisano');
  await expect(page.getByLabel('Tytuł')).toHaveValue('Lista prezentów');
  await expect(page.getByLabel('Treść')).toHaveValue('Dla Mamy: szal');
  expect(new URL(page.url()).pathname).toBe('/notatki/nowa');
  // Nothing was written locally: no IndexedDB database exists for an anonymous user.
  expect(await page.evaluate(async () => (await indexedDB.databases()).length)).toBe(0);
});

test('safe-area: pasek i formularz respektują wcięcia ekranu', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Nadpisanie safe-area jest dostępne tylko przez CDP Chromium');
  await page.setViewportSize({ width: 390, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets: { top: 47, bottom: 34, left: 0, right: 0 } } as never); }
  catch { test.skip(true, 'Ta wersja Chromium nie obsługuje Emulation.setSafeAreaInsetsOverride'); }
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Główna nawigacja' });
  expect(await nav.evaluate((element) => getComputedStyle(element).paddingBottom)).toBe('34px');
  expect(await page.locator('main').evaluate((element) => parseFloat(getComputedStyle(element).paddingTop))).toBeGreaterThanOrEqual(47);
  await page.goto('/zadania/nowe');
  const bar = page.locator('.form-bar');
  expect(await bar.evaluate((element) => getComputedStyle(element).paddingTop)).toBe('47px');
  expect((await bar.boundingBox())!.y).toBe(0);
});

test('klawiatura ekranowa: pasek zakładek znika podczas edycji, treść dostaje odstęp', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/zadania/nowe');
  await page.getByLabel('Tytuł').focus();
  // Simulate the iOS keyboard via the CSS hook the visual-viewport listener drives.
  await page.evaluate(() => { document.documentElement.dataset.keyboard = 'open'; document.documentElement.style.setProperty('--keyboard-inset', '336px'); });
  await expect(page.getByRole('navigation', { name: 'Główna nawigacja' })).toBeHidden();
  expect(await page.locator('main').evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom))).toBeGreaterThan(336);
});
