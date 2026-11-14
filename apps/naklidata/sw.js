// NakliData service worker — lite PWA caching.
//
// Two caches, two strategies:
//   * SHELL (naklidata-shell-<CACHE_VERSION>) — the app shell + code chunks.
//     Stale-while-revalidate; rotated every deploy (esbuild rewrites
//     CACHE_VERSION to the inline-script hash, M12), so a new bundle self-heals.
//   * RUNTIME (naklidata-runtime-<RUNTIME_VERSION>) — the large, IMMUTABLE
//     vendored language/engine runtimes (Pyodide ~33 MB, WebR ~47 MB, ReadStat,
//     DuckDB extensions). Cache-FIRST with NO background revalidation, and keyed
//     by its OWN version so it SURVIVES shell redeploys. Previously these lived
//     in the shell cache, so every deploy's `activate` evicted ~100 MB that
//     hadn't changed → a full re-download of Python/R on the next run; and SWR
//     re-fetched the whole 66 MB in the background on every single load. This
//     separate cache-first bucket is the "OPFS caching" of the runtime bytes —
//     the SW's Cache API is the right home since these are same-origin HTTP
//     fetches (Pyodide/WebR drive their own sub-fetches, which OPFS can't cleanly
//     intercept). Bump RUNTIME_VERSION only when the vendored bytes change.
//
// On navigation when offline, fall back to the cached index.html so the
// app keeps booting (engine boot will then either use the CDN if back
// online, or surface its own error). See DECISIONS 2026-05-17 11:50.

const CACHE_VERSION = 'bsxCirCOj3KhS';
// Policy version deliberately rotates the cache when eligibility rules change,
// even if the inlined application hash stays the same.
const CACHE_POLICY_VERSION = 'p3';
const CACHE_NAME = `naklidata-shell-${CACHE_VERSION}-${CACHE_POLICY_VERSION}`;

// Bump ONLY when the vendored runtime bytes (public/pyodide, public/webr,
// public/readstat-wasm, public/duckdb-extensions) are re-vendored.
const RUNTIME_VERSION = 'v1';
const RUNTIME_CACHE = `naklidata-runtime-${RUNTIME_VERSION}`;

const SCOPE_PATH = new URL(self.registration.scope).pathname.replace(/\/$/, '');

// Path segments whose assets are large + immutable-per-runtime-version.
const RUNTIME_PREFIXES = ['/pyodide/', '/webr/', '/readstat-wasm/', '/duckdb-extensions/'];
const STATIC_PREFIXES = [
  '/chunks/',
  '/duckdb-fallback/',
  '/examples/',
  '/guide/',
  '/reference/',
  '/sqlite-wasm/',
  '/taxonomy/',
  ...RUNTIME_PREFIXES,
];

// Production loads the pinned DuckDB-wasm package from jsDelivr because the
// wasm files exceed the 25 MiB per-file hosting limit. Those four files are the
// only third-party URLs this worker stores. The base must equal
// DEFAULT_CDN_BASE in src/core/engine.ts (a unit test checks it). The bytes are
// the same public files the page would fetch anyway, kept in the runtime cache
// so a later offline start can boot the engine. No integrity hash is checked
// here, matching spec amendment A14.
const DUCKDB_CDN_BASE = 'https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/dist/';
const DUCKDB_CDN_FILES = new Set([
  'duckdb-eh.wasm',
  'duckdb-browser-eh.worker.js',
  'duckdb-mvp.wasm',
  'duckdb-browser-mvp.worker.js',
]);

function isPinnedDuckdbAsset(url) {
  return (
    url.href.startsWith(DUCKDB_CDN_BASE) &&
    url.search === '' &&
    DUCKDB_CDN_FILES.has(url.pathname.split('/').pop() ?? '')
  );
}
const STATIC_PATHS = new Set([
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icon.svg',
  '/main.js',
  '/graph-metrics.worker.js',
  '/taxonomy.worker.js',
]);
const PRIVATE_PREFIXES = ['/api/', '/auth/', '/graphql/', '/oauth/', '/private/', '/.well-known/'];
const SENSITIVE_QUERY_KEY =
  /(?:^|_)(?:access_?token|api_?key|authorization|credential|password|secret|signature|x-amz-)/i;

