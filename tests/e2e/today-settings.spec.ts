import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test.use({ actionTimeout: 15_000 });
const badge = (page: Page) => page.locator('.sync-badge').first();
async function login(page: Page, origin: string, partner = false) {
  await page.goto(`${origin}/logowanie`);
  await page.getByLabel('Login').fill(partner ? 'tomek@example.test' : 'anna@example.test');
  await page.getByLabel('Hasło', { exact: true }).fill(`Syntetyczne haslo ${partner ? 'Tomka' : 'Anny'} 2026`);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await expect(badge(page)).toContainText('Zsynchronizowano');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
async function quick(page: Page, origin: string, label: string) {
  await page.goto(origin + '/'); await page.getByRole('button', { name: 'Dodaj', exact: true }).click();
  await page.getByRole('list', { name: 'Dodaj', exact: true }).getByRole('link', { name: label, exact: true }).click();
}
async function save(page: Page, path: string) {
  await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(path.replaceAll('/', '\\/') + '$'));
}
async function sync(page: Page, origin: string) {
  await page.goto(origin + '/ustawienia'); await page.getByRole('button', { name: 'Synchronizuj teraz', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Synchronizuj teraz', exact: true })).toBeEnabled();
  await expect(badge(page)).toContainText('Zsynchronizowano');
}
async function layout(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth) problems.push('poziomy scroll');
    for (const element of document.querySelectorAll<HTMLElement>('a,button,input,select,textarea')) {
      if (element.classList.contains('skip-link')) continue;
      const target = element.closest('label') ?? element, box = target.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (box.width < 43.5 || box.height < 43.5) problems.push(`mały cel ${element.outerHTML.slice(0, 60)}`);
      if (box.left < -0.5 || box.right > innerWidth + 0.5) problems.push(`poza ekranem ${element.outerHTML.slice(0, 60)}`);
    }
    return problems;
  });
}

