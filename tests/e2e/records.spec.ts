import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

// Detail, edit and shopping-item screens WITH content, on the test-only fixture app
// (apps/web/e2e-fixtures, synthetic records, long Polish names). Same App and CSS as production.
const FIXTURES = 'http://127.0.0.1:4318';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LIST = id(1);
const screens = [
  '/zakupy', `/zakupy/${LIST}`, `/zakupy/${id(2)}`, `/zakupy/${LIST}/edycja`, `/zakupy/${LIST}/pozycje/nowa`, `/zakupy/${LIST}/pozycje/${id(11)}`,
  '/zadania', `/zadania/${id(20)}`, `/zadania/${id(20)}/edycja`, `/zadania/${id(21)}`,
  '/kalendarz', `/kalendarz/${id(30)}`, `/kalendarz/${id(30)}/edycja`, `/kalendarz/${id(31)}`,
  '/notatki', `/notatki/${id(40)}`, `/notatki/${id(40)}/edycja`,
  '/wazne-daty', `/wazne-daty/${id(50)}`, `/wazne-daty/${id(50)}/edycja`,
  `/zadania/${id(99)}`,
];
const widths = [375, 390, 430, 1280];
const shots = process.env.RAZEM_SCREENSHOTS;

async function layoutProblems(page: Page) {
  return page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) problems.push(`poziomy scroll ${root.scrollWidth}>${root.clientWidth}`);
    for (const control of document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea')) {
      const style = getComputedStyle(control);
      if (control.closest('.skip-link') || style.visibility === 'hidden' || style.display === 'none') continue;
      const box = (control.closest('label') ?? control).getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      if (box.width < 43.5 || box.height < 43.5) problems.push(`cel <44px: ${control.outerHTML.slice(0, 80)} ${box.width}x${box.height}`);
      if (box.right > root.clientWidth + 0.5 || box.left < -0.5) problems.push(`poza ekranem: ${control.outerHTML.slice(0, 80)}`);
      const labels = (control as HTMLInputElement).labels;
      const name = control.getAttribute('aria-label') || (labels && labels.length ? labels[0]!.textContent : '') || control.textContent;
      if (!name?.trim()) problems.push(`brak nazwy: ${control.outerHTML.slice(0, 80)}`);
    }
    return problems;
  });
}

for (const width of widths) {
  test(`${width}px: szczegóły, edycja i pozycje z treścią bez poziomego scrolla, cele ≥44 px`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: width > 900 ? 860 : 844 });
    for (const path of screens) {
      await page.goto(FIXTURES + path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByText('Wczytywanie…')).toHaveCount(0);
      expect(await layoutProblems(page), `${path} @${width}`).toEqual([]);
      if (shots && [`/zakupy/${LIST}`, `/zakupy/${LIST}/pozycje/nowa`, `/zadania/${id(20)}`, `/notatki/${id(40)}/edycja`].includes(path)) {
        mkdirSync(shots, { recursive: true });
        await page.screenshot({ path: join(shots, `rec-${info.project.name}-${width}${path.replaceAll('/', '_').slice(0, 60)}.png`), fullPage: true });
      }
    }
    // Large text on the busiest screen.
    await page.goto(`${FIXTURES}/zakupy/${LIST}`);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    expect(await layoutProblems(page), `duży tekst @${width}`).toEqual([]);
  });
}

test('zakupy: z list do zawartości, odhaczenie przenosi do Kupione, Cofnij przywraca', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${FIXTURES}/zakupy`);
  await page.getByRole('link', { name: /Zakupy na weekend/ }).click();
  const open = page.getByRole('list', { name: 'Do kupienia' });
  const bought = page.getByRole('list', { name: 'Kupione' });
  await expect(open.getByText('Mleko', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Kupione: Mleko' }).check();
  await expect(bought.getByText('Mleko', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cofnij' }).click();
  await expect(open.getByText('Mleko', { exact: true })).toBeVisible();
  // The last action on the page scrolls clear of the bottom tab bar.
  const remove = page.getByRole('button', { name: 'Usuń listę' });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const navTop = (await page.getByRole('navigation', { name: 'Główna nawigacja' }).boundingBox())!.y;
  expect((await remove.boundingBox())!.y + (await remove.boundingBox())!.height).toBeLessThanOrEqual(navTop);
});

test('zakupy: formularz pozycji — walidacja przy polu, treść zachowana, widoczność z listy', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${FIXTURES}/zakupy/${LIST}/pozycje/nowa`);
  await expect(page.getByText('Widoczność jak lista.', { exact: false })).toBeVisible();
  await page.getByLabel('Ilość (opcjonalnie)').fill('3 szt.');
  await page.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page.getByLabel('Nazwa')).toBeFocused();
  await expect(page.getByLabel('Nazwa')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Ilość (opcjonalnie)')).toHaveValue('3 szt.');
  expect(await layoutProblems(page)).toEqual([]);
});

test('edycja: formularz wypełniony, widoczność jako tekst, Anuluj wraca do szczegółów', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto(`${FIXTURES}/notatki/${id(40)}`);
  await page.getByRole('link', { name: 'Edytuj' }).click();
  await expect(page.getByLabel('Tytuł')).toHaveValue(/Pomysły na prezenty/);
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByText('Widoczności nie można zmienić po zapisaniu.')).toBeVisible();
  await page.getByRole('link', { name: 'Anuluj' }).click();
  await expect(page).toHaveURL(`${FIXTURES}/notatki/${id(40)}`);
});
