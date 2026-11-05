import { test, expect } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

// Real browser (IndexedDB, Web Locks, online/offline events) against the built server
// with two synthetic accounts (tests/start-sync-server.mjs). Each test uses its own titles,
// so the projects (Chromium, WebKit) can share the server.
const ANNA = { login: 'anna@example.test', password: 'Syntetyczne haslo Anny 2026' };
const TOMEK = { login: 'tomek@example.test', password: 'Syntetyczne haslo Tomka 2026' };

test.use({ baseURL: 'http://127.0.0.1:4319' });
// Sync may wait for the 15 s tick (the sandbox browser never fires "online"): generous limit.
test.describe.configure({ timeout: 120_000 });
const badge = (page: Page) => page.locator('.sync-badge').first();

async function signIn(context: BrowserContext, account: typeof ANNA): Promise<Page> {
  const page = await context.newPage();
  await page.goto('/logowanie');
  await page.getByLabel('Login').fill(account.login);
  await page.getByLabel('Hasło', { exact: true }).fill(account.password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dzisiaj' })).toBeVisible();
  await expect(badge(page)).toContainText('Zsynchronizowano', { timeout: 15_000 });
  return page;
}

async function addNote(page: Page, title: string, body: string, visibility: 'Wspólne' | 'Tylko ja') {
  await open(page, '/notatki/nowa');
  await page.getByLabel('Tytuł').fill(title);
  await page.getByLabel('Treść').fill(body);
  await page.locator('.privacy__option', { hasText: visibility }).click();
  await page.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page).not.toHaveURL(/nowa$/);
}
/** Client-side navigation; full process restarts with SW are covered by pwa.spec.ts. */
async function open(page: Page, path: string) {
  await page.evaluate((to) => { window.history.pushState(null, '', to); window.dispatchEvent(new PopStateEvent('popstate')); }, path);
}

test('dwa konteksty offline tworzą wpisy, po powrocie sieci zbiegają się bez duplikatów; prywatny nie wycieka', async ({ browser }, info) => {
  const tag = `${info.project.name}-${Date.now()}`;
  const [contextA, contextB] = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const a = await signIn(contextA, ANNA), b = await signIn(contextB, TOMEK);
    await contextA.setOffline(true); await contextB.setOffline(true);
    await addNote(a, `Od Anny offline ${tag}`, 'mleko', 'Wspólne');
    await addNote(a, `Prywatne Anny ${tag}`, 'PIN 1234', 'Tylko ja');
    await addNote(b, `Od Tomka offline ${tag}`, 'chleb', 'Wspólne');
    await open(a, '/');
    await expect(badge(a)).toHaveText('Offline · zmiany czekają na wysłanie (2)');

    await contextA.setOffline(false); await contextB.setOffline(false);
    await open(b, '/');
    await expect(badge(a)).toContainText('Zsynchronizowano', { timeout: 20_000 });
    await expect(badge(b)).toContainText('Zsynchronizowano', { timeout: 20_000 });
    for (const page of [a, b]) {
      await page.reload();
      await page.goto('/notatki');
      await expect(page.getByText(`Od Anny offline ${tag}`)).toHaveCount(1, { timeout: 20_000 });
      await expect(page.getByText(`Od Tomka offline ${tag}`)).toHaveCount(1, { timeout: 20_000 });
    }
    await expect(b.getByText(`Prywatne Anny ${tag}`)).toHaveCount(0);
    await expect(a.getByText(`Prywatne Anny ${tag}`)).toHaveCount(1);
  } finally { await Promise.all([contextA.close(), contextB.close()]); }
});

test('restart karty przy niedostępnym serwerze zachowuje kolejkę; potem jeden ACK', async ({ browser }, info) => {
  const tag = `${info.project.name}-${Date.now()}`;
  const context = await browser.newContext();
  try {
    const page = await signIn(context, ANNA);
    await context.route('**/api/**', (route) => route.fulfill({ status: 502, contentType: 'text/html', body: 'Bad gateway' }));
    await addNote(page, `Przy awarii serwera ${tag}`, '', 'Tylko ja');
    await open(page, '/');
    await expect(badge(page)).toHaveText('Serwer niedostępny · zmiany czekają na wysłanie (1)', { timeout: 15_000 });
    await page.close();
    const again = await context.newPage();
    await again.goto('/notatki');
    await expect(again.getByText(`Przy awarii serwera ${tag}`)).toBeVisible();
    await context.unroute('**/api/**');
    await again.goto('/');
    await expect(badge(again)).toContainText('Zsynchronizowano', { timeout: 20_000 });
    const me = await (await context.request.get('/api/me')).json() as { user: { id: string } };
    const pull = await context.request.get('/api/sync/pull', { headers: { 'x-razem-account': me.user.id } });
    const body = await pull.json() as { changes: { record?: { data: { title: string } } }[] };
    expect(body.changes.filter((change) => change.record?.data.title === `Przy awarii serwera ${tag}`)).toHaveLength(1);
  } finally { await context.close(); }
});

test('konflikt: obie wersje widoczne, wybór mojej wersji trafia do drugiej osoby', async ({ browser }, info) => {
  const tag = `${info.project.name}-${Date.now()}`;
  const [contextA, contextB] = await Promise.all([browser.newContext(), browser.newContext()]);
  try {
    const a = await signIn(contextA, ANNA), b = await signIn(contextB, TOMEK);
    await addNote(a, `Plan ${tag}`, 'Góry', 'Wspólne');
    await open(a, '/');
    await expect(badge(a)).toContainText('Zsynchronizowano', { timeout: 20_000 });
    await b.reload();
    await b.goto('/notatki');
    await b.getByText(`Plan ${tag}`).click();
    await expect(b.getByText('Góry')).toBeVisible();
    await contextB.setOffline(true);
    await b.getByRole('link', { name: 'Edytuj' }).click();
    await b.getByLabel('Treść').fill('Góry i Bieszczady (Tomek)');
    await b.getByRole('button', { name: 'Zapisz' }).click();
    await expect(b).not.toHaveURL(/edycja$/);

    await a.goto('/notatki');
    await a.getByText(`Plan ${tag}`).click();
    await a.getByRole('link', { name: 'Edytuj' }).click();
    await a.getByLabel('Treść').fill('Tatry (Anna)');
    await a.getByRole('button', { name: 'Zapisz' }).click();
    await expect(a).not.toHaveURL(/edycja$/);
    await open(a, '/');
    await expect(badge(a)).toContainText('Zsynchronizowano', { timeout: 20_000 });

    await contextB.setOffline(false);
    await open(b, '/');
    await expect(badge(b)).toHaveText(/1 zmiana wymaga sprawdzenia/, { timeout: 20_000 });
    await badge(b).getByRole('link', { name: 'Sprawdź' }).click();
    await b.getByRole('link', { name: new RegExp(`Plan ${tag}`) }).click();
    await expect(b.getByText('Góry i Bieszczady (Tomek)').first()).toBeVisible();
    await expect(b.getByText('Tatry (Anna)').first()).toBeVisible();
    await b.getByRole('button', { name: 'Zachowaj moją wersję' }).click();
    await expect(b.getByText('Wszystko w porządku')).toBeVisible({ timeout: 20_000 });
    await open(b, '/');
    await expect(badge(b)).toContainText('Zsynchronizowano', { timeout: 20_000 });

    await a.reload();
    await a.goto('/notatki');
    await a.getByText(`Plan ${tag}`).click();
    await expect(a.getByText('Góry i Bieszczady (Tomek)')).toBeVisible({ timeout: 20_000 });
  } finally { await Promise.all([contextA.close(), contextB.close()]); }
});
