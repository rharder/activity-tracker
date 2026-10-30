const CACHE_NAME = 'activity-tracker-v8';
const SDK_CACHE = 'activity-firebase-sdk-v12.18.0';
const ASSETS = [
  './',
  './index.html',
  './sync-state.js',
  './cloud-sync.js',
  './firebase-config.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Install: cache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS.map(asset => new Request(asset, { cache: 'reload' })));
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean app caches, then refresh legacy copies that have no update UI.
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const legacy = keys.some(key => key === 'activity-tracker-v4' ||
        key === 'activity-tracker-v5' || key.startsWith('activity-tracker-v4.1-'));
      await Promise.all(keys.filter(key => key.startsWith('activity-tracker-') &&
        key !== CACHE_NAME).map(key => caches.delete(key)));
      await self.clients.claim();
      if (legacy) {
        const windows = await self.clients.matchAll({ type: 'window' });
        // Do not await navigation here: its fetch must wait for activation to finish.
        windows.forEach(client => client.navigate(client.url).catch(() => {}));
      }
    })()
  );
});

async function cachedFirst(request, cacheName, page = false) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: page }) ||
    (page ? await cache.match('./index.html') : null);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

// Never put an authentication token, account response, or Firestore data in the
// service-worker cache. Only our local app and pinned public SDK files qualify.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const scope = new URL('./', self.location.href);

  if (url.origin === 'https://www.gstatic.com' &&
      /^\/firebasejs\/12\.18\.0\/firebase-(app|auth|firestore)(-compat)?\.js$/.test(url.pathname)) {
    event.respondWith(cachedFirst(event.request, SDK_CACHE));
    return;
  }
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  if (event.request.headers.get('X-Activity-Tracker-Update') === '1') {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).catch(() =>
      new Response('Offline', { status: 503 })));
    return;
  }
  // A bad connection must not delay startup. Updates are installed as a complete
  // app in a NEW cache, never mixed into the currently working offline copy.
  event.respondWith(cachedFirst(event.request, CACHE_NAME, event.request.mode === 'navigate'));
});
