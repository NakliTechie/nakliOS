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
//   - the pinned CDN files (PINS below): cache first, and a copy is stored
//     only when its SHA-384 equals the pinned hash (review C22), so a changed
//     file on the CDN is never kept and never served from the cache. A file
//     that fails the check passes through uncached; the page's own integrity
//     check then refuses it where the page carries one (ui/sri.mjs).
//   - other CDN files (the transformers.js sidecar and its runtime, which
//     carry no pin) and everything else (model weights, AI providers, the
//     local bridge) pass through untouched and are never cached.
// Only complete 200 responses are stored; opaque responses are never cached.
// The page sends { type: 'precache', urls } after registration (its own URL and
// the HyperFormula bundle), so the files fetched during the first load, which
// no service worker controlled, are cached too. CDN files are always fetched
// in CORS mode (both hosts send Access-Control-Allow-Origin: *).

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
// "-pinned" (review C22): a cache from before the hash check is deleted on activate,
// even when the version did not change
const CACHE = `reckon-${VERSION}-pinned`;
const CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'cdn.sheetjs.com']);
const SHELL = ['./commands.json'];
// a copy of the table in ui/sri.mjs (scripts/check-csp.mjs fails when they differ)
const PINS = {
  'https://cdn.jsdelivr.net/npm/hyperformula@3.5.0/dist/hyperformula.full.min.js': 'sha384-ArJPp2WE5WE+EatZph3OpGD0ueXSeu6CktSliyA7a/ngUpNfG2gPRGokUhLztRjM',
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js': 'sha384-D/t0ZMqQW31H3az8ktEiNb39wyKnS82iFY52QPACM+IjKW3jDUhyIgh2PApRqJZs',
  'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.core.min.js': 'sha384-mnBT8sXCZGqGzeFvFdidh/dFZnwVtEn9eh9KkYSQXfJtUOzVku17NZodCX362Jw+',
  'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js': 'sha384-Pqp51FUN2/qzfxZxBCtF0stpc9ONI6MYZpVqmo8m20SoaQCzf+arZvACkLkirlPz',
  'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/dist/duckdb-browser-eh.worker.js': 'sha384-a2Q5wPfMJHriw96D3xhtkym83ST11xUIm6e27q9d3v4ykPqSzeY7WCXK6CTlJFwb',
  'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/dist/duckdb-browser-mvp.worker.js': 'sha384-ABB4QFgUoQqfiMRv4Eme20RCo+rO//OBEOJfiUbiZFBRH/4T4xy8Vcu4hLXgPxQ0',
  'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/dist/duckdb-eh.wasm': 'sha384-hw3GjeJZY5QapQ8mwqMHXBPVmTLO+jKm5dlDwkGsEfjyu/HcXx1d0Rwlr/ZAShjq',
  'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/dist/duckdb-mvp.wasm': 'sha384-aPxDmtovNQyMTy8S7zolNUiHoQNvtkLGOWJdPtQpW1T52DQuqeGutmEdb0ycBoNs',
  'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm': 'sha384-uIGgJgCndOLby3tJZH0ArnERiNehoe7L3fB6A9hXVQ07JKjsiUY9hbujXMiHmhDA',
  'https://cdn.jsdelivr.net/npm/apache-arrow@17.0.0/+esm': 'sha384-EzZLPOtWBlnrvdnpaH2VJM2UiyH4TouFRMyo/WZvX1rfp3nDBJQhdcwCF6xb6FSm',
  'https://cdn.jsdelivr.net/npm/flatbuffers@24.3.25/+esm': 'sha384-9t2LsOpj4opUuy/f9D4vSA+NfESv+rqXvUoQ19ZhmNsA6j4TI+V8q87FY16S+KjY',
  'https://cdn.jsdelivr.net/npm/tslib@2.6.3/+esm': 'sha384-BXphtxj4LOPhlu1vuQhAtk80EyXwQgrmUdz9TPZICalKSfjqkv3XgQgOL60e9gmG',
};

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

// 'sha384-<base64>' of a response body (the response itself stays unread)
const sha384Of = async (res) => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-384', await res.clone().arrayBuffer()));
  let s = '';
  for (const b of digest) s += String.fromCharCode(b);
  return `sha384-${btoa(s)}`;
};
// store a CDN response only when it is pinned and its bytes match the pin
const putVerified = async (cache, url, res) => {
  if (!cacheable(res) || !Object.hasOwn(PINS, url)) return false;
  if ((await sha384Of(res)) !== PINS[url]) {
    console.warn(`[reckon sw] ${url} does not match its pinned hash; not cached`);
    return false;
  }
  await cache.put(url, res.clone());
  return true;
};

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== 'precache' || !Array.isArray(msg.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of msg.urls) {
      try {
        const url = new URL(u, self.location.href);
        if (CDN_HOSTS.has(url.hostname)) {
          if (!Object.hasOwn(PINS, url.href) || await cache.match(url.href)) continue;
          await putVerified(cache, url.href, await fetch(cdnRequest(url.href)));
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
    if (!Object.hasOwn(PINS, req.url)) return; // unpinned: the browser fetches it, nothing is kept
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req.url);
      if (hit) return hit;
      const res = await fetch(cdnRequest(req.url));
      try { await putVerified(cache, req.url, res); } catch { /* the cache is a convenience */ }
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
