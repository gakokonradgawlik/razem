import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test.describe.configure({ mode: 'serial', timeout: 90_000 });
const originOf = (project: string) => `http://127.0.0.1:${project === 'chromium' ? 4320 : 4321}`;
const badge = (page: Page) => page.locator('.sync-badge').first();
async function signIn(page: Page, login = 'anna@example.test', password = 'Syntetyczne haslo Anny 2026') {
  await page.goto('/logowanie');
  await page.getByLabel('Login').fill(login);
  await page.getByLabel('Hasło', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Zaloguj się' }).click();
  await expect(badge(page)).toContainText('Zsynchronizowano', { timeout: 20_000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await page.reload(); // First installation intentionally does not claim a running page.
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}
async function note(page: Page, title: string) {
  await page.goto('/notatki/nowa');
  await page.getByLabel('Tytuł').fill(title);
  await page.getByLabel('Treść').fill('Syntetyczna treść prywatna');
  await page.getByRole('button', { name: 'Zapisz' }).click();
  await expect(page).not.toHaveURL(/nowa$/);
}
async function localState(page: Page) {
  return page.evaluate(async () => {
    const account = JSON.parse(localStorage.getItem('razem:account')!);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(`razem:${account.householdId}:${account.userId}`);
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const read = <T,>(table: string) => new Promise<T[]>((resolve, reject) => {
      const req = db.transaction(table).objectStore(table).getAll();
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    const queue = await read<{ clientMutationId: string; attempts: number }>('queue');
    const meta = await read<{ key: string; value: unknown }>('meta');
    const records = await read<{ id: string; data: { title?: string } }>('records');
    const version = db.version;
    db.close();
    return { queue, meta, records, version };
  });
}
async function cacheKeys(page: Page) {
  return page.evaluate(async () => {
    const result: { name: string; urls: string[] }[] = [];
    for (const name of await caches.keys()) result.push({ name, urls: (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname) });
    return result;
  });
}

test.beforeEach(async ({ request }, info) => {
  expect((await request.post(`${originOf(info.project.name)}/__test/api/on`)).ok()).toBe(true);
  expect((await request.post(`${originOf(info.project.name)}/__test/release/A`)).ok()).toBe(true);
});

test('manifest, lokalne ikony, standalone i instrukcja iPhone', async ({ page }, info) => {
  const origin = originOf(info.project.name);
  await page.goto(`${origin}/ustawienia/instalacja`);
  await expect(page.getByText('Otworzono w przeglądarce')).toBeVisible();
  await expect(page.getByText('Do ekranu początkowego', { exact: true })).toBeVisible();
  await expect(page.getByText('Aplikacja gotowa do uruchamiania offline')).toBeVisible();
  const manifest = await (await page.request.get(`${origin}/manifest.webmanifest`)).json();
  expect(manifest).toMatchObject({ id: '/', start_url: '/', scope: '/', display: 'standalone', name: 'Razem' });
  for (const [src, size] of [...manifest.icons.map((i: { src: string; sizes: string }) => [i.src, Number(i.sizes.split('x')[0])]), ['/apple-touch-icon.png', 180]]) {
    expect(src).toMatch(/^\/[^/]/);
    const dimensions = await page.evaluate(async (url: string) => {
      const image = new Image(); image.src = url; await image.decode(); return [image.naturalWidth, image.naturalHeight];
    }, src);
    expect(dimensions).toEqual([size, size]);
  }
  expect(manifest.icons.find((i: { purpose: string }) => i.purpose === 'maskable')).toBeTruthy();
  await page.addInitScript(() => { Object.defineProperty(navigator, 'standalone', { value: true }); });
  await page.reload();
  await expect(page.getByText('Otworzono jako aplikację')).toBeVisible();
});

test('cold start: restart całej przeglądarki bez sieci, różne trasy, trwały outbox i późniejszy ACK', async ({ playwright, browserName, request }, info) => {
  const origin = originOf(info.project.name);
  const profile = await mkdtemp(join(tmpdir(), 'razem-pwa-profile-'));
  const options = { headless: true, baseURL: origin };
  let context = await playwright[browserName].launchPersistentContext(profile, options);
  const title = `Restart offline ${info.project.name}-${Date.now()}`;
  try {
    let page = await context.newPage();
    await signIn(page);
    await context.setOffline(true);
    await note(page, title);
    const before = await localState(page);
    expect(before.queue).toHaveLength(1);
    await context.close();
    // Persistent profile survives browser termination; network is cut before first request.
    context = await playwright[browserName].launchPersistentContext(profile, { ...options, offline: true });
    page = await context.newPage();
    for (const route of ['/notatki', '/zakupy', '/zadania', '/ustawienia/instalacja', '/notatki/nowa']) {
      await page.goto(route);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    await page.goto('/notatki');
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    expect((await localState(page)).queue.map((q) => q.clientMutationId)).toEqual(before.queue.map((q) => q.clientMutationId));
    await page.getByText(title, { exact: true }).click();
    const detail = new URL(page.url()).pathname;
    await page.close();
    page = await context.newPage();
    await page.goto(detail);
    await expect(page.getByText('Syntetyczna treść prywatna')).toBeVisible();
    await page.goto('/');
    await expect(badge(page)).toContainText('zmiany czekają na wysłanie (1)');
    await context.setOffline(false);
    await page.goto('/ustawienia');
    await page.getByRole('button', { name: 'Synchronizuj teraz' }).click();
    await expect(badge(page)).toContainText('Zsynchronizowano', { timeout: 20_000 });
    expect((await localState(page)).queue).toHaveLength(0);
    // No account payload or navigation history is cached by the worker.
    const caches = await cacheKeys(page);
    expect(caches).toHaveLength(1);
    expect(caches[0]!.urls.every((url) => url === '/index.html' || url.startsWith('/assets/') || /\.(png|svg|webmanifest)$/.test(url))).toBe(true);
    expect(caches[0]!.urls).not.toContain(detail);
    expect((await request.get(`${origin}/sw.js`)).headers()['cache-control']).toBe('no-store');
  } finally { await context.close(); await rm(profile, { recursive: true, force: true }); }
});

test('aktualizacja: błąd instalacji, formularz i pending w dwóch kartach, aktywacja dopiero po zamknięciu', async ({ browser, request }, info) => {
  const origin = originOf(info.project.name);
  const context = await browser.newContext({ baseURL: origin });
  try {
    let page = await context.newPage();
    await signIn(page);
    // Real server failure: browser routing is unreliable with WebKit Service Workers.
    await request.post(`${origin}/__test/api/off`);
    await note(page, `Pending upgrade ${info.project.name}-${Date.now()}`);
    const before = await localState(page);
    const oldCache = (await cacheKeys(page))[0]!.name;
    await page.goto('/notatki/nowa');
    await page.getByLabel('Tytuł').fill('Niezapisany formularz');
    await page.getByLabel('Treść').fill('Nie wolno utracić tej treści');
    const second = await context.newPage();
    await second.goto('/zakupy');
    // Drain navigation/focus update checks before deliberately publishing a broken build.
    await second.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await request.post(`${origin}/__test/release/broken`);
    await page.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration())!;
      const installed = new Promise<void>((resolve) => registration.addEventListener('updatefound', () => {
        const worker = registration.installing!;
        worker.addEventListener('statechange', () => { if (worker.state === 'redundant') resolve(); });
      }, { once: true }));
      await registration.update(); await installed;
    });
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(false);
    await expect.poll(async () => (await cacheKeys(page)).map((cache) => cache.name)).toEqual([oldCache]);
    await expect(page.getByLabel('Treść')).toHaveValue('Nie wolno utracić tej treści');
    await request.post(`${origin}/__test/release/B`);
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect(page.getByText('Dostępna nowa wersja')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Tytuł')).toHaveValue('Niezapisany formularz');
    expect((await localState(page)).queue.map((q) => q.clientMutationId)).toEqual(before.queue.map((q) => q.clientMutationId));
    expect(await page.getAttribute('html', 'data-pwa-release')).toBe('A');
    // A fresh navigation while another old client is open must still load build A.
    await second.reload();
    expect(await second.getAttribute('html', 'data-pwa-release')).toBe('A');
    await page.getByRole('button', { name: 'Zapisz' }).click();
    await expect(page).not.toHaveURL(/nowa$/);
    expect((await localState(page)).queue).toHaveLength(2);
    await page.close();
    expect(await second.evaluate(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting)).toBe(true);
    await second.close();
    page = await context.newPage();
    await expect.poll(async () => {
      await page.goto('/notatki');
      return page.getAttribute('html', 'data-pwa-release');
    }).toBe('B');
    await expect(page.getByText('Niezapisany formularz', { exact: true })).toBeVisible();
    expect((await localState(page)).queue).toHaveLength(2);
    const currentCache = await cacheKeys(page);
    expect(currentCache).toHaveLength(1);
    expect(currentCache[0]!.name).not.toBe(oldCache);
    const assets = await page.locator('script[src],link[rel=stylesheet]').evaluateAll((elements) => elements.map((e) => e.getAttribute('src') ?? e.getAttribute('href')));
    expect(assets.every((url) => url?.includes('-B.'))).toBe(true);
    await context.setOffline(true);
    await page.reload();
    expect(await page.getAttribute('html', 'data-pwa-release')).toBe('B');
    expect((await localState(page)).queue).toHaveLength(2);
  } finally { await context.close(); }
});

test('SW nie cache’uje API; wylogowanie i drugie konto nie pokazują poprzednich danych', async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: originOf(info.project.name) });
  const title = `Prywatne PWA ${info.project.name}-${Date.now()}`;
  try {
    const page = await context.newPage(); await signIn(page);
    await note(page, title);
    await page.goto('/ustawienia');
    await expect(badge(page)).toContainText('Zsynchronizowano', { timeout: 20_000 });
    await page.getByRole('button', { name: 'Wyloguj', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Zaloguj się' })).toBeVisible();
    expect(await page.evaluate(async () => (await indexedDB.databases()).filter((db) => db.name?.endsWith('0000000000aa')).length)).toBe(0);
    await signIn(page, 'tomek@example.test', 'Syntetyczne haslo Tomka 2026');
    await context.setOffline(true);
    await page.goto('/notatki');
    await expect(page.getByText(title, { exact: true })).toHaveCount(0);
    expect((await localState(page)).records.some((r) => r.data.title === title)).toBe(false);
    // Both fetch and top-level API navigation must fail offline, never return a cached 200.
    expect(await page.evaluate(async () => { try { await fetch('/api/me'); return false; } catch { return true; } })).toBe(true);
    expect((await cacheKeys(page)).flatMap((cache) => cache.urls).some((url) => url.startsWith('/api'))).toBe(false);
  } finally { await context.close(); }
});

test('upgrade IndexedDB v1 z outbox: te same identyfikatory i treść, potem dokładnie jeden ACK', async ({ browser }, info) => {
  const context = await browser.newContext({ baseURL: originOf(info.project.name) });
  const title = `Migracja PWA ${info.project.name}-${Date.now()}`;
  try {
    const page = await context.newPage(); await signIn(page);
    await page.goto('/icon.svg'); // Release the application's Dexie connection before replacing DB.
    const seeded = await page.evaluate(async (title) => {
      const account = JSON.parse(localStorage.getItem('razem:account')!);
      const name = `razem:${account.householdId}:${account.userId}`;
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase(name); req.onsuccess = () => resolve(); req.onerror = () => reject(req.error);
      });
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, 10); // Dexie v1 uses native IDB version 10.
        req.onupgradeneeded = () => {
          const records = req.result.createObjectStore('records', { keyPath: 'id' });
          records.createIndex('entityType', 'entityType'); records.createIndex('visibility', 'visibility');
          const outbox = req.result.createObjectStore('outbox', { keyPath: 'mutation.clientMutationId' });
          outbox.createIndex('queuedAt', 'queuedAt'); outbox.createIndex('state', 'state');
          req.result.createObjectStore('conflicts', { keyPath: 'id' });
          req.result.createObjectStore('cursors', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
      const entityId = crypto.randomUUID(), clientMutationId = crypto.randomUUID(), deviceId = crypto.randomUUID();
      const now = new Date().toISOString();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['records', 'outbox'], 'readwrite');
        tx.objectStore('records').put({ id: entityId, entityType: 'note', householdId: account.householdId,
          ownerId: account.userId, visibility: 'private', version: 0, data: { title, body: 'Oczekująca stara treść' },
          createdAt: now, updatedAt: now, deletedAt: null });
        tx.objectStore('outbox').put({ deviceId, queuedAt: now, attempts: 3, state: 'pending', mutation: {
          clientMutationId, entityId, entityType: 'note', command: 'create', baseVersion: 0,
          visibility: 'private', data: { title, body: 'Oczekująca stara treść' },
        } });
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      });
      db.close(); return { entityId, clientMutationId, deviceId };
    }, title);
    await context.setOffline(true);
    await page.goto('/notatki');
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    const upgraded = await localState(page);
    expect(upgraded.version).toBe(20);
    expect(upgraded.queue).toMatchObject([{ clientMutationId: seeded.clientMutationId, attempts: 3 }]);
    expect(upgraded.meta.find((m) => m.key === 'deviceId')?.value).toBe(seeded.deviceId);
    await page.close();
    const again = await context.newPage(); await again.goto('/notatki');
    expect((await localState(again)).queue[0]!.clientMutationId).toBe(seeded.clientMutationId);
    await context.setOffline(false);
    await again.goto('/ustawienia');
    await again.getByRole('button', { name: 'Synchronizuj teraz' }).click();
    await expect(badge(again)).toContainText('Zsynchronizowano', { timeout: 20_000 });
    expect((await localState(again)).queue).toHaveLength(0);
    const me = await (await context.request.get('/api/me')).json();
    const pull = await (await context.request.get('/api/sync/pull', { headers: { 'x-razem-protocol': '2', 'x-razem-account': me.user.id } })).json();
    expect(pull.changes.filter((c: { record?: { data: { title?: string } } }) => c.record?.data.title === title)).toHaveLength(1);
  } finally { await context.close(); }
});
