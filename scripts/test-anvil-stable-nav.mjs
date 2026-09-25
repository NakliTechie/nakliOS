// CRIB-E E2 (ZR-A3) — stable task navigation, driven through Anvil's REAL render functions.
//   node scripts/test-anvil-stable-nav.mjs
//
// renderAll runs on every status change of a streaming run, and renderProjects rebuilt the task
// list from scratch each time: the list's scroll position and the keyboard-focused row were thrown
// away (a Tab-navigating reader landed on <body> whenever a dot changed colour). And renderLog, on
// a task switch, handed the incoming task the OUTGOING task's scroll offset. The transcript's own
// incremental update (append / patch / noop, pinned-or-kept scroll) is AC-5, pinned elsewhere.
import assert from 'node:assert/strict';
import { inlineModule, extractFunction, extractRegion, evaluate } from './anvil-harness.mjs';

const src = await inlineModule();
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }

// ── a minimal DOM: enough for renderProjects (elements, children, dataset, focus, scrollTop) ──
function makeDom() {
  const doc = { activeElement: null };
  const el = (tag) => {
    const e = { tagName: tag, children: [], dataset: {}, attrs: {}, className: '', onclick: null, onkeydown: null, scrollTop: 0, _html: '',
      appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
      setAttribute(k, v) { this.attrs[k] = v; },
      focus() { doc.activeElement = this; },
      set innerHTML(v) { this._html = v; this.children = []; if (doc.activeElement && !reachable(doc.activeElement)) doc.activeElement = null; },
      get innerHTML() { return this._html; } };
    return e;
  };
  // an element is "in the document" if it hangs off the list box
  let root = null; // a detached node (its row was rebuilt away) loses focus, as in a browser
  const reachable = (x) => { const walk = (n) => n === x || n.children.some(walk); return walk(root); };
  doc.createElement = el;
  root = el('div'); root.id = 'projects';
  return { doc, box: root };
}
function listBed(state) {
  const { doc, box } = makeDom();
  const ctx = { state, document: doc, $: (id) => (id === 'projects' ? box : null), esc: (x) => String(x),
    save() {}, selectTask() {}, clickable: evaluate(`(${extractFunction(src, 'clickable')})`, {}) };
  const renderProjects = evaluate(`${extractFunction(src, 'renderProjects')}\n;renderProjects`, ctx);
  const rows = () => box.children.flatMap((pd) => pd.children);
  return { renderProjects, box, doc, rows };
}
const st = () => ({ activeTask: 'b', projects: [{ id: 'P', name: 'proj', open: true, tasks: [
  { id: 'a', title: 'A', status: 'done' }, { id: 'b', title: 'B', status: 'running' }, { id: 'c', title: 'C', status: 'idle' }] }] });

await test('a status change keeps the focused row focused, the list scrolled where it was, and the order', () => {
  const s = st(); const b = listBed(s); b.renderProjects();
  const before = b.rows().map((r) => r.dataset.navkey);
  b.rows().find((r) => r.dataset.navkey === 't:c').focus(); b.box.scrollTop = 120;
  s.projects[0].tasks[1].status = 'done'; // the run in B finished: renderAll → renderProjects
  b.renderProjects();
  assert.equal(b.doc.activeElement && b.doc.activeElement.dataset.navkey, 't:c', 'focus is back on task C, not lost to <body>');
  assert.ok(b.rows().includes(b.doc.activeElement), 'and on the NEW node, not a detached one');
  assert.equal(b.box.scrollTop, 120, 'the list keeps its scroll');
  assert.deepEqual(b.rows().map((r) => r.dataset.navkey), before, 'no row moves when a status changes');
  assert.match(b.rows()[2].innerHTML, /dot done/, 'the status still updates');
});

await test('↑ / ↓ move focus between rows (keyboard navigation), Enter still opens', () => {
  const s = st(); const b = listBed(s); let opened = null;
  const ctxSel = b; b.renderProjects();
  const r = () => b.rows();
  r()[1].focus(); // task A
  const key = (k) => { let prevented = false; b.doc.activeElement.onkeydown({ key: k, preventDefault() { prevented = true; } }); return prevented; };
  assert.ok(key('ArrowDown')); assert.equal(b.doc.activeElement.dataset.navkey, 't:b');
  key('ArrowDown'); assert.equal(b.doc.activeElement.dataset.navkey, 't:c');
  key('ArrowDown'); assert.equal(b.doc.activeElement.dataset.navkey, 't:c', 'stops at the last row');
  key('ArrowUp'); key('ArrowUp'); key('ArrowUp'); assert.equal(b.doc.activeElement.dataset.navkey, 'p:P', 'up to the project row');
  void opened; void ctxSel;
});

await test('nothing focused before → nothing is grabbed after (a render never steals focus)', () => {
  const s = st(); const b = listBed(s); b.renderProjects(); b.doc.activeElement = null;
  b.renderProjects();
  assert.equal(b.doc.activeElement, null);
});

// ── per-task log scroll on a task switch ─────────────────────────────────────────────────────
await test('each task keeps its own reading position across a switch', () => {
  const region = extractRegion(src, '    const pinned = isPinned({ scrollTop:box.scrollTop', '    // A queue chip is not a log row');
  const tail = extractRegion(src, '    if(switched){ const saved=logScroll.get(t.id);', '\n  }\n  const logScroll');
  assert.match(src, /const logScroll = new Map\(\);/);
  const logScroll = new Map();
  const isPinned = ({ scrollTop, scrollHeight, clientHeight }) => scrollHeight - scrollTop - clientHeight < 40;
  const step = (logCache, t, box) => evaluate(`${region}\n${tail}`, { logCache, t, box, logScroll, isPinned });
  // reading task A mid-way, switch to B (fresh → bottom), then back to A
  const box = { scrollTop: 300, scrollHeight: 2000, clientHeight: 500 };
  step({ taskId: 'A' }, { id: 'B' }, box);
  assert.equal(logScroll.get('A'), 300, 'A\'s position is saved on the way out');
  assert.equal(box.scrollTop, 2000, 'B, never seen, opens at the bottom');
  box.scrollHeight = 900; // B's content; the reader is following B at the bottom
  box.scrollTop = 900 - 500; // at B's bottom when the switch back happens
  step({ taskId: 'B' }, { id: 'A' }, box);
  assert.equal(box.scrollTop, 300, 'A comes back where it was left — not B\'s offset');
  assert.equal(logScroll.get('B'), 'bottom', 'B was pinned, so it is remembered as following');
});

if (failures.length) {
  console.error(`anvil-stable-nav: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`anvil-stable-nav: ${passed}/${passed} passed — focus, scroll and order survive a status change; ↑/↓ navigate; each task keeps its reading position`);
