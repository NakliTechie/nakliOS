// AC-6 — pre-images: bounded, honest about being missing, and a Revert that refuses to clobber.
//   node sys/ai/test/change-preimages.test.mjs
//
// The capability entry's premise was WRONG and the audit is the reason this file exists. It said
// diff chips cannot be rebuilt after reload; in fact `noteChange` stores the pre-image on the
// change row and `t.log` persists, so chips and diffs already survived. Three other things were
// broken, and the first loses data:
//
//   1. Revert wrote the pre-image back with no check that the file still looked the way the agent
//      left it. Your own edit, a later turn, a subagent merge or a second tab — all silently
//      destroyed.
//   2. Over the 20,000-char cap the pre-image became null and the chip rendered IDENTICALLY: no
//      diff, no Revert, no explanation.
//   3. Retention was unbounded — every change row kept a full copy of the file's prior contents
//      forever, in localStorage and in the roamed state.json.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildChangeRow, planRevert, prunePreimages, preimageBytes, digest,
         MAX_PREIMAGE_CHARS, MAX_PREIMAGE_BUDGET } from '../change-preimages.mjs';

const anvil = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');

// ── DEFECT 1: Revert must not destroy what it cannot see ───────────────────
{
  const pre = 'line one\nline two\n';
  const post = 'line one\nline TWO\n';
  const row = buildChangeRow({ file: 'a.txt', verb: 'edited', pre, post });
  assert.equal(row.pre, pre);
  assert.ok(row.postHash, 'the row records what the agent left behind');

  // The clean case: nothing has touched the file since.
  const ok = planRevert(row, post);
  assert.equal(ok.ok, true);
  assert.equal(ok.content, pre, 'reverting restores exactly the previous version');

  // THE DATA-LOSS CASE: someone edited the file after the agent did.
  const stale = planRevert(row, 'line one\nline TWO\nmy own new line\n');
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.match(stale.message, /has changed since the agent wrote it/);
  assert.match(stale.message, /would discard that/, 'and it says what is at risk, not just "no"');
  assert.equal(stale.content, undefined, 'a refused revert hands back nothing to write');

  // Whitespace-only drift still counts — we cannot tell it from meaningful work.
  assert.equal(planRevert(row, post + '\n').reason, 'stale');

  // Already at the previous version: nothing to do, and say so rather than writing again.
  assert.equal(planRevert(row, pre).reason, 'already-reverted');

  // Unreadable file: refuse. Writing blind is how the original defect worked.
  assert.equal(planRevert(row, null).reason, 'unreadable');

  // A row from before postHash existed cannot be checked, so it is refused BY NAME rather than
  // best-effort reverted. A silent best-effort is the behaviour being removed.
  const legacy = { k: 'change', file: 'a.txt', pre, verb: 'wrote' };
  const l = planRevert(legacy, post);
  assert.equal(l.ok, false);
  assert.equal(l.reason, 'no-posthash');
  assert.match(l.message, /before Anvil started recording/);
}

// ── DEFECT 2: a missing pre-image must say so ──────────────────────────────
{
  const big = 'x'.repeat(MAX_PREIMAGE_CHARS + 1);
  const row = buildChangeRow({ file: 'big.txt', verb: 'wrote', pre: big, post: 'small' });
  assert.equal(row.pre, null, 'over the cap the pre-image is not kept');
  assert.match(row.preUnavailable, /over the 20,000 kept for diffs/, 'and the row carries the reason');
  assert.match(row.preUnavailable, /20,001 characters/, 'including how big it actually was');
  assert.ok(row.postHash, 'the postHash is still recorded — the chip is not useless');

  const r = planRevert(row, 'small');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-preimage');
  assert.match(r.message, /No previous version was kept for big\.txt/);
  assert.match(r.message, /over the 20,000/, 'the refusal repeats the reason, so the user sees it where they act');

  // Exactly at the cap is kept — an off-by-one here silently drops diffs.
  assert.equal(buildChangeRow({ file: 'f', verb: 'wrote', pre: 'x'.repeat(MAX_PREIMAGE_CHARS), post: 'p' }).pre.length, MAX_PREIMAGE_CHARS);

  // Unreadable before the write is its own reason, not the same as "too big".
  const unread = buildChangeRow({ file: 'g', verb: 'wrote', pre: null, post: 'p' });
  assert.equal(unread.pre, null);
  assert.match(unread.preUnavailable, /could not be read before the change/);

  // An empty previous version is a REAL pre-image (the file was created), not a missing one.
  const created = buildChangeRow({ file: 'new.txt', verb: 'wrote', pre: '', post: 'hello' });
  assert.equal(created.pre, '', 'creating a file keeps an empty pre-image');
  assert.equal(created.preUnavailable, undefined);
  assert.equal(planRevert(created, 'hello').ok, true, 'so the creation can be undone');
}

