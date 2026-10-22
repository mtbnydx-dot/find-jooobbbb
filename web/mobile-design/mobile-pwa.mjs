import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Only a static shell is cached; never cache authenticated API data or answers.
export function mobilePwa() {
  let base;
  return {
    name: 'zhilu-mobile-shell',
    apply: 'build',
    configResolved(config) { base = config.base; },
    transformIndexHtml() {
      return [
        { tag: 'link', attrs: { rel: 'manifest', href: `${base}manifest.webmanifest` }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: `${base}icons/apple-touch-icon-180.png` }, injectTo: 'head' },
      ];
    },
    generateBundle(_options, bundle) {
      const icons = ['icon-192.png', 'icon-512.png', 'apple-touch-icon-180.png'];
      for (const file of icons) this.emitFile({ type: 'asset', fileName: `icons/${file}`, source: readFileSync(new URL(`../public/icons/${file}`, import.meta.url)) });
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify({
        id: './index.html', name: '职路 · 移动求职', short_name: '职路', lang: 'zh-CN',
        start_url: './index.html#/discover', scope: './', display: 'standalone', background_color: '#ffffff', theme_color: '#ffffff',
        icons: [{ src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }],
      }) });
      const assets = ['index.html', 'manifest.webmanifest', ...icons.map(file => `icons/${file}`), ...Object.keys(bundle).filter(file => /\.(?:js|css)$/.test(file))];
      const version = createHash('sha256').update(JSON.stringify(assets)).digest('hex').slice(0, 16);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const BASE = new URL(self.registration.scope);
const PREFIX = 'zhilu-mobile-' + BASE.pathname.replace(/[^a-z0-9]/gi, '-') + '-';
const CACHE = PREFIX + '${version}';
const SHELL = ${JSON.stringify(assets)}.map(path => new URL(path, BASE).href);
const ALLOWED = new Set(SHELL);
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== BASE.origin || !url.pathname.startsWith(BASE.pathname) || /\\/api(?:\\/|$)/.test(url.pathname)) return;
  if (request.mode === 'navigate') { event.respondWith(fetch(request).catch(() => caches.match(new URL('index.html', BASE).href))); return; }
  if (!ALLOWED.has(url.href)) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request)));
});
` });
    },
  };
}
