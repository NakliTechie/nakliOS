// SEC Med1 + Med2/Med7 — two grant boundaries that were missing.
//   node sys/rig/agent/test/sec-grant-fences.test.mjs
//
// Med1: `.anvil/search-index.json` is DERIVED from the workspace. An agent that can write it can
// make search lie about the very files it was built from — a poisoned index answers questions
// about content that does not say what it claims, and every later `rg` inherits the lie. Same
// category as .anvil/skills and .anvil/gate: content the agent produces must not become authority.
// The persistence optimisation is untouched; the APP still writes the index, the AGENT cannot.
//
// Med2/Med7: git.clone and git.fetch REACH THE NETWORK, and they were gated on `git:write` and
// `git:read` — the scopes a purely local commit or log needs. Sharing them meant a grant could not
// withhold "may talk to a remote" without also withholding "may commit". `git:remote` separates
// the two. It was already reserved in the registry's scope list and unused.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../index.mjs';
import { createGitCore } from '../../git/git-core.mjs';

const anvil = await readFile(new URL('../../../../apps/anvil/index.html', import.meta.url), 'utf8');
const SEARCH_INDEX = '.anvil/search-index.json';

function face({ scopes, readOnlyPrefixes = [] }) {
  const fs = createFileops({ backend: new MemoryBackend() });
  // git must be wired, or clone/fetch are not registered at all and refuse with ENOCMD — which
  // looks like a pass and tests nothing about the scope. (It did, on the first run.)
  const registry = buildRigRegistry({ fs, git: createGitCore({ fs, dir: '/' }) });
  const grant = createGrant({ prefixes: [''], scopes, readOnlyPrefixes });
  return { fs, face: createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' }) };
}
// The face's entry point is `invoke`, and a refusal comes back as a VALUE (`{ok:false}`) as often
// as it throws — so both shapes are normalised here rather than assuming one.
// The face's entry point is `invoke`, and a refusal comes back as a VALUE (`{ok:false, code}`).
// The CODE is what gets asserted, never a regex over the message: a first draft matched
// /scope|grant|denied/ and would have accepted an EINVAL from a mistyped argument as if it were a
// fence — which is exactly the mistake this file exists to catch in the code it tests.
const call = async (f, name, input) => {
  try {
    const v = await f.invoke(name, input);
    if (v && v.ok === false) return { ok: false, code: v.code || '', why: String(v.message || v.error || '') };
    return { ok: true, value: v };
  } catch (e) { return { ok: false, code: e.code || '', why: String(e.message || e) }; }
};

// ── Med1: the index is readable and unwritable ────────────────────────────
{
  const { fs, face: f } = face({ scopes: ['fs:read', 'fs:write', 'fs:remove'], readOnlyPrefixes: [SEARCH_INDEX] });
  await fs.write(SEARCH_INDEX, '{"real":true}');          // the APP writes it — that still works

  const read = await call(f, 'fs.read', { path: SEARCH_INDEX });
  assert.equal(read.ok, true, 'the agent may still READ the index — it is not secret, it is authority');

  // Every route to writing it, since a fence that catches one spelling catches nothing.
  for (const [name, input] of [
    ['fs.write', { path: SEARCH_INDEX, data: '{"poisoned":true}' }],
    ['fs.remove', { path: SEARCH_INDEX }],
    ['fs.move', { from: 'decoy.txt', to: SEARCH_INDEX }],
    ['fs.write', { path: './' + SEARCH_INDEX, data: 'x' }],
    ['fs.write', { path: '.anvil/../.anvil/search-index.json', data: 'x' }],
    ['fs.write', { path: 'a/../' + SEARCH_INDEX, data: 'x' }],
  ]) {
    const r = await call(f, name, input);
    assert.equal(r.ok, false, `${name} ${JSON.stringify(input)} must be refused`);
    assert.equal(r.code, 'EGRANT', `${name} is refused BY THE GRANT — not by a validation error that happens to fail`);
  }
  // The file is untouched by every one of those attempts.
  const after = await fs.read(SEARCH_INDEX, { encoding: 'utf-8' });
  assert.equal(after.data, '{"real":true}', 'the index still says what the app wrote');

  // A neighbour inside .anvil is NOT fenced by this — the fence is the file, not the directory.
  const near = await call(f, 'fs.write', { path: '.anvil/notes.md', data: 'fine' });
  assert.equal(near.ok, true, 'the fence is the index file, not all of .anvil');
}

// ── Med2/Med7: reaching a remote needs its own scope ──────────────────────
{
  // A grant with full LOCAL git and no git:remote: commit yes, clone/fetch no.
  const local = face({ scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] });
  for (const [name, input] of [['git.clone', { url: 'https://example.com/r.git' }], ['git.fetch', { url: 'https://example.com/r.git' }]]) {
    const r = await call(local.face, name, input);
    assert.equal(r.ok, false, `${name} without git:remote is refused`);
    assert.equal(r.code, 'EGRANT', `${name} refuses for a SCOPE reason, not by failing to reach the network`);
  }
  // git:push is still separate and still withheld — this must not have widened it.
  const withRemote = face({ scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write', 'git:remote'] });
  const pushed = await call(withRemote.face, 'git.push', { url: 'https://example.com/r.git', ref: 'main' });
  assert.equal(pushed.ok, false, 'git:remote does NOT confer git:push — push stays operator-only');
  assert.equal(pushed.code, 'EGRANT');
}

// ── the registry declares it, and Anvil's grant holds it ──────────────────
{
  const src = await readFile(new URL('../../registry/git-commands.mjs', import.meta.url), 'utf8');
  const scopeOf = (verb) => {
    const i = src.indexOf(`name: 'git.${verb}'`);
    assert.ok(i > 0, `git.${verb} exists`);
    return /scope: '([^']+)'/.exec(src.slice(i, i + 1400))?.[1];
  };
  assert.equal(scopeOf('clone'), 'git:remote');
  assert.equal(scopeOf('fetch'), 'git:remote');
  assert.equal(scopeOf('push'), 'git:push', 'push keeps its own operator-only scope');
  assert.equal(scopeOf('commit'), 'git:write', 'a LOCAL commit is unchanged — that is the point of splitting');
  assert.equal(scopeOf('log'), 'git:read', 'and so is a local log');

  // Both Anvil grant sites, or the two drift and one of them is the hole.
  const grants = anvil.match(/createGrant\(\{ prefixes:\[''\][^)]*\)/g) || [];
  assert.equal(grants.length, 2, 'Anvil builds its agent grant in exactly two places');
  for (const g of grants) {
    assert.match(g, /'git:remote'/, 'each grant holds git:remote');
    assert.ok(!/'git:push'/.test(g), 'and neither holds git:push');
    assert.match(g, /SEARCH_INDEX_PATH/, 'each fences the search index');
    assert.match(g, /SKILLS_DIR, GATE_DIR/, 'without losing the fences it already had');
  }
  // One constant, not two literals — the fence and the fileops config must name the same file.
  assert.match(anvil, /const SEARCH_INDEX_PATH = '\.anvil\/search-index\.json';/);
  assert.match(anvil, /indexPath: SEARCH_INDEX_PATH/, 'the index is configured from the same constant it is fenced by');
  assert.equal((anvil.match(/'\.anvil\/search-index\.json'/g) || []).length, 1,
    'the path appears exactly once — two literals would drift and the fence would miss');
}

console.log('sec-grant-fences: the search index is read-only on every route; clone/fetch need git:remote; push still does not');
