const CACHE_NAME = 'activity-tracker-v5';
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
      return cache.addAll(ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch: serve from cache first, fall back to network, cache new responses
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

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
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
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
