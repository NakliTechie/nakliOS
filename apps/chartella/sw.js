// sw.js — Chartella offline after the first load (parity N6). Network first for the page and its command list, so an
// update shows at once; the last good copy answers when there is no network. Everything else (boards, images) is the
// page's own business: boards live on the person's disk, images in OPFS or NakliOS storage.
const CACHE = 'chartella-shell-v1';
const SHELL = ['./', './index.html', './commands.json', './board.schema.json'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  const shell = url.pathname === scope.pathname || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/commands.json') || url.pathname.endsWith('/board.schema.json');
  if (!shell) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))));
});
