
const BASE = new URL(self.registration.scope);
const PREFIX = 'zhilu-mobile-' + BASE.pathname.replace(/[^a-z0-9]/gi, '-') + '-';
const CACHE = PREFIX + '068a306a7dad4888';
const SHELL = ["index.html","manifest.webmanifest","icons/icon-192.png","icons/icon-512.png","icons/apple-touch-icon-180.png","assets/index-BhlaH41E.js","assets/Account-BgqdmZxM.js","assets/Auth-BWWccJ_B.js","assets/Prep-11vXsoMu.js","assets/account-x8G7nPCd.js","assets/rolldown-runtime-CbXtAM7H.js","assets/runtime-DRBtfRqi.js","assets/Prep-VejBvf1c.css","assets/account-Dy8WXEK-.css","assets/index-B10CIwxn.css"].map(path => new URL(path, BASE).href);
const ALLOWED = new Set(SHELL);
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname) || /\/api(?:\/|$)/.test(url.pathname)) return;
  if (request.mode === 'navigate') { event.respondWith(fetch(request).catch(() => caches.match(new URL('index.html', BASE).href))); return; }
  if (!ALLOWED.has(url.href)) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
