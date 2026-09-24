// Guards the belief-revision wiring in Anvil.
//
// sys/ai/memory-store.mjs implements hypothesis/verified/retracted facts and is
// unit-tested, but the app dropped `status` when reading fact files into the
// index — so buildMemoryIndex saw `status === undefined` on every fact, the
// `f.status !== 'retracted'` filter kept every disproven fact in the injected
// context, and neither the hypothesis tag nor the "do not re-derive" footer
// could ever render. The pure module passing its own tests did not catch it:
// the defect lived entirely in the two call sites.
//
// Grep-based, like the other app-contract tests. It pins the seam, not the shape.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildMemoryIndex, parseFact } from '../sys/ai/memory-store.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// Both readers must carry status through. Neither may push a fact object that
// stops at `type:` — that is exactly the shape of the original defect.
const pushes = [...anvil.matchAll(/(?:facts|out)\.push\(\{[^}]*description:\s*f\.description[^}]*\}\)/g)].map(m => m[0]);
assert.equal(pushes.length, 2, `expected 2 fact-index push sites, found ${pushes.length}`);
for (const p of pushes) {
  assert.match(p, /status:\s*f\.status/, `a fact-index push drops status (the retraction filter goes dead): ${p}`);
  // A1: relations (supersedes / derived_from / contradicts / slot) must ride along
  // too — buildMemoryIndex orders a successor above what it supersedes and tags the
  // stale row; a push that enumerates fields drops them exactly as status was dropped.
  assert.match(p, /\.\.\.f\b/, `a fact-index push drops the relations (supersession never renders): ${p}`);
}
// And the write side can create a related fact: the remember tool offers the relations
// and the handler passes them through to recordFact.
assert.match(anvil, /recordFact\(note, ar&&ar\.type, 'hypothesis', \{ slot: ar&&ar\.slot, derived_from: ar&&ar\.derived_from, supersedes: ar&&ar\.supersedes, weight: ar&&ar\.weight \}\)/, 'the remember handler passes slot/derived_from/supersedes/weight to recordFact');
assert.match(anvil, /slotHolder\(await listFacts\(\), r\.slot\)/, 'a slot supersedes its current holder at write time');
// A2: search before save on BOTH remember paths (task loop + prime), and one budget per run.
assert.equal((anvil.match(/findDuplicate\(all, note, \{ (?:exempt, )?scope: [^}]*\}\); if\(dup\)[\s\S]{0,80}?return duplicateReply\(dup\)/g) || []).length, 2, 'both remember paths search before they save, scoped to this task (main path also audits the refusal)');
// shape, not signature: checkRulesCap takes an options arg (the prospective rule's name/status)
assert.equal((anvil.match(/checkRulesCap\(all, note[^;]*\); if\(!cap\.ok\)[\s\S]{0,120}?return rulesCapReply\(cap\)/g) || []).length, 2, 'both remember paths cap rules');
assert.equal((anvil.match(/checkRulesCap\(all, note, \{ name: nextFreeSlug\(noteToFact\(note, 'rule', 'hypothesis'\)\.slug, all\.map\(f=>f\.name\)\)/g) || []).length, 2, 'the cap measures the rule as it will be STORED — its real (collision-suffixed) name and its status (S5)');
assert.match(anvil, /exempt=\[ar&&ar\.supersedes, ar&&ar\.slot\?slotHolder\(all, ar\.slot\):null\]/, 'a declared replacement is exempt from the duplicate check (the correction exit)');
assert.match(anvil, /const remBudget=createRememberBudget\(\);[\s\S]{0,900}?const executeTool = async/, 'the remember budget is created once per run, just above the executor');
assert.match(anvil, /const take=remBudget\.take\(\); if\(!take\.ok\)[\s\S]{0,80}?return budgetSpentReply\(take\)/, 'the remember handler spends the budget and refuses when it is gone');

// The memory panel must SHOW a retracted fact rather than listing it as live —
// retract visibly, never silently delete.
assert.match(anvil, /RETRACTED/, 'the memory panel marks retracted facts');
assert.match(anvil, /mark\(f\.status\)/, 'the panel renders each fact with its status marker');

// And the contract the app depends on still holds in the pure module: a fact
// carrying status:'retracted' is excluded and counted in the footer.
const retracted = parseFact('---\nname: dead-idea\ndescription: disproven\ntype: project\nstatus: retracted\n---\nbody\n');
assert.equal(retracted.status, 'retracted', 'parseFact surfaces status');
const live = parseFact('---\nname: good\ndescription: holds\ntype: project\nstatus: hypothesis\n---\nbody\n');

const index = buildMemoryIndex([
  { name: live.name, description: live.description, type: live.type, status: live.status },
  { name: retracted.name, description: retracted.description, type: retracted.type, status: retracted.status },
]);
assert.ok(!index.includes('dead-idea'), 'a retracted fact never reaches the injected index');
assert.match(index, /hypothesis — verify or retract/, 'a hypothesis is tagged as provisional');
assert.match(index, /1 fact\(s\) were retracted \(disproven\) and hidden/, 'the agent is told retracted facts exist');

// The regression itself: dropping status re-admits the retracted fact.
const dropped = buildMemoryIndex([
  { name: retracted.name, description: retracted.description, type: retracted.type },
]);
assert.ok(dropped.includes('dead-idea'),
  'sanity: without status the filter cannot engage — which is why the app must pass it');

// B5: recall pages a long fact to the budget (unknown budget → a safe fixed cap), refusing an
// offset past the end; a refused memory write leaves a content-free audit row (hash + category).
assert.match(anvil, /const cap=bud\.usable \? Math\.min\(8000, Math\.max\(1000, bud\.remaining\*4\)\) : 4000/, 'recall pages to the budget, else a fixed cap');
assert.match(anvil, /recall: offset .* is past the end/, 'an offset past the end is refused, not a silent empty read');
assert.match(anvil, /function auditRefusal\(category, note\)/, 'a refused write leaves a content-free audit row');
assert.match(anvil, /'memory write refused \['\+category\+'\] · '\+shortHash\(note\)/, 'the audit row is a hash + category, never the note text');
assert.equal((anvil.match(/auditRefusal\(/g) || []).length, 4, 'the audit fires at each refusal site (3 in the handler + the definition)');

console.log('anvil-memory-status: belief revision is wired through to the app');
