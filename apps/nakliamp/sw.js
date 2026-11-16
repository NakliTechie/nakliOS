// sw.js — NakliAmp offline after the first load on the hosted mirror (parity N6).
// Copied from Chartella's approach: network first for the app's own files, so an
// update shows at once; the last good copy answers when there is no network.
// Only same-origin GETs inside this worker's scope are handled. The person's music
// never passes through here: it is read from the folder handle, not fetched.
// index.html registers this only over http(s), never under file:// and never in
// the gate harness.
const CACHE = 'nakliamp-shell-v1';
const SHELL = ['./', './index.html', './commands.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('nakliamp-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  // The page, its modules, workers, vendored libraries and the command list: every
  // file the app is made of. Range requests (media) are left to the network.
  if (e.request.headers.has('range')) return;
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok && r.type === 'basic') { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })
    .then((r) => r || (e.request.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
});
