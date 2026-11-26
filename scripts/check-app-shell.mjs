#!/usr/bin/env node
// check-app-shell.mjs — the app shell's agent-surface check (docs/specs/app-shell-001.md section 6.3).
// Fails when an app that mounts the shell has a commands.json that lacks a standard file command, misses the key
// the standard assigns to it, or binds a core file key to another command. The core keys come from the shell's own
// CORE_KEYS (sdk/app-shell.js), so the check and the shell cannot disagree.
//
//   node scripts/check-app-shell.mjs                       every mirrored app under apps/ that vendors the shell
//   node scripts/check-app-shell.mjs --commands commands.json [--shell app-shell.js|https://naklios.dev/sdk/app-shell.js]
//                                                          one app (its own CI; the shell defaults to naklios.dev)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };

// The file commands every shell app publishes (the shell implements them), and the ones the app may add.
export const REQUIRED = ['file.new', 'file.open', 'file.save', 'file.save_as'];
export const FILE_COMMANDS = ['file.new', 'file.open', 'file.save', 'file.save_as', 'file.print'];

// CORE_KEYS from the shell source: { name: [keys] }. `isMac ? 'Ctrl+H' : 'Mod+H'` counts both keys.
export function coreKeys(shellSource) {
  const block = shellSource.match(/var CORE_KEYS = \[([\s\S]*?)\];/);
  if (!block) throw new Error('CORE_KEYS not found in the shell source');
  const out = {};
  for (const m of block[1].matchAll(/name:\s*'([^']+)',\s*keys:\s*\[([^\]]*)\]/g)) out[m[1]] = [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  if (!out['file.save']) throw new Error('CORE_KEYS has no file.save');
  return out;
}

const keysOf = (c) => (Array.isArray(c?.shortcut) ? c.shortcut : c?.shortcut ? [c.shortcut] : []);

// Problems in one app's commands.json (parsed), as plain sentences.
export function checkCommands(manifest, core) {
  const list = Array.isArray(manifest) ? manifest : manifest?.commands || [];
  const byName = new Map(list.map((c) => [c.name, c]));
  const problems = [];
  for (const n of REQUIRED) if (!byName.has(n)) problems.push(`lacks the standard command ${n}`);
  for (const n of FILE_COMMANDS) {
    const c = byName.get(n), want = core[n]?.[0];
    if (!c || !want) continue;
    if (!keysOf(c).includes(want)) problems.push(`${n} misses the standard key ${want} (has ${keysOf(c).join(', ') || 'none'})`);
  }
  const fileKeys = new Map(FILE_COMMANDS.flatMap((n) => (core[n] || []).map((k) => [k, n])));
  for (const c of list) for (const k of keysOf(c)) {
    const owner = fileKeys.get(k);
    // An old name kept as an alias for one release (spec 6.3) says so in its description and may share the key.
    const alias = new RegExp(`\\(alias of ${String(owner).replace('.', '\\.')}\\)`).test(c.description || '');
    if (owner && owner !== c.name && !alias) problems.push(`${c.name} binds ${k}, the core key of ${owner}`);
  }
  return problems;
}

async function readSource(where) {
  if (/^https?:/.test(where)) { const r = await fetch(where); if (!r.ok) throw new Error(`${where}: HTTP ${r.status}`); return r.text(); }
  return readFileSync(where, 'utf8');
}

async function main() {
  const one = opt('commands');
  const shellPath = opt('shell') || (one ? 'https://naklios.dev/sdk/app-shell.js' : join(ROOT, 'sdk/app-shell.js'));
  const core = coreKeys(await readSource(shellPath));
  const targets = one
    ? [{ id: one, file: one }]
    : readdirSync(join(ROOT, 'apps'), { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => ({ id: d.name, dir: join(ROOT, 'apps', d.name) }))
      .filter((a) => existsSync(join(a.dir, 'index.html')) && readFileSync(join(a.dir, 'index.html'), 'utf8').includes('naklios-app-shell:begin'))
      .map((a) => ({ id: a.id, file: join(a.dir, 'commands.json') }));
  let failed = 0;
  for (const t of targets) {
    if (!existsSync(t.file)) { console.log(`FAIL ${t.id}: no commands.json`); failed++; continue; }
    const problems = checkCommands(JSON.parse(readFileSync(t.file, 'utf8')), core);
    if (problems.length) { failed++; console.log(`FAIL ${t.id}:\n  - ${problems.join('\n  - ')}`); } else console.log(`ok   ${t.id}`);
  }
  console.log(`check-app-shell: ${targets.length - failed} of ${targets.length} apps pass`);
  if (!targets.length) { console.log('check-app-shell: no app vendors the shell'); process.exit(1); }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((e) => { console.error(`check-app-shell: ${e.message}`); process.exit(1); });
