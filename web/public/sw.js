const CACHE_NAME = 'zhilu-shell-__BUILD_ID__';
const BUILD_ASSETS = [
  /*__BUILD_ASSETS__*/
];
const APP_SHELL = [
  '/app/',
  '/app/index.html',
  '/app/manifest.webmanifest',
  '/app/icons/icon-192.svg',
  '/app/icons/icon-512.svg',
  '/app/icons/icon-192.png',
  '/app/icons/icon-512.png',
  '/app/icons/apple-touch-icon-180.png',
  ...BUILD_ASSETS,
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('zhilu-') && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/app/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async response => {
          if (response.ok) {
            const copy = response.clone();
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/app/index.html', copy);
          }
          return response;
        })
        .catch(() => caches.match('/app/index.html').then(response => response || caches.match('/app/'))),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      const network = fetch(request).then(response => {
        if (response.ok && ['script', 'style', 'font', 'image', 'manifest'].includes(request.destination)) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      });
      return cached || network;
    }),
  );
});
