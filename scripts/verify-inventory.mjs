#!/usr/bin/env node
// verify-inventory — every surface Anvil exposes has a recipe owner, or this exits 1.
//
//   node scripts/verify-inventory.mjs            # check (exit 1 on drift)
//   node scripts/verify-inventory.mjs --write    # rewrite verify/anvil/inventory.json, print the diff
//
// The idea is bb's (`.bb/skills/verify-bb/scripts/inventory.py`, read 2026-09-12): a feature map is
// only a map while something fails when the territory grows. The surfaces are enumerated FROM THE
// CODE, never typed by hand — the tools `runToolset` hands the model in every mode, the `__anvil.test`
// hooks, the `.anvil/` workspace files the app and its modules read, the ⋯ sheet's actions and the
// header's buttons — and each carries a fingerprint of its DEFINITION (a tool's schema and the modes
// that offer it, a hook's source, a button's title and text, a row's text, a file's path), so a
// changed definition flags "review its recipe" rather than passing on the name alone. A handler's
// body is not fingerprinted: what the model is shown is the definition; what the handler does is
// what the recipe's drive steps observe.
//
// Drift is one of: a surface with no owner; an owner whose recipe file or `### <surface>` heading is
// missing; an inventory entry whose surface no longer exists; a fingerprint that changed. `--write`
// rewrites the baseline and prints what changed — never run it to silence a red you have not read.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runToolset } from '../sys/ai/run-assembly.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY = join(ROOT, 'verify/anvil/inventory.json');
const FEATURES = join(ROOT, 'verify/anvil/features');
const APP = readFileSync(join(ROOT, 'apps/anvil/index.html'), 'utf8');
const fp = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

// Every <button …>…</button> with its attribute string and inner markup. A regex over `[^>]*` broke
// on a title that contains `<name>`; this walks the tag respecting quotes instead.
function buttonsOf(html) {
  const out = [];
  let i = 0;
  while ((i = html.indexOf('<button', i)) >= 0) {
    let j = i + 7, q = null;
    for (; j < html.length; j++) { const ch = html[j]; if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; }
    const attrs = html.slice(i + 7, j);
    const close = html.indexOf('</button>', j);
    const inner = close < 0 ? '' : html.slice(j + 1, close);
    out.push({ attrs, inner });
    i = close < 0 ? j + 1 : close + 9;
  }
  return out;
}

