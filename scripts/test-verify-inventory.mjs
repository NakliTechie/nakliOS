#!/usr/bin/env node
// The drift check's own teeth: a surface added to the app turns it red; a recipe whose owner names a
// surface that no longer exists turns it red; a changed definition turns it red; --write then green.
// Runs against a COPY of the repo's verify/ folder and a mutated app string — never the real files.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enumerateSurfaces, check, writeInventory } from './verify-inventory.mjs';
import { runToolset } from '../sys/ai/run-assembly.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const app = readFileSync(join(ROOT, 'apps/anvil/index.html'), 'utf8');
const inventory = JSON.parse(readFileSync(join(ROOT, 'verify/anvil/inventory.json'), 'utf8'));
let n = 0;

// 1. the real tree is green, and the enumeration is from the code, not a list
const surfaces = enumerateSurfaces({ app });
assert.deepEqual([...surfaces.keys()].sort(), Object.keys(inventory.surfaces).sort(), 'the enumerated set IS the inventory\'s key set — nothing missing, nothing extra');
for (const id of ['tool:read', 'tool:task_done', 'tool:skill', 'hook:armGate', 'hook:fs', 'file:.anvil/gate', 'file:.anvil/hooks.json', 'sheet:policy', 'button:send', 'button:mode-btn']) assert.ok(surfaces.has(id), `enumerates ${id}`);
assert.equal(surfaces.get('tool:task_done').detail, 'code+gate', 'task_done is offered only with a gate, in code mode');
assert.match(surfaces.get('tool:skill').detail, /code .*plan .*ask/, 'skill is offered in every mode');
const green = check({ surfaces, inventory });
assert.equal(green.ok, true, `the real tree is green: ${green.problems.join(' | ')}`);
n++;

