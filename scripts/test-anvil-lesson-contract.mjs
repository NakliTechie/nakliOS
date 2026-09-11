// Guards the lesson-layer contract and the rule-fact injection in Anvil (A3).
//
// The "lessons, not logs" contract is only useful if the model reads it where
// it decides to write memory: the `remember` tool's own description, and the system
// prompt of a code-mode run (the first `remember` of a project happens when the
// memory index is still empty, so the index header alone cannot carry it). Both
// call sites must quote the SAME constant, so the wording cannot drift. And rules —
// the one fact type injected in full — must reach the prompt with their bodies.
//
// Grep-based, like the other app-contract tests. It pins the seam, not the shape.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LESSON_CONTRACT, RULES_CAP_CHARS, MEMORY_TYPES, buildMemoryIndex, parseFact } from '../sys/ai/memory-store.mjs';
import { rememberTool } from '../sys/ai/project-context.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// The contract itself: one constant, non-trivial, says the load-bearing words.
assert.ok(typeof LESSON_CONTRACT === 'string' && LESSON_CONTRACT.length > 80, 'LESSON_CONTRACT is a real sentence set');
assert.match(LESSON_CONTRACT, /lessons?, not logs/i, 'the contract names itself: lessons, not logs');
assert.match(LESSON_CONTRACT, /next time/i, 'a lesson says what to do differently next time');

// Call site 1: the remember tool quotes it verbatim.
const desc = rememberTool().function.description;
assert.ok(desc.includes(LESSON_CONTRACT), 'the remember tool description carries the lesson-layer contract verbatim');
assert.ok(rememberTool().function.parameters.properties.type.enum.includes('rule'), 'the remember tool can record a rule');

// Call site 2: the code-mode system prompt is assembled with the constant, not a paraphrase.
assert.match(anvil, /import \{[^}]*\bLESSON_CONTRACT\b[^}]*\} from '\.\.\/\.\.\/sys\/ai\/memory-store\.mjs'/, 'Anvil imports LESSON_CONTRACT');
assert.match(anvil, /LESSON_NOTE\s*=.*LESSON_CONTRACT/, 'the system-prompt note is built from LESSON_CONTRACT');
// The contract is STABLE text, so it stays in the cache prefix; F3 moved the volatile indexes
// (projectContext / memoryIndex / skillsIndex) out into a change-gated context message.
assert.match(anvil, /content:systemPrompt\(\)\+\(MODE_NOTE\[mode\]\|\|''\)\+\(mode==='code'\?LESSON_NOTE:''\)/, 'the system message includes the note in code mode, where remember exists');
assert.match(anvil, /const volatileCtx = \(projectContext\+memoryIndex\+skillsIndex/, 'and the memory index still reaches the model, in the context message');

// Rules reach the prompt with their bodies: the prompt-time push spreads the parsed fact
// (which carries `body`), and buildMemoryIndex renders a rule in full, first, weight-ordered.
assert.ok(MEMORY_TYPES.includes('rule'), 'rule is a memory type');
const facts = [
  parseFact('---\nname: a-fact\ndescription: the api is in api/\ntype: reference\n---\nRoutes in api/routes.js'),
  parseFact('---\nname: never-force-push\ndescription: never force-push\ntype: rule\nweight: 9\n---\nNever force-push. Rewrite history only on a branch nobody shares.'),
  parseFact('---\nname: tests-first\ndescription: run tests before claiming done\ntype: rule\n---\nRun the gate before saying done.'),
];
const index = buildMemoryIndex(facts);
const iRules = index.indexOf('# Project rules'), iMem = index.indexOf('# Project memory');
assert.ok(iRules >= 0 && iMem >= 0 && iRules < iMem, 'rules block renders before the memory index');
assert.ok(index.includes('Rewrite history only on a branch nobody shares.'), 'a rule is injected with its full body, not a one-liner');
assert.ok(index.indexOf('never-force-push') < index.indexOf('tests-first'), 'higher weight first');
assert.ok(!/\*\*never-force-push\*\* \(rule\):/.test(index), 'a rule is not repeated as an index line');
assert.match(index, /owner'?s? (explicit )?instruction/i, 'the rules block says the owner outranks the rules');
assert.ok(Number.isInteger(RULES_CAP_CHARS) && RULES_CAP_CHARS >= 2000, 'rules have a hard cap');

console.log('anvil-lesson-contract: one contract at both call sites; rules injected whole, weight-ordered, capped');
