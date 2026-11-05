/* Generated from this template after Vite completes. No user data belongs here. */
const CACHE = 'razem-shell-__VERSION__';
const ASSETS = __PRECACHE__;

self.addEventListener('install', (event) => {
  // addAll is atomic: a missing file/quota/network failure leaves the old worker active.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload', credentials: 'omit' })));
    } catch (error) {
      await caches.delete(CACHE); // An unsuccessful candidate must not leave an empty cache.
      throw error;
    }
  })());
  // Never skipWaiting: all old clients must close before the next version activates.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith('razem-shell-') && key !== CACHE)
    .map((key) => caches.delete(key)))));
  // No clients.claim or reload: an already open page keeps its original resources.
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Also exclude navigation to API endpoints. Never use the shell as an API response.
  if (url.pathname === '/api' || url.pathname.startsWith('/api/') || ['/healthz', '/readyz'].includes(url.pathname)) return;
  const asset = !url.search && ASSETS.includes(url.pathname) ? url.pathname
    : request.mode === 'navigate' && !url.pathname.includes('.') ? '/index.html' : null;
  if (!asset) return; // Unknown requests go to network and never enter Cache API.
  event.respondWith(caches.open(CACHE).then(async (cache) =>
    (await cache.match(asset)) ?? Response.error()));
});

// Every push results in a visible notification; never a silent background sync.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data?.json() ?? {}; } catch { /* malformed payload still shows a generic notification */ }
  const url = typeof data.url === 'string' && /^\/powiadomienie\/(task|calendar_event|important_date|shopping_list|shopping_item)\/[0-9a-f-]{36}$/.test(data.url) ? data.url : '/';
  event.waitUntil(self.registration.showNotification('Razem', {
    body: typeof data.body === 'string' && data.body ? data.body.slice(0, 200) : 'Masz przypomnienie w Razem',
    tag: typeof data.tag === 'string' ? data.tag : 'razem', data: { url }, icon: '/icon-192.png',
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = event.notification.data?.url;
  const url = new URL(typeof path === 'string' && /^\/powiadomienie\/(task|calendar_event|important_date|shopping_list|shopping_item)\/[0-9a-f-]{36}$/.test(path) ? path : '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (client) { await client.navigate(url); await client.focus(); }
    else await self.clients.openWindow(url);
  })());
});
