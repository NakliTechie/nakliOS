// Sonella's service worker (P2): keeps the page so the editor opens offline after the first load.
// Network first (a new version arrives as soon as the network does), with a 5-second limit, after
// which the cached copy answers. Everything else (the optional model files under ai/) passes through:
// Sonella keeps those in its own cache when the person downloads them.
const CACHE = 'sonella-shell-v1';
// Only the folder URL is kept: some hosts redirect /index.html to /, and a redirected response cannot
// answer a navigation.
const PAGE = './';

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.add(PAGE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('sonella-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url), scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || (url.pathname !== scope.pathname && url.pathname !== `${scope.pathname}index.html`)) return;
  const cached = () => caches.open(CACHE).then((c) => c.match(PAGE)).then((hit) => hit ?? Response.error());
  e.respondWith((async () => {
    try {
      const res = await Promise.race([fetch(req), new Promise((_, no) => setTimeout(() => no(new Error('slow network')), 5000))]);
      if (res.ok && !res.redirected) { const copy = res.clone(); e.waitUntil(caches.open(CACHE).then((c) => c.put(PAGE, copy))); }
      return res;
    } catch { return cached(); }
  })());
});
