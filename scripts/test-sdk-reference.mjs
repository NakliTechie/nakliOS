#!/usr/bin/env node
// U1 teeth: the SDK reference in docs/app-contract.md is rendered from the ledger and cannot drift.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerRows, renderReference, check, splice, currentBlock, LEDGER, DOC, BEGIN, END } from './sdk-reference.mjs';
import { sdkSurface } from './sdk-surface.mjs';

const ledger = readFileSync(LEDGER, 'utf8');
const doc = readFileSync(DOC, 'utf8');
let teeth = 0; const ok = (c, m) => { assert.ok(c, m); teeth++; };

// the real pair is green, and the block names every ledger member
const real = check({ ledger, doc });
ok(real.ok, `the checked-in reference matches the ledger: ${real.why}`);
const rows = ledgerRows(ledger);
const surface = sdkSurface().map((m) => m.member).sort().join('\n'), ledgered = rows.map((r) => r.member).sort().join('\n');
ok(surface === ledgered, 'the ledger parses to exactly the SDK\'s members, by name');
const block = currentBlock(doc);
const unnamed = rows.filter((r) => !block.includes('| `' + r.member + '` |')).map((r) => r.member);
ok(unnamed.length === 0, `the reference names every member (missing: ${unnamed.join(', ') || 'none'})`);

// a member added to the ledger and not re-rendered → red
const plus = ledger.replace(/\n(\| `net\.fetch` \|[^\n]*\n)/, (m, line) => '\n' + line + '| `net.experimental_stream` | function | experimental | a second consumer ships | Streams a response. |\n');
assert.notEqual(plus, ledger, 'the mutation anchor exists');
ok(!check({ ledger: plus, doc }).ok, 'a new ledger member with no rendered row is red');
// …and re-rendering fixes it, marking the member experimental
const rendered = splice(doc, renderReference(ledgerRows(plus)));
ok(check({ ledger: plus, doc: rendered }).ok, 'a re-render is green again');
ok(/\| `net\.experimental_stream` \| function · \*\*experimental\*\* \|/.test(rendered), 'and the experimental member is marked as such');

// a rendered row hand-edited in place → red, and the message names the line
const edited = doc.replace('| `fs.read` | function |', '| `fs.read` | getter |');
assert.notEqual(edited, doc, 'the edit anchor exists');
const e = check({ ledger, doc: edited });
ok(!e.ok && /fs\.read/.test(e.why), `a hand-edited row is red and named: ${e.why}`);

// an EQUAL-LENGTH hand edit is red too (a length compare would pass it)
const sameLen = doc.replace('| `fs.read` | function |', '| `fs.raed` | function |');
assert.notEqual(sameLen, doc, 'the equal-length anchor exists');
ok(!check({ ledger, doc: sameLen }).ok, 'an equal-length edit to a rendered row is red');

// a `|` inside a ledger note is an error, not a vanished member
const piped = ledger.replace(/\| `fs\.write` \| function \| stable \| — \| ([^\n]*) \|/, (m, note) => `| \`fs.write\` | function | stable | — | ${note} (a | b) |`);
assert.notEqual(piped, ledger, 'the pipe anchor exists');
assert.throws(() => ledgerRows(piped), /five cells/, 'the parser refuses the row instead of dropping the member');
ok(!check({ ledger: piped, doc }).ok, 'and the check is red, not green with one member fewer');
// a second row for the same member is an error
const dup = ledger.replace(/(\| `fs\.read` \| function[^\n]*\n)/, (m) => m + m);
assert.throws(() => ledgerRows(dup), /two rows/, 'a duplicate member row is refused');
// two marker pairs (a stale block left behind) → red
const twice = doc.replace(END, END + '\n\n' + currentBlock(doc));
ok(!check({ ledger, doc: twice }).ok, 'a duplicated block is red');

// no markers → red, never a silent pass
ok(!check({ ledger, doc: doc.replace(BEGIN, '') }).ok, 'a doc with no block is red');

console.log(`sdk-reference: ${teeth} teeth green — the contract names all ${rows.length} members and cannot drift from the ledger`);
