import { test, expect } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:4319';
async function login(page: Page, partner = false) {
  await page.goto(origin + '/logowanie');
  await page.getByLabel('Login').fill(partner ? 'tomek@example.test' : 'anna@example.test');
  await page.getByLabel('Hasło', { exact: true }).fill(`Syntetyczne haslo ${partner ? 'Tomka' : 'Anny'} 2026`);
  await page.getByRole('button', { name: 'Zaloguj się', exact: true }).click();
  await expect(page.locator('.sync-badge').first()).toContainText('Zsynchronizowano');
}
async function note(page: Page, title: string) {
  await page.goto(origin + '/notatki/nowa');
  await page.getByLabel('Tytuł').fill(title); await page.getByLabel('Treść').fill('Syntetyczny tekst eksportu');
  await page.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(page).toHaveURL(origin + '/notatki');
  await page.goto(origin + '/ustawienia');
}
async function contents(download: Download) {
  try { const path = await download.path(); return JSON.parse(await readFile(path!, 'utf8')); } finally { await download.delete(); }
}

test('ustawienia pobierają eksport konta i osobny pending offline bez opróżniania kolejki', async ({ page, browser }, info) => {
  const partnerContext = await browser.newContext(), partner = await partnerContext.newPage();
  const tag = `${info.project.name}-${Date.now()}`;
  try {
    await login(partner, true); await note(partner, `PRIVATE_B-${tag}`);
    await expect(partner.locator('.sync-badge').first()).toContainText('Zsynchronizowano');
    await login(page); await note(page, `PRIVATE_A-${tag}`);
    await expect(page.locator('.sync-badge').first()).toContainText('Zsynchronizowano');
    await page.goto(origin + '/ustawienia');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Eksport wszystkich moich i wspólnych danych/ }).click();
    const account = await contents(await download);
    expect(account.format).toBe('razem-account'); expect(account.account.login).toBe('anna@example.test');
    expect(JSON.stringify(account)).toContain(`PRIVATE_A-${tag}`); expect(JSON.stringify(account)).not.toContain(`PRIVATE_B-${tag}`);
    expect(JSON.stringify(account)).not.toMatch(/password_hash|token_hash|p256dh/);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.context().setOffline(true);
    await note(page, `PENDING_A-${tag}`);
    await page.goto(origin + '/ustawienia');
    const pendingDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: /Eksport niewysłanych zmian/ }).click();
    const pending = await contents(await pendingDownload);
    expect(pending.format).toBe('razem-pending-changes'); expect(pending.formatVersion).toBe(2);
    expect(JSON.stringify(pending)).toContain(`PENDING_A-${tag}`); expect(JSON.stringify(pending)).not.toContain(`PRIVATE_B-${tag}`);
    await expect(page.locator('.sync-badge').first()).toContainText('zmiany czekają na wysłanie (1)');
    await page.getByRole('button', { name: /Eksport wszystkich moich i wspólnych danych/ }).click();
    await expect(page.getByRole('alert')).toContainText('Nie udało się pobrać eksportu');
    await expect(page.locator('.sync-badge').first()).toContainText('zmiany czekają na wysłanie (1)');
    await page.context().setOffline(false);
    await page.getByRole('button', { name: 'Synchronizuj teraz', exact: true }).click();
    await expect(page.locator('.sync-badge').first()).toContainText('Zsynchronizowano');
  } finally { await partnerContext.close(); }
});