test('Dzisiaj + ustawienia: menu, prywatność, zimny start offline, motyw/strefa, logout, kosz i przegląd wizualny', async ({ playwright, browserName, browser }, info) => {
  test.setTimeout(180_000);
  const origin = `http://127.0.0.1:${browserName === 'webkit' ? 4323 : 4322}`;
  const profile = await mkdtemp(join(tmpdir(), 'razem-today-profile-'));
  const options = { headless: true, viewport: { width: 390, height: 844 }, locale: 'pl-PL', timezoneId: 'Asia/Tokyo', ...(browserName === 'webkit' ? { isMobile: true, hasTouch: true } : {}) };
  let context = await playwright[browserName].launchPersistentContext(profile, options);
  const other = await browser.newContext();
  const tag = `${info.project.name}-${Date.now()}`;
  try {
    let a = await context.newPage(); const b = await other.newPage(); await login(a, origin); await login(b, origin, true);
    await a.goto(origin + '/ustawienia'); await a.getByRole('radio', { name: 'Ciemny', exact: true }).check();
    await a.getByRole('link', { name: /Profil i domownicy/ }).click();
    await a.getByLabel('Twoja nazwa').fill(`Anna ${tag}`); await a.getByLabel('Strefa czasowa domu').fill('America/Los_Angeles'); await save(a, '/ustawienia');
    await a.getByRole('link', { name: /Preferencje powiadomień/ }).click();
    await expect(a.getByRole('button', { name: /Włącz powiadomienia/ })).toBeDisabled();
    await a.getByRole('switch', { name: /^Tytuły na ekranie blokady/ }).check(); await save(a, '/ustawienia');
    const day = await a.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
    await context.setOffline(true);
    for (const secret of [false, true]) {
      await quick(a, origin, 'Zadanie'); await a.getByLabel('Tytuł', { exact: true }).fill(`${secret ? 'Sekret' : 'Paczka'} ${tag}`);
      await a.getByLabel('Termin – dzień').fill(day); if (secret) await a.locator('.privacy__option', { hasText: 'Tylko ja' }).click(); await save(a, '/zadania');
    }
    await quick(a, origin, 'Wydarzenie'); await a.getByLabel('Nazwa', { exact: true }).fill(`Wizyta ${tag}`);
    await a.getByRole('switch', { name: 'Cały dzień', exact: true }).check();
    await a.getByLabel('Początek – dzień').fill(day); await a.getByLabel('Koniec – dzień').fill(day); await save(a, '/kalendarz');
    await quick(a, origin, 'Ważna data'); await a.getByLabel('Nazwa', { exact: true }).fill(`Rocznica ${tag}`);
    await a.getByLabel('Miesiąc').selectOption(String(Number(day.slice(5, 7)))); await a.getByLabel('Dzień', { exact: true }).selectOption(String(Number(day.slice(8)))); await save(a, '/wazne-daty');
    await quick(a, origin, 'Lista zakupów'); await a.getByLabel('Nazwa listy').fill(`Zakupy ${tag}`); await save(a, '/zakupy');
    await a.getByRole('link', { name: new RegExp(`Zakupy ${tag}`) }).click(); await a.getByLabel('Nazwa produktu').fill('Mleko'); await a.getByRole('button', { name: 'Dodaj', exact: true }).click();
    await expect(a.getByRole('link', { name: 'Mleko', exact: true })).toBeVisible();
    await quick(a, origin, 'Notatka'); await a.getByLabel('Tytuł', { exact: true }).fill(`Prywatna notatka ${tag}`); await a.getByLabel('Treść').fill('Syntetyczna treść tylko konta A'); await save(a, '/notatki');
    await a.goto(origin + '/');
    for (const title of [`Paczka ${tag}`, `Sekret ${tag}`, `Wizyta ${tag}`, `Rocznica ${tag}`, `Zakupy ${tag}`]) await expect(a.getByText(title, { exact: true })).toBeVisible();
    await expect(a.getByText('Do kupienia: 1', { exact: true })).toBeVisible();
    await a.getByRole('checkbox', { name: `Ukończ: Paczka ${tag}`, exact: true }).click();
    await expect(a.getByRole('checkbox', { name: `Ukończ: Paczka ${tag}`, exact: true })).toHaveCount(0);
    await a.getByRole('button', { name: 'Cofnij', exact: true }).click();
    await expect(a.getByRole('checkbox', { name: `Ukończ: Paczka ${tag}`, exact: true })).toBeVisible();
    await a.goto(origin + '/ustawienia'); await a.getByRole('button', { name: 'Wyloguj', exact: true }).click();
    await expect(a.getByRole('group', { name: 'Niewysłane zmiany przed wylogowaniem' })).toBeVisible();
    await a.getByRole('button', { name: 'Anuluj', exact: true }).click();
    await context.close(); context = await playwright[browserName].launchPersistentContext(profile, { ...options, offline: true }); a = await context.newPage();
    await a.goto(origin + '/'); await expect(a.getByText(`Paczka ${tag}`, { exact: true })).toBeVisible();
    await expect(a.locator('html')).toHaveAttribute('data-theme', 'dark');
    await a.goto(origin + '/ustawienia/profil'); await expect(a.getByLabel('Twoja nazwa')).toHaveValue(`Anna ${tag}`); await expect(a.getByLabel('Strefa czasowa domu')).toHaveValue('America/Los_Angeles');
    await a.getByLabel('Twoja nazwa').fill('Niezapisany offline'); await a.getByRole('button', { name: 'Zapisz', exact: true }).click();
    await expect(a.getByRole('alert')).toContainText('Serwer jest niedostępny'); await expect(a.getByLabel('Twoja nazwa')).toHaveValue('Niezapisany offline');
    const shots = process.env.RAZEM_SCREENSHOTS;
    if (shots) await mkdir(shots, { recursive: true });
    for (const theme of ['Jasny', 'Ciemny']) {
      await a.goto(origin + '/ustawienia'); await a.getByRole('radio', { name: theme, exact: true }).check();
      for (const width of [375, 390, 430, 1280]) {
        await a.setViewportSize({ width, height: 844 });
        for (const path of ['/', '/zakupy', '/zadania', '/kalendarz', '/notatki', '/wazne-daty', '/wiecej', '/kosz', '/ustawienia', '/ustawienia/profil', '/ustawienia/powiadomienia', '/ustawienia/instalacja', '/zmiany']) {
          await a.goto(origin + path); await expect(a.getByRole('heading', { level: 1 })).toBeVisible();
          expect(await layout(a), `${theme} ${width} ${path}`).toEqual([]);
          if (path === '/zadania') expect(await a.locator('.segmented__option span').evaluateAll((nodes) => nodes.every((node) => node.getBoundingClientRect().height <= 44.5))).toBe(true);
          if (shots && width === 390) await a.screenshot({ path: join(shots, `${info.project.name}-${theme}-${path.replaceAll('/', '_') || '_'}.png`), fullPage: true });
        }
      }
    }
    await context.setOffline(false); await sync(a, origin); await sync(b, origin); await b.goto(origin + '/');
    await expect(b.getByText(`Paczka ${tag}`, { exact: true })).toBeVisible(); await expect(b.getByText(`Sekret ${tag}`, { exact: true })).toHaveCount(0);
    await b.goto(origin + '/ustawienia/powiadomienia'); await expect(b.getByRole('switch', { name: /^Tytuły na ekranie blokady/ })).not.toBeChecked();
    await b.goto(origin + '/ustawienia/profil'); await b.getByLabel('Twoja nazwa').fill(`Tomek ${tag}`); await save(b, '/ustawienia');
    await a.goto(origin + '/ustawienia'); // automatic startup cycle, without Synchronizuj teraz
    await expect(a.getByRole('link', { name: /Profil i domownicy/ })).toContainText(`Tomek ${tag}`);
    await a.goto(origin + '/notatki'); await a.getByRole('link', { name: new RegExp(`Prywatna notatka ${tag}`) }).click();
    await a.getByRole('button', { name: 'Usuń notatkę', exact: true }).click(); await a.getByRole('button', { name: 'Usuń', exact: true }).click();
    await expect(a).toHaveURL(origin + '/notatki');
    await a.goto(origin + '/kosz'); const row = a.getByRole('listitem').filter({ hasText: `Prywatna notatka ${tag}` });
    await expect(row).toContainText('Usunięto:'); await row.getByRole('button', { name: 'Przywróć', exact: true }).click(); await expect(row).toHaveCount(0);
  } finally { await context.close(); await other.close(); await rm(profile, { recursive: true, force: true }); }
});