// ── DEFECT 3: retention is bounded, newest kept ────────────────────────────
{
  const mk = (i, size) => buildChangeRow({ file: `f${i}.txt`, verb: 'wrote', pre: 'y'.repeat(size), post: `p${i}` });
  const log = [{ k: 'user', text: 'go' }, mk(1, 100), mk(2, 100), mk(3, 100), { k: 'system', text: 'note' }];
  assert.equal(preimageBytes(log), 300);

  // A budget that fits two of the three: the OLDEST loses its pre-image.
  const pruned = prunePreimages(log, { budget: 250 });
  assert.equal(pruned.dropped, 1);
  assert.equal(pruned.freed, 100);
  assert.equal(pruned.retained, 200);
  assert.equal(pruned.log[1].pre, null, 'the oldest change lost its pre-image');
  assert.match(pruned.log[1].preUnavailable, /dropped to keep this task's history from growing/);
  assert.equal(pruned.log[2].pre.length, 100, 'the newer two are kept');
  assert.equal(pruned.log[3].pre.length, 100);
  assert.ok(pruned.log[1].postHash, 'a pruned row keeps its postHash and its chip');
  assert.deepEqual(pruned.log[0], log[0], 'non-change rows are untouched');
  assert.deepEqual(pruned.log[4], log[4]);

  // Under budget: the same array back, nothing copied.
  const same = prunePreimages(log, { budget: 10000 });
  assert.equal(same.dropped, 0);
  assert.equal(same.log, log, 'no work when there is nothing to do');
  // The input is never mutated.
  assert.equal(log[1].pre.length, 100, 'pruning returns a new log rather than editing the old one');

  // A budget of zero drops everything but keeps every chip.
  const none = prunePreimages(log, { budget: 0 });
  assert.equal(none.dropped, 3);
  assert.equal(preimageBytes(none.log), 0);
  assert.equal(none.log.filter((r) => r.k === 'change').length, 3, 'every change chip survives');
  // And that pruned state is honest to a later revert.
  assert.equal(planRevert(none.log[3], 'p3').reason, 'no-preimage');

  assert.equal(preimageBytes(null), 0);
  assert.deepEqual(prunePreimages(null).log, []);
  assert.ok(MAX_PREIMAGE_BUDGET > MAX_PREIMAGE_CHARS, 'the task budget holds more than one file');
}

// ── the digest distinguishes what it must ──────────────────────────────────
assert.notEqual(digest('a'), digest('b'));
assert.notEqual(digest('ab'), digest('ba'), 'order matters');
assert.notEqual(digest(''), digest(' '));
assert.equal(digest('same'), digest('same'));
assert.match(digest('abc'), /^3:/, 'the length is part of the digest, so a collision needs both');

// ── the app uses all three ─────────────────────────────────────────────────
assert.match(anvil, /const row = buildChangeRow\(\{ file:path, verb: name==='edit'\?'edited':'wrote', pre:raw, post \}\)/,
  'the write path builds its row through the module');
assert.match(anvil, /const row = buildChangeRow\(\{ file:rel, verb:'wrote', pre, post \}\)/,
  'and so does the subagent-merge path — both write paths, or one drifts');
assert.equal((anvil.match(/prunePreimages\(t\.log\)/g) || []).length, 2, 'both write paths prune');
assert.match(anvil, /const plan = planRevert\(/, 'revert asks first');
assert.match(anvil, /if\(!plan\.ok\)\{ pushSystem\('↶ Not reverted — '\+plan\.message\); return; \}/,
  'and a refusal is shown to the user with its reason');
assert.match(anvil, /await fs\.write\(pv\.file, plan\.content\)/, 'only the planned content is ever written');
// The unconditional clobber must be gone.
assert.ok(!/if\(!pv \|\| pv\.pre==null\) return;\s*\n\s*try\{ await fs\.write\(pv\.file, pv\.pre\); \}/.test(anvil),
  'the blind revert is gone');
assert.match(anvil, /at\.preview\.note='No before\/after diff: '\+row\.preUnavailable/, 'the preview explains a missing diff');
assert.match(anvil, /if\(pv\.note\)\{ const n=document\.createElement\('div'\); n\.className='pv-note'/, 'and actually renders it');

console.log('change-preimages: revert refuses on drift, a dropped pre-image says why, retention is bounded newest-first');