/** Return a scope-relative pathname so the same allowlist works at `/` and a
 * deploy prefix such as `/NakliData/`. Null means the URL is outside this SW's
 * registered path. */
function scopedPath(url) {
  const pathname = url.pathname;
  if (SCOPE_PATH && pathname !== SCOPE_PATH && !pathname.startsWith(`${SCOPE_PATH}/`)) {
    return null;
  }
  const relative = SCOPE_PATH ? pathname.slice(SCOPE_PATH.length) : pathname;
  return relative === '' ? '/' : `/${relative.replace(/^\/+/, '')}`;
}

function isRuntimeAsset(pathname) {
  return RUNTIME_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isStaticAsset(pathname) {
  return (
    STATIC_PATHS.has(pathname) || STATIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function isPrivatePath(pathname) {
  return PRIVATE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function hasSensitiveQuery(url) {
  for (const key of url.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEY.test(key)) return true;
  }
  return false;
}

/** Requests carrying authority or partial-response semantics never interact
 * with Cache Storage, even when their pathname looks like a static asset. */
function shouldBypassRequest(req, url, pathname) {
  if (!pathname || !isStaticAsset(pathname) || isPrivatePath(pathname)) return true;
  if (hasSensitiveQuery(url)) return true;
  if (req.headers.has('authorization') || req.headers.has('range')) return true;
  // Browser navigations use `include` even for the public app shell. That one
  // exact allowlisted path keeps its offline fallback; credentialed subresource
  // requests always bypass, and private/no-store navigation responses are
  // still excluded by responseCanBeCached.
  if ((req.credentials === 'include' && req.mode !== 'navigate') || req.cache === 'no-store') {
    return true;
  }
  const cacheControl = req.headers.get('cache-control')?.toLowerCase() ?? '';
  return cacheControl.includes('no-store') || cacheControl.includes('private');
}

function responseCanBeCached(res) {
  if (!res || res.status !== 200 || !res.ok || res.type === 'opaque') return false;
  if (res.headers.has('content-range')) return false;
  const cacheControl = res.headers.get('cache-control')?.toLowerCase() ?? '';
  return !cacheControl.includes('no-store') && !cacheControl.includes('private');
}

// The build replaces this marker with the small lazy chunks and the reference
// files, so a first visit leaves the app usable offline. `./index.html` is not
// listed: the origin may answer it with a redirect, and Chrome refuses to use a
// redirected response for a page navigation. The shell is stored under `./`.
const PRECACHE_EXTRA = ["./chunks/agent-surface.js","./chunks/bridge-client.js","./chunks/cleaning.js","./chunks/compare-tables.js","./chunks/contract-export.js","./chunks/data-quality.js","./chunks/demo-workbook.js","./chunks/facet-charts.js","./chunks/facet-network.js","./chunks/iceberg-catalog-mount.js","./chunks/iceberg-modals.js","./chunks/iceberg-rest-client.js","./chunks/link-paths.js","./chunks/map-data.js","./chunks/observable-plot.js","./chunks/onboarding-tour.js","./chunks/persistence-validation.js","./chunks/pyodide-runtime.js","./chunks/query-builder.js","./chunks/readstat-reader.js","./chunks/reference-enrich.js","./chunks/remote-delimited.js","./chunks/report-templates.js","./chunks/result-facets.js","./chunks/review-tray.js","./chunks/schema-override.js","./chunks/selection-explain.js","./chunks/semantic-classifier.js","./chunks/semantic-model.js","./chunks/sidecar-ontology.js","./chunks/sink-execution.js","./chunks/sqlite-reader.js","./chunks/standards-interchange.js","./chunks/standards-reasoning.js","./chunks/standards-skos.js","./chunks/standards-workbook.js","./chunks/static-export.js","./chunks/type-proposals.js","./chunks/webr-runtime.js","./chunks/xlsx-export.js","./reference/gst-state-codes.json","./reference/hsn-chapters.json","./reference/iso-4217.json","./reference/manifest.json"];

const PRECACHE_PATHS = [
  './',
  './manifest.webmanifest',
  './icon.svg',
  './taxonomy.worker.js',
  './chunks/codemirror.js',
  ...PRECACHE_EXTRA,
];

// The first visit loads the engine before this worker controls the page, so the
// worker never sees those requests. The page asks once the engine is ready, and
// the worker stores the two files an enhanced-exceptions browser needs. The
// browser's own HTTP cache normally serves them, so this adds little traffic.
const DUCKDB_KEEP = ['duckdb-browser-eh.worker.js', 'duckdb-eh.wasm'];

async function keepEngineFiles() {
  const cache = await caches.open(RUNTIME_CACHE);
  for (const name of DUCKDB_KEEP) {
    const href = `${DUCKDB_CDN_BASE}${name}`;
    if (await cache.match(href)) continue;
    const res = await fetch(href, { mode: 'cors', credentials: 'omit' }).catch(() => undefined);
    if (res && res.status === 200 && res.type === 'cors') {
      await cache.put(href, res).catch(() => {});
    }
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'keep-engine') event.waitUntil(keepEngineFiles());
});

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE_PATHS.map((p) => new Request(p, { cache: 'reload' }))).catch((err) => {
        // Partial precache (e.g., chunk missing in dev) shouldn't block
        // activation — we'd rather have a half-cached shell than no SW.
        console.warn('[naklidata-sw] precache partial failure', err);
      }),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Keep BOTH the current shell cache and the current runtime cache; prune the
  // rest. This is what lets the runtime bytes survive a shell redeploy (the old
  // shell cache is dropped, the runtime cache — same name across deploys — stays).
  const keep = new Set([CACHE_NAME, RUNTIME_CACHE]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // Third-party requests pass through, except the four pinned DuckDB files.
    // Range and credentialed requests also pass through untouched.
    if (!isPinnedDuckdbAsset(url) || req.headers.has('range')) return;
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(url.href);
        if (cached) return cached;
        // A CORS response answers both the worker's no-cors script import and
        // the engine's CORS fetch of the wasm file.
        const res = await fetch(url.href, { mode: 'cors', credentials: 'omit' }).catch(
          () => undefined,
        );
        if (res && res.status === 200 && res.type === 'cors') {
          cache.put(url.href, res.clone()).catch(() => {});
        }
        return res ?? Response.error();
      }),
    );
    return;
  }
  const pathname = scopedPath(url);
  if (shouldBypassRequest(req, url, pathname)) return;

  // Only the allowlisted shell navigation reaches this branch. A same-origin
  // navigation to /api, /private, or another application path passes through.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          // A redirected response cannot answer a later navigation, so only a
          // direct 200 is stored, and always under `./`.
          if (responseCanBeCached(res) && !res.redirected) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put('./', res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(async () => (await caches.match('./')) ?? Response.error()),
    );
    return;
  }

  // Immutable runtime bytes: cache-first, NO background revalidation, in the
  // deploy-independent runtime cache. First fetch fills it; every later load
  // (this session or after an app update) serves from cache with zero network —
  // no re-downloading tens of MB of Pyodide/WebR.
  if (isRuntimeAsset(pathname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req).catch(() => undefined);
        // Only cache a full 200 (a 206 partial or an error must not poison it).
        if (responseCanBeCached(res)) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res ?? Response.error();
      }),
    );
    return;
  }

  // Explicitly allowlisted static GET: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const networkPromise = fetch(req)
        .then((res) => {
          if (responseCanBeCached(res)) {
            // Don't block the response on cache.put — fire-and-forget.
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => undefined);
      return cached ?? (await networkPromise) ?? Response.error();
    }),
  );
});
