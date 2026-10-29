const CACHE_NAME = 'activity-tracker-v6';
const ASSETS = [
  './',
  './index.html',
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

// Prefer fresh app HTML, including explicit version checks; retain offline use.
async function freshPage(request) {
  const cache = await caches.open(CACHE_NAME);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(request, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Page unavailable');
    await cache.put(request, response.clone());
    return response;
  } catch (err) {
    const cached = await cache.match(request, { ignoreSearch: true }) || await cache.match('./index.html');
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('X-Activity-Tracker-Offline', 'true');
      return new Response(cached.body, { status: cached.status, headers });
    }
    return new Response('Offline. Please connect to the internet and try again.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Other assets remain cache-first, with background revalidation.
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const scope = new URL('./', self.location.href);
  if (url.origin === scope.origin && (event.request.mode === 'navigate' ||
      url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html')) {
    event.respondWith(freshPage(event.request));
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Return cache hit, but also update cache in background
        event.waitUntil(fetch(event.request).then(response => {
          if (response.ok) {
            return caches.open(CACHE_NAME).then(cache => {
              return cache.put(event.request, response);
            });
          }
        }).catch(() => {}));
        return cached;
      }
      // Not in cache — fetch from network and cache it
      return fetch(event.request).then(response => {
        if (response.ok) {
          const responseClone = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone)));
        }
        return response;
      }).catch(() => {
        // Offline and not cached — return a basic offline fallback for HTML
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return new Response('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>Offline</h2><p>Please connect to the internet and reload.</p></body></html>', {
            headers: { 'Content-Type': 'text/html' }
          });
        }
      });
    })
  );
});
