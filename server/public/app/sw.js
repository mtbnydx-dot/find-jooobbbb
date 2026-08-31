const SCOPE_URL = new URL(self.registration.scope);
const APP_BASE = SCOPE_URL.pathname.endsWith('/') ? SCOPE_URL.pathname : `${SCOPE_URL.pathname}/`;
const CACHE_PREFIX = `zhilu-${APP_BASE.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root'}-`;
const CACHE_NAME = `${CACHE_PREFIX}shell-326ed8cfa13a`;
const appPath = relativePath => new URL(relativePath, SCOPE_URL).pathname;
const BUILD_ASSETS = [
    "/app/assets/index-BCAJ4M79.css",
  "/app/assets/index-Dqg2K9uJ.js",
];
const APP_SHELL = [
  APP_BASE,
  appPath('index.html'),
  appPath('manifest.webmanifest'),
  appPath('icons/icon-192.svg'),
  appPath('icons/icon-512.svg'),
  appPath('icons/icon-192.png'),
  appPath('icons/icon-512.png'),
  appPath('icons/apple-touch-icon-180.png'),
  ...BUILD_ASSETS,
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith(appPath('api/'))) return;
  if (url.origin !== self.location.origin || !url.pathname.startsWith(APP_BASE)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async response => {
          if (response.ok) {
            const copy = response.clone();
            const cache = await caches.open(CACHE_NAME);
            await cache.put(appPath('index.html'), copy);
          }
          return response;
        })
        .catch(() => caches.match(appPath('index.html')).then(response => response || caches.match(APP_BASE))),
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