// ── the surfaces, from the code ───────────────────────────────────────────────
export function enumerateSurfaces({ app = APP, toolset = runToolset } = {}) {
  const out = new Map(); // id -> { kind, fingerprint, detail }
  // 1. tools — the union over modes and the gate flag; the fingerprint covers every distinct schema
  //    the tool is handed with AND the set of modes that offer it (a tool dropped from a mode is drift)
  const byTool = new Map();
  for (const mode of ['code', 'plan', 'ask']) for (const verify of [false, true]) {
    for (const t of toolset(mode, { verify })) {
      const n = t.function.name;
      const e = byTool.get(n) || { modes: new Set(), schemas: new Set() };
      e.modes.add(mode + (verify ? '+gate' : ''));
      e.schemas.add(JSON.stringify(t));
      byTool.set(n, e);
    }
  }
  for (const [n, e] of byTool) out.set(`tool:${n}`, { kind: 'tool', fingerprint: fp([...e.schemas].sort().join('\n') + '|' + [...e.modes].sort().join(' ')), detail: [...e.modes].join(' ') });
  // 2. the test door — window.__anvil.test's keys, read out of the block that assigns them
  const doorStart = app.indexOf('test: Object.assign((window.__anvil&&window.__anvil.test)||{}, {');
  if (doorStart < 0) throw new Error('the __anvil.test block was not found in apps/anvil/index.html');
  const doorEnd = app.indexOf('\n  }) });', doorStart);
  const door = app.slice(doorStart, doorEnd);
  // Keys at the block's own indentation (four spaces), `name:` or method syntax `name(`. The block
  // markers above are exact text on purpose: a moved or reworded door FAILS this check loudly
  // rather than enumerating nothing.
  const keyRe = /^    ([A-Za-z_$][\w$]*)\s*[:(]/gm;
  const keys = [...door.matchAll(keyRe)];
  keys.forEach((m, i) => {
    const name = m[1];
    const body = door.slice(m.index, i + 1 < keys.length ? keys[i + 1].index : undefined);
    const code = body.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // a comment-only edit is not drift
    out.set(`hook:${name}`, { kind: 'hook', fingerprint: fp(code), detail: '__anvil.test.' + name });
  });
  // 3. workspace files — every `.anvil/...` literal (any quote) in the app or ANY module under sys/ai
  //    and sys/history; a path built by concatenation starts from one of these roots
  const files = new Set();
  const sources = [app];
  for (const dir of ['sys/ai', 'sys/history']) {
    const d = join(ROOT, dir);
    if (!existsSync(d)) continue;
    // a bench's fixture (bench-*.mjs seeds a gate file into its OWN workspace) is not a path the app reads
    for (const f of readdirSync(d)) if (f.endsWith('.mjs') && !f.startsWith('bench-')) sources.push(readFileSync(join(d, f), 'utf8'));
  }
  for (const s of sources) for (const m of s.matchAll(/['"\`](\.anvil\/[\w./-]+)['"\`]/g)) files.add(m[1]);
  for (const f of [...files].sort()) out.set(`file:${f}`, { kind: 'file', fingerprint: fp(f), detail: f });
  // 4. the ⋯ sheet's actions and the header's buttons — the UI command surface
  //    a sheet row: its whole text, tags stripped (the icon span used to hide the label); a
  //    duplicate action is drift, not a silent merge
  for (const b of buttonsOf(app)) {
    if (!/\bclass="[^"]*\bsheet-row\b/.test(b.attrs)) continue;
    const act = (b.attrs.match(/data-act="([^"]+)"/) || [])[1];
    if (!act) continue;
    const text = b.inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const id = `sheet:${act}`;
    if (out.has(id)) { out.set(id, { ...out.get(id), fingerprint: fp('DUPLICATE ' + text), detail: 'DUPLICATE sheet row: ' + act }); continue; }
    out.set(id, { kind: 'sheet', fingerprint: fp(text), detail: text });
  }
  //    a header button: its title (or aria-label) AND its text, so an untitled button is still told
  //    apart by what it says; a duplicate id is drift. A static button with NO id is a command too
  //    (the mobile bar's, the switcher's tabs): keyed by its data-surface or its first class.
  for (const b of buttonsOf(app)) {
    const attrs = b.attrs;
    if (/\bclass="[^"]*\bsheet-row\b/.test(attrs)) continue; // the sheet's rows are enumerated above
    let id = (attrs.match(/\sid="([^"]+)"/) || [])[1];
    if (!id) {
      const surface = (attrs.match(/data-surface="([^"]+)"/) || [])[1];
      const cls = (attrs.match(/\bclass="([^"]+)"/) || [''])[1].split(/\s+/)[0];
      if (surface) id = 'tab-' + surface; else if (cls) id = '.' + cls; else continue;
    }
    const title = (attrs.match(/title="([^"]*)"/) || [])[1] || (attrs.match(/aria-label="([^"]*)"/) || [])[1] || '';
    const text = b.inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const key = `button:${id}`;
    if (out.has(key)) { out.set(key, { ...out.get(key), fingerprint: fp('DUPLICATE ' + title + '|' + text), detail: 'DUPLICATE button id: ' + id }); continue; }
    out.set(key, { kind: 'button', fingerprint: fp(title + '|' + text), detail: title || text });
  }
  return out;
}

// ── the inventory on disk ─────────────────────────────────────────────────────
function loadInventory() {
  if (!existsSync(INVENTORY)) return { version: 1, surfaces: {} };
  const inv = JSON.parse(readFileSync(INVENTORY, 'utf8'));
  if (inv.version !== 1) throw new Error(`verify/anvil/inventory.json is version ${inv.version}; this check reads version 1 — rewrite it with --write`);
  return inv;
}

// A recipe owns a surface when its file has a `### <surface id>` heading — outside a fenced block.
function recipeHas(file, id, features = FEATURES) {
  const p = join(features, file);
  if (!existsSync(p)) return 'missing-file';
  const text = readFileSync(p, 'utf8').replace(/```[\s\S]*?```/g, '');
  const escaped = id.replace(/[.*+?^${}()|[\]\\/]/g, (c) => '\\' + c);
  return new RegExp('^### ' + escaped + '\\s*$', 'm').test(text) ? 'ok' : 'missing-heading';
}

export function check({ surfaces = enumerateSurfaces(), inventory = loadInventory(), features = FEATURES } = {}) {
  const problems = [];
  const inv = inventory.surfaces || {};
  for (const [id, s] of surfaces) {
    const e = inv[id];
    if (!e) { problems.push(`no owner: ${id} (${s.kind}: ${s.detail})`); continue; }
    if (!e.owner) { problems.push(`owner missing: ${id}`); continue; }
    const has = recipeHas(e.owner, id, features);
    if (has === 'missing-file') problems.push(`recipe file missing: ${id} → ${e.owner}`);
    else if (has === 'missing-heading') problems.push(`recipe has no "### ${id}" heading: ${e.owner}`);
    if (e.fingerprint !== s.fingerprint) problems.push(`changed: ${id} (${e.fingerprint} → ${s.fingerprint}) — review ${e.owner}, then --write`);
  }
  for (const id of Object.keys(inv)) if (!surfaces.has(id)) problems.push(`stale: ${id} is in the inventory but no longer in the code`);
  // a recipe heading that names no surface is an orphan — a surface that vanished leaves its recipe
  // behind otherwise, and the map grows sections nothing can reach
  if (existsSync(features)) for (const f of readdirSync(features)) {
    if (!f.endsWith('.md')) continue;
    const text = readFileSync(join(features, f), 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/^### (\S+)\s*$/gm)) if (!surfaces.has(m[1])) problems.push(`orphan recipe: ${f} ### ${m[1]} names no surface in the code`);
  }
  return { ok: problems.length === 0, problems, counted: surfaces.size };
}

export function writeInventory({ surfaces = enumerateSurfaces(), inventory = loadInventory(), path = INVENTORY } = {}) {
  const prev = inventory.surfaces || {};
  const next = {};
  for (const [id, s] of [...surfaces].sort(([a], [b]) => a.localeCompare(b))) {
    next[id] = { owner: (prev[id] && prev[id].owner) || null, fingerprint: s.fingerprint, kind: s.kind, detail: s.detail };
  }
  const diff = [];
  for (const id of Object.keys(next)) {
    if (!prev[id]) diff.push(`+ ${id}`);
    else if (prev[id].fingerprint !== next[id].fingerprint) diff.push(`~ ${id} (${prev[id].fingerprint} → ${next[id].fingerprint})`);
  }
  for (const id of Object.keys(prev)) if (!next[id]) diff.push(`- ${id}`);
  writeFileSync(path, JSON.stringify({ version: 1, surfaces: next }, null, 2) + '\n');
  return { diff, count: Object.keys(next).length, unowned: Object.keys(next).filter((id) => !next[id].owner) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes('--write')) {
    const r = writeInventory();
    console.log(`verify-inventory: wrote ${r.count} surfaces to verify/anvil/inventory.json`);
    for (const d of r.diff) console.log('  ' + d);
    if (!r.diff.length) console.log('  (no change)');
    const c = check();
    if (!c.ok) { console.log(`\n${c.problems.length} surface(s) still need an owner or a recipe:`); for (const p of c.problems) console.log('  ' + p); process.exit(1); }
  } else {
    const c = check();
    if (c.ok) { console.log(`verify-inventory: ${c.counted} surfaces, every one owned by a recipe that names it, no fingerprint changed`); process.exit(0); }
    console.error(`verify-inventory: DRIFT — ${c.problems.length} problem(s) over ${c.counted} surfaces:`);
    for (const p of c.problems) console.error('  ' + p);
    console.error('\nAdd or update the recipe, then `node scripts/verify-inventory.mjs --write`. Never rebaseline a red you have not read.');
    process.exit(1);
  }
}
