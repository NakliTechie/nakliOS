#!/usr/bin/env node
// check-vendored-sdk.mjs — fleet drift report for the vendored naklios.js SDK.
//
// The canonical SDK is sdk/naklios.js. Several apps vendor it INLINE (they run
// standalone / cross-origin and can't <script src> it). Those copies rot when
// the canonical hardens — this is what silently left Tijori on the pre-hardening
// v1 SDK. This script reports, per app, whether its inlined copy is:
//
//   OK          — spliced, marker hash matches canonical
//   DRIFT       — spliced, but stale or hand-edited (marker/region ≠ canonical)
//   UNMANAGED   — vendors the SDK but has no begin/end markers (needs one-time adoption)
//   n/a         — doesn't vendor the SDK
//   missing     — working copy not found locally
//
// Default: scan local sibling repos under naklios-universe/. With --remote, fetch
// each app's live URL instead (for a scheduled cloud check). Exit 1 on any DRIFT.
//
// Dependency-free (Node built-ins only).

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CANONICAL_PATH = resolve(HERE, '../sdk/naklios.js');
const UNIVERSE = resolve(HERE, '../..'); // naklios-universe/

// The apps that carry the SDK inline. `local` = path under naklios-universe/;
// `remote` = live URL for --remote mode. `variant: true` = the app maintains its
// OWN hand-written protocol-compatible SDK (not the canonical file), so it can't be
// marker-managed until it's converted to vendor canonical — reported as BESPOKE,
// not a drift failure. Keep this list in step with reality — a new vendoring app is
// added here so the fleet check covers it.
const APPS = [
  { id: 'books',       local: 'Books/index.html',       remote: 'https://naklitechie.github.io/Books/' },
  { id: 'vaultmind',   local: 'VaultMind/index.html',   remote: 'https://naklitechie.github.io/VaultMind/' },
  { id: 'tijori',      local: 'Tijori/index.html',      remote: 'https://naklitechie.github.io/Tijori/' },
  { id: 'kanzen',      local: 'KanZen/index.html',      remote: 'https://naklitechie.github.io/KanZen/' },
  { id: 'nakliposter', local: 'NakliPoster/index.html', remote: 'https://naklitechie.github.io/NakliPoster/' },
  { id: 'sheaf',       local: '../sheaf/index.html',    remote: 'https://sheaf.naklitechie.com/' },
];

const BEGIN_RE = /\/\*\s*naklios-sdk:begin\b([^*]*)\*\//;
const END_RE = /\/\*\s*naklios-sdk:end\s*\*\//;
const REMOTE = process.argv.includes('--remote');

function sha256(s) { return createHash('sha256').update(s, 'utf8').digest('hex'); }
function inlineBody(canonical) { return canonical.replace(/<\/script/gi, '<\\/script'); }

const canonical = readFileSync(CANONICAL_PATH, 'utf8');
const canonHash = sha256(inlineBody(canonical));
const canonVer = (canonical.match(/@naklios-sdk-version\s+(\d+)/) || [])[1] || '0';

async function loadApp(app) {
  if (REMOTE) {
    const res = await fetch(app.remote, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
  const p = resolve(UNIVERSE, app.local);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function classify(html) {
  if (!html) return { state: 'missing' };
  const begin = html.match(BEGIN_RE);
  const end = html.match(END_RE);
  const vendorsSdk = /window\.naklios\s*=/.test(html);
  if (!begin || !end || begin.index >= end.index) {
    return { state: vendorsSdk ? 'UNMANAGED' : 'n/a' };
  }
  const stamped = (begin[1].match(/sha256=([0-9a-f]+)/i) || [])[1] || null;
  const stampedVer = (begin[1].match(/ver=(\d+)/i) || [])[1] || '?';
  // Recompute the actual inlined region's hash to catch a lying marker / hand-edit.
  // The splicer writes "<begin>\n<body>\n<end>", so strip one leading/trailing \n.
  const region = html.slice(begin.index + begin[0].length, end.index);
  const actual = sha256(region.replace(/^\n/, '').replace(/\n$/, ''));
  const fresh = stamped === canonHash && actual === canonHash;
  return { state: fresh ? 'OK' : 'DRIFT', stamped, stampedVer, actual };
}

const rows = [];
let drift = 0, bespoke = 0;
for (const app of APPS) {
  let html = null, err = null;
  try { html = await loadApp(app); } catch (e) { err = e.message; }
  let c = err ? { state: 'error', err } : classify(html);
  // A known bespoke-variant app has no markers by definition — report it as
  // BESPOKE (a standing to-convert note), not as a drift failure.
  if (app.variant && (c.state === 'UNMANAGED' || c.state === 'n/a')) c = { state: 'BESPOKE' };
  if (c.state === 'DRIFT' || c.state === 'UNMANAGED') drift++;
  if (c.state === 'BESPOKE') bespoke++;
  rows.push({ id: app.id, ...c });
}

console.log(`canonical: sdk/naklios.js  ver=${canonVer}  sha256=${canonHash.slice(0, 12)}…  (${REMOTE ? 'remote' : 'local'} scan)`);
for (const r of rows) {
  const detail =
    r.state === 'OK' ? `ver=${r.stampedVer}` :
    r.state === 'DRIFT' ? `stamped=${(r.stamped || 'none').slice(0, 12)}… ver=${r.stampedVer}` :
    r.state === 'BESPOKE' ? 'own SDK variant — convert to vendor canonical' :
    r.state === 'error' ? r.err : '';
  console.log(`  ${r.state.padEnd(10)} ${r.id.padEnd(14)} ${detail}`);
}

if (drift > 0) {
  console.error(`\n${drift} app(s) need attention (DRIFT = stale copy; UNMANAGED = add markers, see docs/app-contract.md).`);
  process.exit(1);
}
console.log(`\nAll marker-managed SDK copies fresh${bespoke ? `; ${bespoke} bespoke variant(s) pending conversion` : ''}.`);
