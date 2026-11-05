/* Generated from this template after Vite completes. No user data belongs here. */
const CACHE = 'razem-shell-__VERSION__';
const ASSETS = __PRECACHE__;

self.addEventListener('install', (event) => {
  // addAll is atomic: a missing file/quota/network failure leaves the old worker active.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(
    ASSETS.map((url) => new Request(url, { cache: 'reload', credentials: 'omit' })),
  )));
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
  const asset = request.mode === 'navigate' ? '/index.html'
    : !url.search && ASSETS.includes(url.pathname) ? url.pathname : null;
  if (!asset) return; // Unknown requests go to network and never enter Cache API.
  event.respondWith(caches.open(CACHE).then(async (cache) =>
    (await cache.match(asset)) ?? Response.error()));
});
