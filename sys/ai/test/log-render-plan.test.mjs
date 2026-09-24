// AC-5 — the transcript render plans its update instead of rebuilding everything.
//   node sys/ai/test/log-render-plan.test.mjs
//
// Measured in Anvil on 2026-09-10 before any change, on a 600-row transcript: 2,417 DOM nodes in
// the log box, 48 ms for ONE render (three dropped frames, and a run emits an event per turn), and
// scrollTop 506,771 → 1,013,331 — the reader yanked to the bottom by every event.
//
// The failure direction is deliberate and is what most of this file guards: an incorrect `append`
// leaves a stale row on screen forever, which is far worse than a slow render. So ANY mismatch
// falls back to a full rebuild, and these cases exist to prove it does.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { rowKey, rowKeys, planLogUpdate, PATCH_MAX, planScroll, isPinned } from '../log-render-plan.mjs';

const anvil = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');
const log = (...rows) => rows;
const K = (rows) => rowKeys(rows);

// ── the three modes ────────────────────────────────────────────────────────
{
  const a = log({ k: 'user', text: 'one' }, { k: 'assistant', text: 'two' });
  assert.deepEqual(planLogUpdate(K(a), K(a)), { mode: 'noop', from: 2, reused: 2, built: 0 },
    'nothing changed — the idle case must not touch the DOM at all');

  const b = [...a, { k: 'system', text: 'three' }];
  assert.deepEqual(planLogUpdate(K(a), K(b)), { mode: 'append', from: 2, reused: 2, built: 1 },
    'a new row appended — build only the tail');

  const c = [...a, { k: 'system', text: 'three' }, { k: 'system', text: 'four' }];
  assert.equal(planLogUpdate(K(a), K(c)).built, 2, 'two new rows, two built');

  assert.equal(planLogUpdate(null, K(a)).mode, 'rebuild', 'no cache (fresh mount or task switch) rebuilds');
  assert.equal(planLogUpdate(K(a), []).mode, 'rebuild', 'clearing the log rebuilds');
}

// ── everything that is NOT an append is a patch or a rebuild — never a noop or a stale append ──
// U1 (2026-09-24): an in-place change of the same or greater length PATCHES exactly the changed rows
// (the renderer rebuilds row i from row i, so any such pattern is correct); a shortened log rebuilds.
{
  const base = log({ k: 'user', text: 'a' }, { k: 'assistant', text: 'b' }, { k: 'system', text: 'c' });
  const cases = {
    'a middle row edited': log({ k: 'user', text: 'a' }, { k: 'assistant', text: 'B!' }, { k: 'system', text: 'c' }),
    'the first row edited': log({ k: 'user', text: 'A!' }, { k: 'assistant', text: 'b' }, { k: 'system', text: 'c' }),
    'a row removed': log({ k: 'user', text: 'a' }, { k: 'system', text: 'c' }),
    'rows reordered': log({ k: 'assistant', text: 'b' }, { k: 'user', text: 'a' }, { k: 'system', text: 'c' }),
    'a row kind changed': log({ k: 'user', text: 'a' }, { k: 'system', text: 'b' }, { k: 'system', text: 'c' }),
    'a row inserted in the middle': log({ k: 'user', text: 'a' }, { k: 'system', text: 'X' }, { k: 'assistant', text: 'b' }, { k: 'system', text: 'c' }),
  };
  const want = { 'a middle row edited': [1], 'the first row edited': [0], 'rows reordered': [0, 1], 'a row kind changed': [1], 'a row inserted in the middle': [1, 2] };
  for (const [why, next] of Object.entries(cases)) {
    const plan = planLogUpdate(K(base), K(next));
    assert.ok(plan.mode !== 'noop' && plan.mode !== 'append', `${why} → never noop or append`);
    if (why === 'a row removed') assert.equal(plan.mode, 'rebuild', 'a removed row has no node to be replaced by — rebuild');
    else { assert.equal(plan.mode, 'patch', `${why} → patch`); assert.deepEqual(plan.patched, want[why], `${why} → exactly the changed rows`); }
  }
  // an insertion in the middle patches the rows it shifted and appends the tail it pushed out
  const ins = planLogUpdate(K(base), K(cases['a row inserted in the middle']));
  assert.equal(ins.from, 3, 'the tail is appended from the old length'); assert.equal(ins.built, 3, '2 replaced + 1 appended');
  // past PATCH_MAX changed rows, the rebuild is the cheaper render
  const many = Array.from({ length: PATCH_MAX + 1 }, (_, i) => ({ k: 'user', text: 'r' + i }));
  assert.equal(planLogUpdate(K(many), K(many.map((r) => ({ ...r, text: r.text + '!' })))).mode, 'rebuild', 'more than PATCH_MAX changed rows → rebuild');
  assert.equal(planLogUpdate(K(many), K(many.map((r, i) => (i < PATCH_MAX ? { ...r, text: r.text + '!' } : r)))).mode, 'patch', 'exactly PATCH_MAX → patch');
}

