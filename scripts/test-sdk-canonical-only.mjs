// One SDK, the canonical one (docs/app-contract.md, "Rule: one SDK"). Every mirrored app reaches the
// host only through sdk/naklios.js, unedited. This test scans each file of each mirrored app, removes
// the canonical SDK (a file that equals it, or the region between the naklios-sdk markers), and fails
// when what is left defines window.naklios or names a naklios:* protocol message. Those are the marks of
// a private SDK, which misses every later host change (Draft and Reckon missed the 2026-11-10
// storage-prompt fix this way).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const canonical = await readFile(new URL('sdk/naklios.js', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('apps/manifest.json', root), 'utf8'));
const MARKED = /\/\*\s*naklios-sdk:begin\b[^*]*\*\/[\s\S]*?\/\*\s*naklios-sdk:end\s*\*\//g;

// Apps still on a private SDK, each waiting to be converted in its own repo. The list only shrinks:
// the test fails when a listed app is clean, so remove it here when its conversion lands.
const WAITING = {
  draft: 'own window.naklios copy (NakliTechie/draft)',
  reckon: 'loads the canonical SDK, then replaces window.naklios with its own copy (NakliTechie/reckon)',
  slate: "posts naklios:ready by hand to '*' instead of calling naklios.ready()",
};

function privateSdkMarks(text) {
  if (text.trim() === canonical.trim()) return [];
  const rest = text.replace(MARKED, '');
  const marks = [];
  for (const m of rest.matchAll(/\b(?:window|globalThis|self)\.naklios\s*=(?!=)/g)) marks.push(m[0]);
  for (const m of rest.matchAll(/['"`]naklios:[a-z][\w:-]*['"`]/g)) marks.push(m[0]);
  return marks;
}

const offenders = new Map();
for (const app of manifest.apps) {
  for (const file of app.files) {
    if (!/\.(html?|m?js)$/i.test(file.destination)) continue;
    const text = await readFile(new URL(`apps/${app.id}/${file.destination}`, root), 'utf8');
    const marks = privateSdkMarks(text);
    if (marks.length) offenders.set(app.id, [...(offenders.get(app.id) || []), `${file.destination}: ${[...new Set(marks)].slice(0, 4).join(', ')}`]);
  }
}

// Self-test: the detector catches the patterns it exists for and passes the canonical forms.
assert.deepEqual(privateSdkMarks(canonical), [], 'the canonical file is clean');
assert.deepEqual(privateSdkMarks(`<script>/* naklios-sdk:begin ver=2 */${canonical}/* naklios-sdk:end */</script>`), [], 'a marked inline copy is clean');
assert.deepEqual(privateSdkMarks('const NAK = (typeof window.naklios === "object") ? window.naklios : null; NAK.ready();'), [], 'reading window.naklios is clean');
assert.equal(privateSdkMarks('window.naklios = { ready(){} };').length, 1, 'a private window.naklios is caught');
assert.equal(privateSdkMarks("parent.postMessage({ type: 'naklios:ready' }, '*');").length, 1, 'a hand-posted protocol message is caught');

const unlisted = [...offenders].filter(([id]) => !(id in WAITING));
assert.deepEqual(unlisted, [], `mirrored apps on a private SDK; use sdk/naklios.js unedited (docs/app-contract.md):\n${unlisted.map(([id, f]) => `  ${id}: ${f.join('; ')}`).join('\n')}`);
const converted = Object.keys(WAITING).filter(id => !offenders.has(id));
assert.deepEqual(converted, [], `now on the canonical SDK; remove from WAITING in scripts/test-sdk-canonical-only.mjs: ${converted.join(', ')}`);

console.log(`sdk-canonical-only: ${manifest.apps.length} mirrored apps scanned; ${offenders.size} waiting for conversion (${Object.keys(WAITING).join(', ')}), no new private SDK`);
