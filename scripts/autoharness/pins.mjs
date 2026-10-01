// Pins for an accepted harness edit — written at commit time, read back as literals by the tests.
//
// Three things in the repo hold the harness's text byte-for-byte, so a deliberate edit has to say so:
//   sys/ai/test/prompt-pins.json      span pins applied to the e870f0b fixture (scripts/test-run-assembly.mjs)
//   sys/ai/test/procedural-golden.json the default procedural render (scripts/test-anvil-procedural.mjs)
//   verify/anvil/inventory.json       tool-schema fingerprints (scripts/verify-inventory.mjs)
// `snapshot` reads the harness text in a child process (a fresh module graph — the parent may already
// hold the old one), `derivePins` turns two snapshots into literal before→after spans, `writePins`
// records them. Every other test that pins harness text stays as it is: if the edit breaks one, the
// round's gate goes red and the candidate is rejected.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MODES = ['code', 'plan', 'ask'];
export const PIN_FILES = Object.freeze(['sys/ai/test/prompt-pins.json', 'sys/ai/test/procedural-golden.json', 'verify/anvil/inventory.json']);

// The harness text as the tests see it, from the repo at `repo`.
export function snapshot(repo) {
  const src = `
    const ra = await import(${JSON.stringify(join(repo, 'sys/ai/run-assembly.mjs'))});
    const pr = await import(${JSON.stringify(join(repo, 'sys/ai/procedural.mjs'))});
    const prompts = Object.fromEntries(${JSON.stringify(MODES)}.map((m) => [m, ra.systemMessage({ mode: m }).content]));
    console.log(JSON.stringify({ prompts, actNudge: ra.ACT_NUDGE, gateNote: { 'npm test': ra.gateNote('npm test') }, procedural: pr.renderProcedural() }));`;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', src], { cwd: repo, encoding: 'utf8' }));
}

const count = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);
// The smallest word-aligned span that turns `a` into `b`, widened until `before` occurs exactly once
// in `a` — the test replaces it by search, so an ambiguous span would pin the wrong place.
export function spanOf(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  let start = p, endA = a.length - s, endB = b.length - s;
  const left = () => { if (start > 0) start--; while (start > 0 && a[start - 1] !== ' ') start--; };
  const right = () => { if (endA < a.length) { endA++; endB++; } while (endA < a.length && a[endA] !== ' ') { endA++; endB++; } };
  while (start > 0 && a[start - 1] !== ' ') start--;
  while (endA < a.length && a[endA] !== ' ') { endA++; endB++; }
  while ((endA === start || count(a, a.slice(start, endA)) !== 1) && (start > 0 || endA < a.length)) { left(); right(); }
  return { before: a.slice(start, endA), after: b.slice(start, endB) };
}

// Literal pins for every changed target, one per distinct (before, after) — a span shared by all
// three modes is one pin listing the three.
export function derivePins(oldSnap, newSnap, { id, why }) {
  const pins = [];
  const byKey = new Map();
  for (const m of MODES) {
    if (oldSnap.prompts[m] === newSnap.prompts[m]) continue;
    const sp = spanOf(oldSnap.prompts[m], newSnap.prompts[m]);
    const key = JSON.stringify(sp);
    if (byKey.has(key)) byKey.get(key).modes.push(m);
    else { const pin = { id: `${id}-prompt-${byKey.size + 1}`, target: 'prompts', modes: [m], why, ...sp }; byKey.set(key, pin); pins.push(pin); }
  }
  if (oldSnap.actNudge !== newSnap.actNudge) pins.push({ id: `${id}-act-nudge`, target: 'actNudge', why, ...spanOf(oldSnap.actNudge, newSnap.actNudge) });
  if (oldSnap.gateNote['npm test'] !== newSnap.gateNote['npm test']) pins.push({ id: `${id}-gate-note`, target: 'gateNote', why, ...spanOf(oldSnap.gateNote['npm test'], newSnap.gateNote['npm test']) });
  return pins;
}

// Record the pins, the new procedural golden and — when the only drift is tool-schema fingerprints —
// the rebaselined inventory. Returns what changed, for the commit message and the ledger.
export function writePins(repo, oldSnap, newSnap, { id, why }) {
  const out = { pins: [], procedural: false, inventory: [], inventoryProblems: [] };
  const pinsPath = join(repo, 'sys/ai/test/prompt-pins.json');
  const file = JSON.parse(readFileSync(pinsPath, 'utf8'));
  out.pins = derivePins(oldSnap, newSnap, { id, why });
  if (out.pins.length) { file.pins.push(...out.pins); writeFileSync(pinsPath, JSON.stringify(file, null, 2) + '\n'); }
  if (oldSnap.procedural !== newSnap.procedural) {
    const gPath = join(repo, 'sys/ai/test/procedural-golden.json');
    const g = JSON.parse(readFileSync(gPath, 'utf8'));
    g.render = newSnap.procedural;
    writeFileSync(gPath, JSON.stringify(g, null, 2) + '\n');
    out.procedural = true;
  }
  const inv = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const v = await import(${JSON.stringify(join(repo, 'scripts/verify-inventory.mjs'))});
    const c = v.check();
    const onlyTools = !c.ok && c.problems.every((p) => /^changed: tool:/.test(p));
    console.log(JSON.stringify({ problems: c.problems, diff: onlyTools ? v.writeInventory().diff : [] }));`], { cwd: repo, encoding: 'utf8' }));
  out.inventory = inv.diff;
  out.inventoryProblems = inv.diff.length ? [] : inv.problems;
  return out;
}