// ── the key must cover everything that is DRAWN ────────────────────────────
// A key that ignores a rendered field is exactly how a stale row survives: the plan says nothing
// changed, and the screen keeps showing the old value.
{
  const tool = (o) => rowKey({ k: 'tool', name: 'shell', detail: 'ls', result: 'a', ...o }, 0);
  assert.notEqual(tool({}), tool({ result: 'b' }), 'a changed tool RESULT changes the key');
  assert.notEqual(tool({}), tool({ error: 'boom' }), 'an error appearing changes the key');
  assert.notEqual(tool({}), tool({ detail: 'cat' }), 'a changed detail changes the key');
  assert.notEqual(tool({}), tool({ open: true }), 'expanding a <details> is rendered, so it changes the key');
  assert.notEqual(tool({}), tool({ name: 'read' }), 'a different tool changes the key');
  assert.equal(tool({}), tool({}), 'and an unchanged row keeps its key');

  // Position is part of identity: the same text at a different index is a different row.
  assert.notEqual(rowKey({ k: 'user', text: 'x' }, 0), rowKey({ k: 'user', text: 'x' }, 1));
  // Two adjacent identical messages must not collapse.
  const dupes = log({ k: 'system', text: 'same' }, { k: 'system', text: 'same' });
  assert.equal(new Set(K(dupes)).size, 2, 'identical adjacent rows keep distinct keys');
  // Malformed rows do not throw.
  assert.equal(typeof rowKey(null, 3), 'string');
  assert.equal(typeof rowKey('nonsense', 4), 'string');
  assert.deepEqual(rowKeys(null), []);
}

