import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
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
async function sync(p: Page, conflict = false) {
  await p.goto('/ustawienia'); await p.getByRole('button', { name: 'Synchronizuj teraz', exact: true }).click();
  await expect(p.getByRole('button', { name: 'Synchronizuj teraz', exact: true })).toBeEnabled();
  await expect(badge(p)).toContainText(conflict ? 'wymaga sprawdzenia' : 'Zsynchronizowano', { timeout: 20_000 });
}
async function create(p: Page, title: string, body: string, shared = false) {
  await p.goto('/notatki/nowa');
  await expect(p.getByRole('radio', { name: /Tylko ja/ })).toBeChecked();
  if (shared) await p.getByRole('radio', { name: /Wspólne/ }).check();
  await p.getByLabel('Tytuł', { exact: true }).fill(title); await p.getByLabel('Treść', { exact: true }).fill(body);
  await p.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(p).toHaveURL(ORIGIN + '/notatki');
  await p.getByRole('link', { name: new RegExp(title) }).click();
  await expect(p.getByRole('heading', { level: 1, name: title })).toBeVisible();
  return new URL(p.url()).pathname;
}
async function edit(p: Page, path: string, title: string, body: string) {
  await p.goto(path); await p.getByRole('link', { name: 'Edytuj', exact: true }).click();
  await expect(p.getByRole('radio')).toHaveCount(0);
  await p.getByLabel('Tytuł', { exact: true }).fill(title); await p.getByLabel('Treść', { exact: true }).fill(body);
  await p.getByRole('button', { name: 'Zapisz', exact: true }).click();
  await expect(p).toHaveURL(ORIGIN + path);
}
async function remove(p: Page, path: string) {
  await p.goto(path); await p.getByRole('button', { name: 'Usuń notatkę', exact: true }).click();
  await p.getByRole('button', { name: 'Usuń', exact: true }).click(); await expect(p).toHaveURL(ORIGIN + '/notatki');
}
async function restore(p: Page, title: string) {
  await p.goto('/kosz'); const row = p.getByRole('listitem').filter({ has: p.getByText(title, { exact: true }) });
  await row.getByRole('button', { name: 'Przywróć', exact: true }).click(); await expect(row).toHaveCount(0);
}
async function queue(p: Page) {
  return p.evaluate(async () => {
    const a = JSON.parse(localStorage.getItem('razem:account')!);
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(`razem:${a.householdId}:${a.userId}`); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const entries = await new Promise<{ clientMutationId: string }[]>((resolve, reject) => { const r = db.transaction('queue').objectStore('queue').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    db.close(); return entries.map((e) => e.clientMutationId);
  });
}

test('notatki offline: polski tekst/emoji, szukanie, prywatna i wspólna, jawna kopia, kosz/restore, restart, retry i ACL partnera', async ({ playwright, browserName, browser }, info) => {
  const tag = `${info.project.name}-${Date.now()}`, profile = await mkdtemp(join(tmpdir(), 'razem-notes-profile-'));
  const options = { headless: true, baseURL: ORIGIN, viewport: { width: 390, height: 844 }, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', ...(browserName === 'webkit' ? { isMobile: true, hasTouch: true } : {}) };
  let context = await playwright[browserName].launchPersistentContext(profile, options);
  const other = await browser.newContext({ baseURL: ORIGIN });
  try {
    let a = await context.newPage(); const b = await other.newPage(); await signIn(a); await signIn(b, true); await context.setOffline(true);
    const secret = `Prywatny żółw ${tag}`, secretBody = `Tajna łódź 🔐 ${tag}`, shared = `Domowe plany ${tag}`, source = `Do wspólnej kopii ${tag}`;
    const text = 'Zażółć gęślą jaźń 🧑‍🍳\n<img src=x onerror=alert(1)>\n<b>To zwykły tekst</b>';
    const privatePath = await create(a, secret, secretBody);
    const sharedPath = await create(a, shared, text, true);
    await expect(a.locator('.note-body')).toHaveText(text); await expect(a.locator('.note-body img, .note-body b')).toHaveCount(0);
    const sourcePath = await create(a, source, 'Świadomie udostępniona treść ⛵');
    await a.getByRole('button', { name: 'Udostępnij wspólną kopię', exact: true }).click();
    const confirmation = a.getByRole('group', { name: 'Potwierdź wspólną kopię' });
    await expect(confirmation).toContainText('Druga osoba w Waszym domu zobaczy tytuł i całą treść');
    await confirmation.getByRole('button', { name: 'Anuluj', exact: true }).click();
    const beforeCopy = await queue(a);
    await a.getByRole('button', { name: 'Udostępnij wspólną kopię', exact: true }).click();
    expect(await queue(a)).toEqual(beforeCopy);
    await a.getByRole('button', { name: 'Utwórz wspólną kopię', exact: true }).dblclick();
    await expect(a).not.toHaveURL(ORIGIN + sourcePath);
    const copyPath = new URL(a.url()).pathname;
    await expect(a.locator('.screen-meta')).toContainText('Wspólne'); expect(copyPath).not.toBe(sourcePath);
    await a.goto(sourcePath); await expect(a.locator('.screen-meta')).toContainText('Tylko ja');
    await edit(a, privatePath, secret, secretBody + '\nPoprawka offline 🐢');
    await remove(a, privatePath); await restore(a, secret);
    await remove(a, sharedPath);
    await a.goto('/notatki'); await a.getByLabel('Szukaj w notatkach').fill(`TAJNA LODZ 🔐 ${tag}`);
    await expect(a.getByRole('list', { name: 'Notatki' }).getByRole('link')).toHaveCount(1);
    await a.getByLabel('Szukaj w notatkach').fill('🐢');
    await expect(a.getByRole('list', { name: 'Notatki' })).toContainText(secret);
    const beforeRestart = await queue(a); expect(beforeRestart.length).toBeGreaterThan(5);
    await context.close(); context = await playwright[browserName].launchPersistentContext(profile, { ...options, offline: true }); a = await context.newPage();
    await a.goto(privatePath); await expect(a.getByRole('heading', { level: 1, name: secret })).toBeVisible();
    await expect(a.locator('.note-body')).toContainText('Poprawka offline 🐢'); expect(await queue(a)).toEqual(beforeRestart);
    await restore(a, shared); await a.goto(sharedPath); await expect(a.locator('.note-body')).toHaveText(text);
    // Lose one push reply after the real server committed it. The persisted queue must retry unchanged.
    // Wrap the browser fetch: WebKit does not route all requests of a SW-controlled page.
    // Persist the test marker across navigation so exactly one committed reply is lost.
    const loseReply = () => {
      const fetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await fetch(input, init);
        if (String(input) === '/api/sync/push' && response.ok && !localStorage.getItem('raz-10:lost-push')) {
          localStorage.setItem('raz-10:lost-push', 'true');
          throw new TypeError('Synthetic lost push reply after commit');
        }
        return response;
      };
    };
    await context.addInitScript(loseReply); await a.evaluate(loseReply);
    await context.setOffline(false); await sync(a); await sync(b);
    expect(await a.evaluate(() => localStorage.getItem('raz-10:lost-push'))).toBe('true'); expect(await queue(a)).toEqual([]);
    await b.goto('/notatki');
    await expect(b.getByRole('link', { name: new RegExp(shared) })).toHaveCount(1);
    await expect(b.getByRole('link', { name: new RegExp(source) })).toHaveCount(1);
    await b.getByLabel('Szukaj w notatkach').fill('TAJNA LODZ'); await expect(b.getByText('Brak wyników', { exact: true })).toBeVisible();
    for (const path of [privatePath, sourcePath]) { await b.goto(path); await expect(b.getByText('Nie znaleziono wpisu', { exact: true })).toBeVisible(); await expect(b.getByText(secretBody, { exact: false })).toHaveCount(0); }
    const me = await (await other.request.get('/api/me')).json(); let cursor: string | undefined;
    do {
      const body = await (await other.request.get(`/api/sync/pull?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { 'x-razem-account': me.user.id, 'x-razem-protocol': '2' } })).json();
      const payload = JSON.stringify(body); for (const value of [secret, secretBody, privatePath.split('/').at(-1)!, sourcePath.split('/').at(-1)!]) expect(payload).not.toContain(value);
      cursor = body.hasMore ? body.nextCursor : undefined;
    } while (cursor);
    await other.setOffline(true); await edit(b, copyPath, source, 'Osobna kopia poprawiona przez partnera');
    await b.goto('/ustawienia'); const downloaded = b.waitForEvent('download');
    await b.getByRole('button', { name: /^Eksport niewysłanych zmian/ }).click();
    const file = await downloaded; const payload = await readFile((await file.path())!, 'utf8');
    expect(payload).toContain('Osobna kopia poprawiona przez partnera');
    for (const value of [secret, secretBody, privatePath.split('/').at(-1)!, sourcePath.split('/').at(-1)!]) expect(payload).not.toContain(value);
    await file.delete(); await other.setOffline(false); await sync(b); await sync(a);
    await a.goto(sourcePath); await expect(a.locator('.note-body')).toHaveText('Świadomie udostępniona treść ⛵');
    await a.goto(copyPath); await expect(a.locator('.note-body')).toHaveText('Osobna kopia poprawiona przez partnera');
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); await other.close(); await rm(profile, { recursive: true, force: true }); }
});

test('notatki: dwie edycje offline pokazują obie wersje plain text i pozwalają scalić ręcznie po restarcie', async ({ browser }, info) => {
  const ca = await browser.newContext({ baseURL: ORIGIN }), cb = await browser.newContext({ baseURL: ORIGIN });
  try {
    const a = await ca.newPage(), b = await cb.newPage(); await signIn(a); await signIn(b, true);
    const title = `Połączone pomysły ${info.project.name}-${Date.now()}`;
    const path = await create(a, title, 'Początek', true); await sync(a); await sync(b);
    await ca.setOffline(true); await cb.setOffline(true);
    const mine = 'Łódź ⛵ <b>wersja Tomka</b>', server = 'Żółw 🐢 <img src=x onerror=alert(1)>';
    await edit(a, path, title, server); await edit(b, path, title, mine);
    await ca.setOffline(false); await sync(a); await cb.setOffline(false); await sync(b, true);
    await b.reload(); await b.goto('/zmiany'); await b.getByRole('link', { name: new RegExp(title) }).click();
    await expect(b.getByRole('heading', { name: 'Moja wersja (to urządzenie)', exact: true })).toBeVisible();
    await expect(b.getByRole('heading', { name: 'Zapisana na serwerze', exact: true })).toBeVisible();
    await expect(b.getByText(mine, { exact: true })).toBeVisible(); await expect(b.getByText(server, { exact: true })).toBeVisible();
    await expect(b.locator('.compare img, .compare b')).toHaveCount(0);
    await b.getByRole('radio', { name: 'Połącz ręcznie', exact: true }).check();
    await expect(b.getByLabel('Treść – połączona treść')).toHaveValue(mine + '\n' + server);
    const joined = 'Żółw 🐢 i łódź ⛵\n<b>To wciąż tekst</b>';
    await b.getByLabel('Treść – połączona treść').fill(joined);
    await b.getByRole('button', { name: 'Zapisz połączoną wersję', exact: true }).click();
    await expect(b.getByText('Wszystko w porządku', { exact: true })).toBeVisible();
    await sync(b); await sync(a);
    for (const page of [a, b]) { await page.goto(path); await expect(page.locator('.note-body')).toHaveText(joined); await expect(page.locator('.note-body b')).toHaveCount(0); }
  } finally { await ca.close(); await cb.close(); }
});
