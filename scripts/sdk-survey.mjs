#!/usr/bin/env node
// sdk-survey.mjs — which NakliOS apps carry the current naklios.js SDK (replaces check-vendored-sdk.mjs, which read
// six local clones and reported false drift when they were behind GitHub).
//
// For every app in the APPS catalog in index.html (classic games skipped), it finds the SDK copy NakliOS serves from
// apps/<id>/ and compares it with the canonical sdk/naklios.js byte for byte:
//   linked        <script src=…naklios.js>: always the canonical file
//   managed       inline between naklios-sdk:begin/end markers
//   file          a copy of sdk/naklios.js
//   unmarked      a copy with no markers (nothing keeps it fresh)
//   bespoke       the app's own protocol-compatible SDK
//   none          no SDK: the app runs without host services
//
//   node scripts/sdk-survey.mjs            the copies NakliOS serves (offline; the gate lane). Exit 1 if any is stale.
//   node scripts/sdk-survey.mjs --sources  also each mirror's source repo (main, through `gh api`) and each external
//                                          app's live page: what the app ships standalone. Exit 1 if any is stale.
//   --json                                 machine-readable rows instead of the table
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCES = process.argv.includes('--sources');
const JSON_OUT = process.argv.includes('--json');
const canonical = readFileSync(path.join(ROOT, 'sdk/naklios.js'), 'utf8');

export function classify(text) {
  if (!text) return { how: 'unreadable' };
  const begin = text.match(/\/\*\s*naklios-sdk:begin\b[^*]*\*\//), end = text.match(/\/\*\s*naklios-sdk:end\s*\*\//);
  if (begin && end && end.index > begin.index) {
    const region = text.slice(begin.index + begin[0].length, end.index).replace(/<\\\/script/gi, '</script').trim();
    return { how: 'managed', current: region === canonical.trim() };
  }
  if (/window\.naklios\s*=/.test(text) || /naklios:capabilities-request/.test(text)) {
    if (text.trim() === canonical.trim()) return { how: 'file', current: true };
    return { how: /@naklios-sdk-version/.test(text) ? 'unmarked' : 'bespoke', current: false };
  }
  if (/<script[^>]+src=["'][^"']*naklios\.js(\?[^"']*)?["']/i.test(text)) return { how: 'linked', current: true };
  return { how: 'none' };
}
const ORDER = ['managed', 'file', 'unmarked', 'bespoke', 'linked'];
function pick(entries) {
  const found = entries.map(([file, text]) => ({ file, ...classify(text) })).filter(c => ORDER.includes(c.how));
  found.sort((a, b) => ORDER.indexOf(a.how) - ORDER.indexOf(b.how));
  return found[0] || { how: 'none' };
}
function pageFiles(dir) {
  const out = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = path.join(d, f); const st = statSync(p);
    if (st.isDirectory()) { if (!/^(node_modules|vendor|assets|fonts|models|\.git)$/.test(f)) walk(p); }
    else if (/\.(html|js|mjs)$/.test(f) && st.size < 8e6) out.push(p); } };
  walk(dir); return out;
}
function catalog() {
  const s = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const i = s.indexOf('const APPS = ['); let depth = 0, j = i + 13;
  for (; j < s.length; j++) { if (s[j] === '[') depth++; if (s[j] === ']') { depth--; if (!depth) break; } }
  return Function('return ' + s.slice(i + 13, j + 1))().filter(a => a.kind !== 'classic');
}
const ghRaw = (repo, file, ref) => { try { return execFileSync('gh', ['api', `repos/${repo}/contents/${file}?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw'], { encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const page = async url => { try { const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) }); return r.ok ? await r.text() : null; } catch { return null; } };

const manifest = JSON.parse(readFileSync(path.join(ROOT, 'apps/manifest.json'), 'utf8'));
const mirrors = new Map(manifest.apps.map(a => [a.id, a]));
const rows = [];
for (const app of catalog()) {
  const dir = path.join(ROOT, 'apps', app.id), mirror = mirrors.get(app.id);
  const row = { id: app.id, where: mirror ? 'mirror' : existsSync(dir) ? 'native' : 'external' };
  if (existsSync(dir)) {
    const c = pick(pageFiles(dir).map(f => [path.relative(ROOT, f), readFileSync(f, 'utf8')]));
    row.inNakliOS = c;
  }
  if (SOURCES && mirror) {
    const managed = mirror.files.filter(f => f.managedSdk).map(f => f.source);
    const files = (managed.length ? managed : mirror.files.map(f => f.source).filter(f => /\.(html|js|mjs)$/.test(f))).slice(0, 40);
    row.standalone = { ...pick(files.map(f => [f, ghRaw(mirror.repo, f, mirror.ref || 'main')])), repo: mirror.repo };
  } else if (SOURCES && row.where === 'external' && app.url) {
    row.standalone = { ...classify(await page(app.url)), url: app.url };
  }
  rows.push(row);
}

const stale = rows.filter(r => r.inNakliOS?.current === false || r.standalone?.current === false);
if (JSON_OUT) console.log(JSON.stringify({ rows, stale: stale.map(r => r.id) }, null, 1));
else {
  const cell = c => !c ? '—' : c.how + (c.current === true ? ' ✓' : c.current === false ? ' STALE' : '');
  for (const r of rows) console.log(`${r.id.padEnd(12)} ${r.where.padEnd(8)} NakliOS: ${cell(r.inNakliOS).padEnd(16)}${SOURCES ? ' standalone: ' + cell(r.standalone) : ''}`);
  console.log(`\n${rows.length} apps; ${stale.length ? 'stale: ' + stale.map(r => r.id).join(', ') : 'no stale SDK copy'}.`);
}
process.exit(stale.length ? 1 : 0);