// ── the verified-vs-claimed distinction must survive the refactor ──────────
// These labels are load-bearing and are exactly what a render refactor loses quietly: a gated pass
// and an ungated finish must never render as the same thing.
{
  const gated = { k: 'system', text: 'agent gate passed · 4 steps' };
  const claimed = { k: 'system', text: "finished — no gate, so this is the agent's own claim" };
  assert.notEqual(rowKey(gated, 0), rowKey(claimed, 0), 'a verified finish and a claimed one are different rows');
  const turned = planLogUpdate(K([gated]), K([claimed]));
  assert.ok(turned.mode === 'patch' && turned.patched[0] === 0,
    'turning one into the other re-draws that row — it can never be skipped as unchanged');
  assert.match(anvil, /this is the agent\\'s own claim/, 'the ungated wording still exists in the app');
  assert.match(anvil, /result\.stop==='unverified' \? 'gate never passed'/, 'and so does the unverified wording');
}

// ── scroll: the reader's position is theirs unless they were following ─────
{
  // Reading back through a long run — 500,000px up from the bottom.
  const reading = { scrollTop: 500, scrollHeight: 10000, clientHeight: 800 };
  assert.equal(isPinned(reading), false);
  assert.equal(planScroll(reading).scrollTop, 500, 'a reader who scrolled up KEEPS their position');

  // Following along at the bottom.
  const following = { scrollTop: 9200, scrollHeight: 10000, clientHeight: 800 };
  assert.equal(isPinned(following), true, 'exactly at the bottom counts as pinned');
  assert.equal(planScroll(following).scrollTop, 10000, 'and a follower is carried to the new bottom');

  // The threshold has slack, so a pixel of drift does not strand a follower.
  assert.equal(isPinned({ scrollTop: 9180, scrollHeight: 10000, clientHeight: 800 }), true, '20px from the bottom is still following');
  assert.equal(isPinned({ scrollTop: 9100, scrollHeight: 10000, clientHeight: 800 }), false, '100px up is a deliberate scroll');

  // A pinned-ness measured BEFORE the DOM changed can be passed in — which is what the app does,
  // because scrollHeight has already grown by the time the new rows are in.
  assert.equal(planScroll({ ...reading, scrollHeight: 12000, wasPinned: true }).scrollTop, 12000);
  assert.equal(planScroll({ ...following, scrollHeight: 12000, wasPinned: false }).scrollTop, 9200);
}

// ── the app uses it, and the unconditional yank is gone ────────────────────
assert.match(anvil, /const plan = planLogUpdate\(cached, keys\)/, 'renderLog plans its update');
assert.match(anvil, /const pinned = isPinned\(\{ scrollTop:box\.scrollTop/, 'and measures pinned-ness BEFORE mutating');
assert.match(anvil, /box\.scrollTop = pinned \? box\.scrollHeight : prevTop/, 'and restores the reader position');
assert.ok(!/box\.innerHTML=''; box\.appendChild\(w\); box\.scrollTop=box\.scrollHeight;/.test(anvil),
  'the unconditional rebuild-and-yank is gone');
assert.match(anvil, /logCache = \{ taskId:t\.id, keys \}/, 'the cache records which task it belongs to');
assert.match(anvil, /const cached = \(logCache\.taskId===t\.id\) \? logCache\.keys : null/,
  'a task switch invalidates the cache — one task must never append onto another');
// Both early returns must clear the cache, or a later append could land on an empty state.
assert.equal((anvil.match(/logCache=\{taskId:null,keys:null\}/g) || []).length, 2,
  'both early returns in renderLog invalidate the cache');

// B1: a subagent row's typed state and age are drawn, so they are in the key — a tick that re-stamps
// a silent child (live → unverifiable, 4s → 9s) is a visible change, never a stale row.
{
  const sub = (o) => rowKey({ k: 'subagent', kind: 'dispatch', label: 'x', status: 'running', steps: 1, tools: 0, ...o }, 0);
  assert.notEqual(sub({ live: 'live', age: 4 }), sub({ live: 'unverifiable', age: 4 }), 'the state is drawn');
  assert.notEqual(sub({ live: 'live', age: 4 }), sub({ live: 'live', age: 9 }), 'the age is drawn');
  assert.equal(sub({ live: 'live', age: 4 }), sub({ live: 'live', age: 4 }), 'stable for the same stamp');
  assert.equal(planLogUpdate({ keys: [sub({ live: 'live', age: 4 })] }, [{ k: 'subagent', kind: 'dispatch', label: 'x', status: 'running', steps: 1, tools: 0, live: 'live', age: 9 }]).mode !== 'noop', true, 'a re-stamp is not a noop');
}

// ── U1: the app performs the plan node for node, and a user's toggle survives ──
assert.match(anvil, /function buildLogRow\(t, e, i\)\{[\s\S]{0,6000}?const ph=document\.createElement\('span'\); ph\.hidden=true;/, 'one node per row, a placeholder for a kind that draws nothing');
assert.match(anvil, /if\(nodes\.length===cached\.length\)\{ for\(const i of plan\.patched\) existingWrap\.replaceChild\(buildLogRow\(t, t\.log\[i\], i\), nodes\[i\]\); \}\n\s*else \{ plan\.mode='rebuild'; \}/, 'a patch replaces the changed nodes, and rebuilds when the node count is not the row count');
assert.match(anvil, /dt\.addEventListener\('toggle', \(\)=>\{ e\.open = dt\.open;[^\n]*logCache\.keys\[i\] = rowKey\(e, i\); \}\);/, 'a user-opened <details> is written to the row and the key cache, so no render closes it');
assert.ok(anvil.indexOf("q.remove(); }") < anvil.indexOf("if(plan.mode==='patch' && existingWrap){"), 'queue chips are removed before the node count is compared');
console.log('log-render-plan: noop/append/patch/rebuild, keys cover what is drawn, verified≠claimed, scroll belongs to the reader');

// ESS-2: a child's live row updates IN PLACE. Every field the line draws is in its key, so an
// update is a visible change (a rebuild), never a stale row left on screen.
{
  const row = { k: 'subagent', kind: 'dispatch', label: 'A', status: 'running', steps: 1, tools: 0, lastTool: '', lastDetail: '' };
  const k1 = rowKey(row, 3);
  assert.equal(rowKey({ ...row }, 3), k1, 'same row, same key');
  assert.notEqual(rowKey({ ...row, steps: 2 }, 3), k1, 'a step changes the key');
  assert.notEqual(rowKey({ ...row, tools: 1, lastTool: 'shell', lastDetail: 'ls' }, 3), k1, 'a tool call changes the key');
  assert.notEqual(rowKey({ ...row, status: 'done' }, 3), k1, 'the final stop changes the key');
  const prev = [{ k: 'user', text: 'go' }, row, { k: 'system', text: 'thinking…' }];
  const next = [prev[0], { ...row, steps: 2, tools: 1, lastTool: 'read', lastDetail: 'a.py' }, prev[2]];
  const plan = planLogUpdate(rowKeys(prev), rowKeys(next));
  assert.equal(plan.mode, 'patch', 'an in-place child update is patched — never a noop or a plain append');
  assert.deepEqual(plan.patched, [1], 'only the child\'s row is re-drawn, not the transcript');
  console.log('  ok    ESS-2: a subagent row that changes in place is re-drawn');
}
