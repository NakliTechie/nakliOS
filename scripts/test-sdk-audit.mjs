#!/usr/bin/env node
// B4: the SDK's public surface and docs/sdk-api-audit.md agree, member by member.
//   red on: a member with no ledger line · a ledger line with no member · an `experimental_` member
//   whose criteria column is empty · a status that is not stable|experimental.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sdkSurface } from './sdk-surface.mjs';

const ledger = readFileSync(new URL('../docs/sdk-api-audit.md', import.meta.url), 'utf8');
const rows = new Map();
for (const m of ledger.matchAll(/^\| `([^`]+)` \| (\w+) \| (\w+) \| ([^|]*) \|/gm)) rows.set(m[1], { kind: m[2].trim(), status: m[3].trim(), criteria: m[4].trim() });
assert.ok(rows.size > 0, 'the ledger has a member table');

function audit(surface = sdkSurface(), table = rows) {
  const problems = [];
  const seen = new Set();
  for (const s of surface) {
    seen.add(s.member);
    const r = table.get(s.member);
    if (!r) { problems.push(`no ledger line: ${s.member} (${s.kind})`); continue; }
    if (r.kind !== s.kind) problems.push(`kind mismatch: ${s.member} is ${s.kind}, the ledger says ${r.kind}`);
    if (!['stable', 'experimental'].includes(r.status)) problems.push(`status is not stable|experimental: ${s.member} → ${r.status}`);
    const leaf = s.member.split('.').pop();
    if (leaf.startsWith('experimental_') && r.status !== 'experimental') problems.push(`stable but still prefixed: ${s.member}`);
    if (r.status === 'experimental' && (!r.criteria || r.criteria === '—')) problems.push(`experimental with no criteria: ${s.member}`);
  }
  for (const m of table.keys()) if (!seen.has(m)) problems.push(`ledger line with no member: ${m}`);
  return { ok: problems.length === 0, problems, members: surface.length };
}

{
  const real = audit();
  if (!real.ok) { console.error(`sdk-audit: ${real.problems.length} problem(s):`); for (const p of real.problems) console.error('  ' + p); process.exit(1); }
  // teeth, on synthetic surfaces and tables — never the real ledger
  let teeth = 0; const ok = (c, m) => { assert.ok(c, m); teeth++; };
  const surface = sdkSurface();
  const plus = [...surface, { member: 'net.experimental_stream', kind: 'function' }];
  ok(audit(plus).problems.some((p) => /no ledger line: net\.experimental_stream/.test(p)), 'a new member with no line is red');
  const t2 = new Map(rows); t2.set('net.experimental_stream', { kind: 'function', status: 'experimental', criteria: '' });
  ok(audit(plus, t2).problems.some((p) => /experimental with no criteria/.test(p)), 'an experimental member with no criteria is red');
  t2.set('net.experimental_stream', { kind: 'function', status: 'experimental', criteria: 'used by one shipped app; host test drives it' });
  ok(audit(plus, t2).ok === true, 'with criteria it is green');
  t2.set('net.experimental_stream', { kind: 'function', status: 'stable', criteria: '—' });
  ok(audit(plus, t2).problems.some((p) => /stable but still prefixed/.test(p)), 'a stable row for a prefixed member is red');
  const t3 = new Map(rows); t3.set('fs.teleport', { kind: 'function', status: 'stable', criteria: '—' });
  ok(audit(surface, t3).problems.some((p) => /ledger line with no member: fs\.teleport/.test(p)), 'a line for a vanished member is red');
  const t4 = new Map(rows); t4.set('fs.read', { ...rows.get('fs.read'), kind: 'field' });
  ok(audit(surface, t4).problems.some((p) => /kind mismatch: fs\.read/.test(p)), 'a wrong kind is red');
  const t5 = new Map(rows); t5.set('fs.read', { ...rows.get('fs.read'), status: 'draft' });
  ok(audit(surface, t5).problems.some((p) => /status is not stable\|experimental: fs\.read/.test(p)), 'an unknown status is red');
  // the extractor is not a hand list: a member added to the SDK SOURCE is found
  const src = readFileSync(new URL('../sdk/naklios.js', import.meta.url), 'utf8');
  const mutated = src.replace("    requestCapabilities: function () { send('naklios:capabilities-request'); },", "    requestCapabilities: function () { send('naklios:capabilities-request'); },\n    experimental_ping: function () {},");
  assert.notEqual(mutated, src, 'the mutation anchor exists');
  ok(sdkSurface(mutated).some((m) => m.member === 'experimental_ping' && m.kind === 'function'), 'a member added to the source is enumerated, as a function');
  ok(audit(sdkSurface(mutated)).problems.some((p) => /no ledger line: experimental_ping/.test(p)), 'and is red until the ledger names it');
  // a namespace nested past the walk depth would hide its members as one "field" — the walker refuses
  let deep = null; try { sdkSurface('window.naklios = { a: { b: { c: { d: { e: 1 } } } } };'); } catch (e) { deep = e; }
  ok(deep && /a\.b\.c\.d is an object at depth 4/.test(deep.message), 'an object at the depth limit throws, naming the path');
  console.log(`sdk-audit: ${real.members} members, every one on the ledger with a valid status; ${teeth} teeth checks green`);
}
