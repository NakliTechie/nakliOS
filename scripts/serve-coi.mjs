#!/usr/bin/env node
// Local static server that reproduces the deploy headers from `_headers`.
//
// Why this exists: `python3 -m http.server` serves no COOP/COEP, so
// `crossOriginIsolated` is false, `SharedArrayBuffer` is absent, and the Kiln
// Python kernel (sys/kiln/worker-runtime.mjs, which hard-requires SAB) cannot be
// exercised on a local serve. `_headers` puts
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: credentialless
// on /apps/forge/* and /apps/anvil/* only. This server applies the same rule to
// the same two prefixes, plus the site-wide frame-ancestors header, so a local
// check sees production's isolation shape rather than a laxer one.
//
// COI is deliberately NOT applied to the root document: `_headers`' own comment
// records that host-wide COEP was tried and reverted 2026-08-26 because it broke
// every cross-origin embedded app. Keep the local server honest to that.
//
// Usage: node scripts/serve-coi.mjs [--port 8947] [--root .] [--books-root ../Books]
//        binds 127.0.0.1 only.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(argOf('--port', '8947'));
const ROOT = path.resolve(argOf('--root', path.join(HERE, '..')));
const HOST = '127.0.0.1';
const booksOverride = argOf('--books-root', null);
const booksCandidates = booksOverride ? [path.resolve(booksOverride)] : [
  path.resolve(ROOT, '../Books'),               // ordinary naklios checkout
  path.resolve(ROOT, '../../../Books'),         // managed worktree below naklios/.worktrees
];
const BOOKS_ROOT = booksCandidates.find(candidate => {
  try { return fs.statSync(candidate).isDirectory() && fs.statSync(path.join(candidate, 'index.html')).isFile(); }
  catch (_) { return false; }
}) || null;
if (booksOverride && !BOOKS_ROOT) throw new Error('--books-root needs a Books directory containing index.html');
const BOOKS_MOUNT = !booksOverride && fs.existsSync(path.join(ROOT, 'Books', 'index.html')) ? null : BOOKS_ROOT;

// Prefixes that get cross-origin isolation, mirroring `_headers`.
const COI_PREFIXES = ['/apps/forge/', '/apps/anvil/', '/apps/dish/'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function safeJoin(root, urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]); }
  catch (_) { return null; }
  const resolved = path.resolve(root, '.' + path.posix.normalize(decoded));
  // Refuse anything that escapes the root — a served tree is not a file picker.
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  // A local preview has no reason to serve repository metadata or dotenv files.
  if (path.relative(root, resolved).split(path.sep).some(part => part.startsWith('.') || part === 'node_modules')) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';
  const routePath = urlPath.split('?')[0];
  // The host's local Lorewell embed is /Books/. Keep its source repository
  // outside the NakliOS checkout while serving both under one local origin.
  const booksPath = BOOKS_MOUNT && (routePath === '/Books' || routePath.startsWith('/Books/'));
  let filePath = booksPath ? safeJoin(BOOKS_MOUNT, routePath.slice('/Books'.length) || '/') : safeJoin(ROOT, urlPath);
  if (!filePath) { res.writeHead(403).end('forbidden'); return; }

  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
  } catch (_) { /* fall through to the 404 below */ }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    return;
  }

  const headers = {
    'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    // No caching: a stale /sys/ module gives a FALSE live verdict.
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    // Site-wide, from `_headers`.
    'Content-Security-Policy': "frame-ancestors 'self'",
    'X-Frame-Options': 'SAMEORIGIN',
  };
  if (COI_PREFIXES.some(p => routePath.startsWith(p))) {
    headers['Cross-Origin-Opener-Policy'] = 'same-origin';
    headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
  }

  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`serve-coi: http://${HOST}:${server.address().port}  root=${ROOT}\n`);
  process.stdout.write(`serve-coi: COI on ${COI_PREFIXES.join(' ')}\n`);
  if (BOOKS_MOUNT) process.stdout.write(`serve-coi: /Books/ from ${BOOKS_MOUNT}\n`);
});
