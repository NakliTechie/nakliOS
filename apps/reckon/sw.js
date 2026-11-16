// Reckon service worker (parity v1, row P3): works offline after the first load.
//
// Registered by reckon.html only over http(s); file:// never registers it and
// keeps working without it. The cache name carries the reckon-version meta
// (passed as ?v= on registration), so a new release starts a fresh cache and
// the old one is deleted on activate.
//
// Rules:
//   - same-origin page GETs (reckon.html, index.html, commands.json, guide.html):
//     network first, cache fallback, so a deploy is picked up on the next
//     online load and the last good copy serves offline.
//   - the pinned CDN hosts (cdn.jsdelivr.net, cdn.sheetjs.com): cache first.
//     Their URLs carry exact versions (HyperFormula, PapaParse, SheetJS, the
//     transformers.js sidecar), so a cached copy never goes stale. Lazily loaded
//     libraries are cached the first time the page asks for them.
//   - everything else (model weights, AI providers, the local bridge) passes
//     through untouched.
// Only complete 200 responses are stored; opaque responses are never cached.
// The page sends { type: 'precache', urls } after registration (its own URL and
// the HyperFormula bundle), so the files fetched during the first load, which
// no service worker controlled, are cached too. CDN files are always fetched
// in CORS mode (both hosts send Access-Control-Allow-Origin: *), so even a
// worker's importScripts() of HyperFormula gets a cacheable response.

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `reckon-${VERSION}`;
const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'cdn.sheetjs.com']);
const SHELL = ['./commands.json'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // best-effort: a missing optional file must not block installation
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // delete only this app's older caches, by name
    await Promise.all(names.filter((n) => n.startsWith('reckon-') && n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const cacheable = (res) => res && res.status === 200 && res.type !== 'opaque';

const cdnRequest = (url) => new Request(url, { mode: 'cors', credentials: 'omit' });

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== 'precache' || !Array.isArray(msg.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of msg.urls) {
      try {
        const url = new URL(u, self.location.href);
        if (CDN_HOSTS.has(url.hostname)) {
          if (await cache.match(url.href)) continue;
          const res = await fetch(cdnRequest(url.href));
          if (cacheable(res)) await cache.put(url.href, res);
        } else if (url.origin === self.location.origin) {
          const key = url.origin + url.pathname; // pages are cached without their query
          const res = await fetch(key, { cache: 'no-cache' });
          if (cacheable(res)) await cache.put(key, res);
        }
      } catch { /* offline or blocked: the next online load retries */ }
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (CDN_HOSTS.has(url.hostname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      const res = await fetch(cdnRequest(req.url));
      if (cacheable(res)) cache.put(req.url, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }

  // same origin: only the page itself and the files it needs to boot; test
  // fixtures and anything else pass through uncached
  const shellFile = req.mode === 'navigate' || /\.html$|\/commands\.json$|\/$/.test(url.pathname);
  if (url.origin === self.location.origin && shellFile) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = url.origin + url.pathname; // ?lang=, ?fresh and similar share one copy
      try {
        const res = await fetch(req);
        if (cacheable(res)) cache.put(key, res.clone()).catch(() => {});
        return res;
      } catch (e) {
        const hit = await cache.match(key);
        if (hit) return hit;
        throw e;
      }
    })());
  }
});