// 2. a surface added to the app → red, naming it
{
  const mutated = app.replace('<button class="icon" id="new-project" title="New project">＋</button>', '<button class="icon" id="new-project" title="New project">＋</button><button class="icon" id="magic-btn" title="Do magic">✨</button>');
  const s = enumerateSurfaces({ app: mutated });
  assert.ok(s.has('button:magic-btn'), 'the new button is enumerated');
  const r = check({ surfaces: s, inventory });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /no owner: button:magic-btn/.test(p)), `names the unowned surface: ${r.problems.join(' | ')}`);
  n++;
}
// 3. a new test-door hook → red
{
  const mutated = app.replace("    taskState:()=>{", "    magicHook:()=>1,\n    taskState:()=>{");
  const s = enumerateSurfaces({ app: mutated });
  assert.ok(s.has('hook:magicHook'), 'the new hook is enumerated');
  assert.ok(!check({ surfaces: s, inventory }).ok, 'a new hook is drift');
  n++;
}
// 4. a changed definition (a button's title) → red as "changed", pointing at the recipe
{
  const mutated = app.replace('title="Toggle preview"', 'title="Toggle the preview pane"');
  const s = enumerateSurfaces({ app: mutated });
  const r = check({ surfaces: s, inventory });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /^changed: button:toggle-preview .*review header\.md/.test(p)), `a changed title asks for a recipe review: ${r.problems.join(' | ')}`);
  n++;
}
// 5. a surface removed from the app → the inventory entry is stale → red
{
  const mutated = app.replace('<button class="icon" id="refresh-files" title="Refresh">', '<span>');
  const s = enumerateSurfaces({ app: mutated });
  const r = check({ surfaces: s, inventory });
  assert.ok(r.problems.some((p) => /^stale: button:refresh-files/.test(p)), `a vanished surface is stale: ${r.problems.join(' | ')}`);
  n++;
}
// 6. an owner without a recipe heading, and an owner whose file is missing → red
{
  const inv = JSON.parse(JSON.stringify(inventory));
  inv.surfaces['tool:read'].owner = 'header.md'; // the file exists, the heading does not
  const r = check({ surfaces, inventory: inv });
  assert.ok(r.problems.some((p) => /no "### tool:read" heading: header\.md/.test(p)), `a mis-owned surface: ${r.problems.join(' | ')}`);
  inv.surfaces['tool:read'].owner = 'nope.md';
  assert.ok(check({ surfaces, inventory: inv }).problems.some((p) => /recipe file missing: tool:read/.test(p)), 'a missing recipe file');
  n++;
}
// 7. a tool schema change (the definition the model sees) → red, through the real enumeration
{
  const reworded = (mode, o) => runToolset(mode, o).map((tl) => tl.function.name === 'read' ? { ...tl, function: { ...tl.function, description: tl.function.description + ' (reworded)' } } : tl);
  const s = enumerateSurfaces({ app, toolset: reworded });
  const r = check({ surfaces: s, inventory });
  assert.ok(r.problems.some((p) => /^changed: tool:read/.test(p)), `a reworded tool description is drift: ${r.problems.join(' | ')}`);
  assert.ok(!r.problems.some((p) => /^changed: tool:edit/.test(p)), 'and only that tool');
  // a tool dropped from one mode is drift too, with the same schema
  const noPlanRead = (mode, o) => runToolset(mode, o).filter((tl) => !(mode === 'plan' && tl.function.name === 'read'));
  const s2 = enumerateSurfaces({ app, toolset: noPlanRead });
  assert.ok(check({ surfaces: s2, inventory }).problems.some((p) => /^changed: tool:read/.test(p)), 'a tool removed from a mode is drift');
  n++;
}
// 8. --write, for real, on a temp path: the diff names the change, owners are carried, and a new
//    surface stays UNOWNED — so the check after a rebaseline is still red until a recipe owns it
{
  const dir = mkdtempSync(join(tmpdir(), 'verify-inv-'));
  try {
    const path = join(dir, 'inventory.json');
    const mutatedApp = app.replace('title="Toggle preview"', 'title="Toggle the preview pane"').replace('<button class="icon" id="new-project" title="New project">＋</button>', '<button class="icon" id="new-project" title="New project">＋</button><button class="icon" id="magic-btn" title="Do magic">✨</button>');
    const s = enumerateSurfaces({ app: mutatedApp });
    const w = writeInventory({ surfaces: s, inventory, path });
    assert.ok(w.diff.includes('+ button:magic-btn'), `the addition is printed: ${w.diff.join(' | ')}`);
    assert.ok(w.diff.some((d) => /^~ button:toggle-preview/.test(d)), 'the changed title is printed');
    assert.deepEqual(w.unowned, ['button:magic-btn'], 'the new surface has no owner');
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.surfaces['button:toggle-preview'].owner, 'header.md', 'owners are carried through');
    assert.equal(written.surfaces['button:magic-btn'].owner, null);
    const after = check({ surfaces: s, inventory: written });
    assert.equal(after.ok, false, 'still red: the new surface is unowned');
    assert.ok(after.problems.some((p) => /owner missing: button:magic-btn/.test(p)), after.problems.join(' | '));
    assert.ok(!after.problems.some((p) => /changed:/.test(p)), 'and the reviewed change is no longer drift');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  n++;
}
// 9. every recipe file has the six fields for every heading it owns
{
  const fields = ['Goal', 'Source', 'Prerequisites', 'Reach and drive', 'Observable success', 'Gotchas'];
  const files = new Set(Object.values(inventory.surfaces).map((e) => e.owner));
  for (const f of files) {
    const text = readFileSync(join(ROOT, 'verify/anvil/features', f), 'utf8');
    const sections = text.split(/^### /m).slice(1);
    for (const sec of sections) {
      const id = sec.split('\n')[0].trim();
      for (const k of fields) assert.ok(new RegExp('\\*\\*' + k + ':\\*\\*').test(sec), `${f} ### ${id} has ${k}`);
    }
  }
  assert.ok(existsSync(join(ROOT, 'verify/anvil/README.md')), 'the map has a README with the shared launch');
  n++;
}
// 10. a `### surface` inside a fenced code block does not own the surface
{
  const dir = mkdtempSync(join(tmpdir(), 'verify-inv-feat-'));
  try {
    writeFileSync(join(dir, 'x.md'), '# x\n\n```\n### tool:read\n```\n');
    const inv = { version: 1, surfaces: { 'tool:read': { owner: 'x.md', fingerprint: surfaces.get('tool:read').fingerprint } } };
    const r = check({ surfaces: new Map([['tool:read', surfaces.get('tool:read')]]), inventory: inv, features: dir });
    assert.ok(r.problems.some((p) => /no "### tool:read" heading: x\.md/.test(p)), `a fenced heading is not ownership: ${r.problems.join(' | ')}`);
    writeFileSync(join(dir, 'x.md'), '# x\n\n### tool:read\n- **Goal:** g\n');
    assert.equal(check({ surfaces: new Map([['tool:read', surfaces.get('tool:read')]]), inventory: inv, features: dir }).ok, true, 'a real heading is');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  n++;
}
// 13. a heading that merely STARTS with the surface id does not own it (anchored regex), and a heading
//     that names no surface is an orphan
{
  const dir = mkdtempSync(join(tmpdir(), 'verify-inv-feat2-'));
  try {
    writeFileSync(join(dir, 'x.md'), '# x\n\n### tool:readonly\n- **Goal:** g\n');
    const one = new Map([['tool:read', surfaces.get('tool:read')]]);
    const inv = { version: 1, surfaces: { 'tool:read': { owner: 'x.md', fingerprint: surfaces.get('tool:read').fingerprint } } };
    const r = check({ surfaces: one, inventory: inv, features: dir });
    assert.ok(r.problems.some((p) => /no "### tool:read" heading: x\.md/.test(p)), `a renamed heading does not own by prefix: ${r.problems.join(' | ')}`);
    assert.ok(r.problems.some((p) => /^orphan recipe: x\.md ### tool:readonly names no surface/.test(p)), `and the renamed heading is an orphan: ${r.problems.join(' | ')}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  n++;
}
// 14. a comment-only edit inside a test-door hook is not drift; a code edit is
{
  const commented = app.replace("    taskState:()=>{", "    // a new comment above the hook\n    taskState:()=>{");
  assert.notEqual(commented, app);
  assert.equal(check({ surfaces: enumerateSurfaces({ app: commented }), inventory }).ok, true, 'a comment above a hook is not drift');
  const recoded = app.replace("    taskState:()=>{", "    taskState:()=>{ void 0;");
  assert.ok(check({ surfaces: enumerateSurfaces({ app: recoded }), inventory }).problems.some((p) => /^changed: hook:taskState/.test(p)), 'a code edit in a hook is drift');
  n++;
}
// 15. the id-less commands are enumerated: the phone bar by class, the switcher tabs by data-surface
{
  for (const id of ['button:.mb-title', 'button:.mb-verify', 'button:.mb-stop', 'button:tab-chat', 'button:tab-preview', 'button:tab-files', 'button:.es-chip']) assert.ok(surfaces.has(id), `enumerates ${id}`);
  const extra = app.replace('<button class="mb-stop" style="display:none">◼ Stop</button>', '<button class="mb-stop" style="display:none">◼ Stop</button><button class="mb-extra">?</button>');
  assert.notEqual(extra, app);
  assert.ok(check({ surfaces: enumerateSurfaces({ app: extra }), inventory }).problems.some((p) => /no owner: button:\.mb-extra/.test(p)), 'a new id-less button is drift');
  n++;
}
// 12. a duplicate button id or sheet action is drift, not a silent overwrite
{
  const dup = app.replace('<button class="icon" id="new-project" title="New project">＋</button>', '<button class="icon" id="new-project" title="New project">＋</button><button class="icon" id="new-project" title="New project again">＋</button>');
  const s = enumerateSurfaces({ app: dup });
  assert.match(s.get('button:new-project').detail, /^DUPLICATE button id: new-project/, 'the duplicate is named');
  assert.ok(check({ surfaces: s, inventory }).problems.some((p) => /^changed: button:new-project/.test(p)), 'and it is drift');
  n++;
}
// 11. the button walker survives a title that contains a '>' — the one that broke a plain regex
{
  const s = enumerateSurfaces({ app });
  assert.match(s.get('button:skills-chip').detail, /^Project skills — \.anvil\/skills\/<name>\/SKILL\.md/, 'the skills chip title (with <name>) is read whole');
  assert.equal(s.get('button:send').detail, 'Send', 'an untitled button is identified by its text');
  assert.match(s.get('sheet:storage').detail, /Storage/, 'a sheet row\'s text survives its icon span');
  n++;
}
console.log(`verify-inventory: ${n} groups green — ${surfaces.size} surfaces enumerated from the code and equal to the inventory's set; an added surface, a new hook, a changed title, a vanished surface, a mis-owned recipe, a reworded or mode-dropped tool each go red; --write prints the change and leaves a new surface unowned; a fenced heading does not own; every recipe carries its six fields`);
