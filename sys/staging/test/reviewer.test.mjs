// Conformance — P0.4 the ONE reviewer over many apps: real app diff types
// (Reckon cell-range, Draft prosemirror-steps) + the (diff)->DOM contract.
//   node sys/staging/test/reviewer.test.mjs
//
// The spec calls the contract the testable seam and the visual attended
// (plan/p0-protocol-spec.md:157), so the DOM half runs against a fake document:
// what is asserted is the STRUCTURE the reviewer emits, not how it looks.

import { clearRegistry, makeEnvelope } from '../envelope.mjs';
import { registerAppDiffTypes, normalizeCellRange, normalizeProsemirrorSteps, cellText, normalizeAnvilSkill, toolVerb } from '../diff-types.mjs';
import { buildReviewModel, renderReview, renderReviewQueue } from '../reviewer.mjs';
import { issueGrant, caveat, newRootKey } from '../../identity/grant.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// ---- a minimal document: exactly the surface reviewer.mjs is allowed to use ----
function fakeDoc() {
  const make = (tag) => ({
    tag, className: '', textContent: '', children: [], attrs: {},
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
  });
  return { createElement: (tag) => make(tag) };
}
// Walk the emitted tree.
function all(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children) all(c, pred, out);
  return out;
}
const byTag = (root, tag) => all(root, (n) => n.tag === tag);
const byClass = (root, cls) => all(root, (n) => String(n.className).split(' ').includes(cls));
const text = (node) => [node.textContent, ...node.children.map(text)].join(' ').replace(/\s+/g, ' ').trim();

// The registry is module-level; seed it with the PRODUCTION normalizers.
clearRegistry();
const registered = registerAppDiffTypes();

// Real native diffs, in the shapes the apps actually produce.
// Reckon: a setCells transaction + the inverse its applyTransaction precomputes.
const RECKON_DIFF = {
  sheet: 's1', sheetName: 'Sheet1',
  ops: [{ op: 'setCells', sheet: 's1', cells: { A1: { v: 42 }, B2: { f: '=A1*2' }, C3: null } }],
  inverse: [{ op: 'setCells', sheet: 's1', cells: { A1: { v: 1 }, B2: null, C3: { v: 'old' } } }],
};
// Draft: the hunk list buildStageHunks emits.
const DRAFT_DIFF = {
  docId: 'notes.md', docName: 'Notes',
  from: 10, to: 42,
  hunks: [
    { index: 0, kind: 'replace', delText: 'rough draft', insText: 'final draft' },
    { index: 1, kind: 'insert', delText: '', insText: ' Added a closing line.' },
  ],
};

await test('all four production diff types register', () => {
  eq(registered.join(','), 'reckon,draft,kanzen,anvil', 'registered apps');
});

await test('anvil-skill normalizes a planned skill write: the file row plus one row per Sentinel finding and lint warning', () => {
  const diff = { skill: 'deploy', op: 'patch', path: 'SKILL.md', before: '---\nname: deploy\n---\nold', after: '---\nname: deploy\nstatus: quarantined\n---\nnew',
    status: 'quarantined', sentinel: [{ check: 'prompt-injection', severity: 'critical', where: 'body', detail: 'ignore previous instructions' }], lint: ['incident-log shape: 3 dated entries'] };
  const n = normalizeAnvilSkill(diff);
  eq(n.kind, 'skill', 'kind'); eq(n.summary, 'deploy — patch SKILL.md → quarantined', 'summary names op, path and landing status');
  eq(n.rows.length, 3, 'file + sentinel + lint rows'); eq(n.rows[0].change, 'edit', 'file row is an edit');
  assert(/sentinel: prompt-injection \[critical\]/.test(n.rows[1].label) && /ignore previous/.test(n.rows[1].after), 'the finding is ON the card');
  eq(n.rows[2].label, 'lint', 'lint row');
  const env = makeEnvelope({ app: 'anvil', tool: 'skill_manage', diff, expires: null });
  const model = buildReviewModel(env, { actor: 'person', now: 0 });
  eq(model.renderer, 'anvil-skill', 'envelope carries the renderer key'); eq(model.rows.length, 3, 'the ONE reviewer renders a skill write');
  assert(model.committable, 'a person can activate it');
});

await test('reckon cell-range normalizes a real setCells tx + inverse into before/after rows', () => {
  const n = normalizeCellRange(RECKON_DIFF);
  eq(n.kind, 'cells', 'kind');
  eq(n.summary, 'Sheet1 — 3 cells', 'summary');
  eq(n.rows.length, 3, 'row count');
  eq(n.rows[0].label, 'A1', 'A1 label'); eq(n.rows[0].before, '1', 'A1 before'); eq(n.rows[0].after, '42', 'A1 after');
  eq(n.rows[0].change, 'edit', 'A1 is an edit');
  eq(n.rows[1].after, '=A1*2', 'a formula shows verbatim'); eq(n.rows[1].change, 'add', 'B2 was empty → add');
  eq(n.rows[2].before, 'old', 'C3 before'); eq(n.rows[2].after, '', 'C3 cleared'); eq(n.rows[2].change, 'remove', 'C3 is a remove');
});

await test('reckon repeated cell edits show the value before the whole transaction', () => {
  const n = normalizeCellRange({
    sheet: 's1',
    ops: [
      { op: 'setCells', sheet: 's1', cells: { A1: { v: 1 } } },
      { op: 'setCells', sheet: 's1', cells: { A1: { v: 2 } } },
    ],
    inverse: [
      { op: 'setCells', sheet: 's1', cells: { A1: { v: 1 } } },
      { op: 'setCells', sheet: 's1', cells: { A1: { v: 0 } } },
    ],
  });
  eq(n.rows.length, 1, 'one cell has one preview row');
  eq(n.rows[0].before, '0', 'preview starts from the original cell value');
  eq(n.rows[0].after, '2', 'preview shows only the final cell value');
  eq(n.summary, 's1 — 1 cell', 'summary counts distinct cells');
});

await test('a structural reckon op stays VISIBLE rather than being dropped', () => {
  const n = normalizeCellRange({ sheet: 's1', ops: [{ op: 'insertRows', sheet: 's1', at: 3, n: 2 }], inverse: [] });
  eq(n.rows.length, 1, 'structural op listed');
  eq(n.rows[0].label, 'Insert rows', 'names the op in plain words');
  eq(n.summary, 's1 — 1 operation', 'structural work is not counted as a cell');
  eq(n.rows[0].after, 'sheet s1, at 3, n 2', 'the operation details are visible as words');
  assert(!n.rows[0].after.includes('{') && !n.rows[0].after.includes('"'), 'never raw JSON');
});

// Reckon review B7 + B20 (2026-11-17): Reckon sends a display diff in which every change is a
// labelled setCells row (cell, before, after; a sentence for formats, rows and sheets), with the
// same text in `lines` and its own `summary`. This is the shape reviewDiff() in Reckon's
// ui/commands.mjs produces for format.set + rows.delete + sheet.add + a cell write.
const RECKON_DISPLAY_DIFF = {
  sheet: 's1', sheetName: 'Sheet1, asked by anvil', summary: '1 cell, 3 other changes',
  lines: [
    'Format of C12:C13 on Sheet1: no format -> bold',
    'Delete rows 12 to 13 on Sheet1: rows 12 to 13 and their contents -> -',
    'Add a sheet named Summary: - -> Summary',
    'B10: - -> 111',
  ],
  ops: [
    { op: 'setCells', sheet: 's1', cells: { 'Format of C12:C13 on Sheet1': { v: 'bold' } } },
    { op: 'setCells', sheet: 's1', cells: { 'Delete rows 12 to 13 on Sheet1': null } },
    { op: 'setCells', sheet: 's1', cells: { 'Add a sheet named Summary': { v: 'Summary' } } },
    { op: 'setCells', sheet: 's1', cells: { B10: { v: '111' } } },
  ],
  inverse: [
    { op: 'setCells', sheet: 's1', cells: { 'Format of C12:C13 on Sheet1': { v: 'no format' } } },
    { op: 'setCells', sheet: 's1', cells: { 'Delete rows 12 to 13 on Sheet1': { v: 'rows 12 to 13 and their contents' } } },
    { op: 'setCells', sheet: 's1', cells: { 'Add a sheet named Summary': null } },
    { op: 'setCells', sheet: 's1', cells: { B10: null } },
  ],
};

await test('B7: a Reckon display diff renders as readable rows, with the app summary and no JSON or tool id', () => {
  const env = makeEnvelope({ app: 'reckon', tool: 'reckon.transaction', diff: RECKON_DISPLAY_DIFF });
  const model = buildReviewModel(env, { actor: 'person', now: 0, appName: 'Reckon' });
  eq(model.summary, 'Sheet1, asked by anvil — 1 cell, 3 other changes', 'the app summary is used');
  eq(model.rows.length, 4, 'one row per change');
  eq(model.rows[0].label, 'Format of C12:C13 on Sheet1', 'format row label');
  eq(model.rows[0].before, 'no format', 'format before'); eq(model.rows[0].after, 'bold', 'format after');
  eq(model.rows[1].label, 'Delete rows 12 to 13 on Sheet1', 'delete rows label');
  eq(model.rows[1].change, 'remove', 'a delete reads as a removal');
  eq(model.rows[2].change, 'add', 'a new sheet reads as an add');
  eq(model.rows[3].label, 'B10', 'cell row'); eq(model.rows[3].after, '111', 'cell after');
  const card = renderReview(model, { doc: fakeDoc() });
  const shown = text(card);
  assert(!shown.includes('reckon.transaction'), `no tool id on the card: ${shown}`);
  assert(!shown.includes('cell-range'), 'no renderer key on the card');
  assert(!/[{}]/.test(shown) && !shown.includes('"op"'), 'no raw JSON on the card');
  eq(byClass(card, 'nk-rev-app')[0].textContent, 'Reckon', 'the heading names the app by its catalog name');
  eq(byClass(card, 'nk-rev-verb')[0].textContent, 'wants to change the spreadsheet', 'and a plain verb');
  eq(byClass(card, 'nk-rev-tool').length, 0, 'the tool id element is gone');
  eq(card.attrs['aria-label'], 'Reckon wants to change the spreadsheet', 'assistive tech hears the same words');
});

await test('B7: plain change lines alone (no ops) render as rows', () => {
  const n = normalizeCellRange({ sheet: 's1', sheetName: 'Sheet1', lines: ['B10: - -> 111', 'Delete the sheet Data and everything on it: Data -> -', 'A free sentence'] });
  eq(n.rows.length, 3, 'one row per line');
  eq(n.rows[0].label, 'B10', 'label'); eq(n.rows[0].before, '', 'a dash is empty'); eq(n.rows[0].after, '111', 'after');
  eq(n.rows[1].change, 'remove', 'removal');
  eq(n.rows[2].after, 'A free sentence', 'a line without the arrow shows whole');
});

await test('B20: every staging tool reads as a plain verb, and an unknown one falls back', () => {
  for (const [tool, verb] of [['draft.transaction', 'wants to edit the document'], ['kanzen.agent', 'wants to change the board'], ['kanzen.card-move', 'wants to move a card'], ['x.y', 'wants to make a change']]) {
    eq(toolVerb(tool), verb, tool);
  }
});

await test('B22: a card offers Show <app> while the app is open and Open <app> when it is closed', () => {
  const env = makeEnvelope({ app: 'reckon', tool: 'reckon.transaction', diff: RECKON_DIFF });
  let shown = null;
  const open = renderReview(buildReviewModel(env, { actor: 'person', appName: 'Reckon' }), { doc: fakeDoc(), onShowApp: (m) => { shown = m; } });
  eq(byClass(open, 'nk-rev-show')[0].textContent, 'Show Reckon', 'open app');
  const closed = renderReview(buildReviewModel(env, { actor: 'person', appName: 'Reckon', appOpen: false }), { doc: fakeDoc(), onShowApp: () => {} });
  eq(byClass(closed, 'nk-rev-show')[0].textContent, 'Open Reckon', 'closed app');
  eq(byClass(renderReview(buildReviewModel(env, { actor: 'person' }), { doc: fakeDoc() }), 'nk-rev-show').length, 0, 'no control without a handler');
  eq(shown, null, 'nothing fires before a click');
});

await test('draft prosemirror-steps normalizes real hunks', () => {
  const n = normalizeProsemirrorSteps(DRAFT_DIFF);
  eq(n.kind, 'steps', 'kind');
  eq(n.summary, 'Notes — 2 hunks', 'summary');
  eq(n.rows[0].before, 'rough draft', 'hunk 1 before');
  eq(n.rows[0].after, 'final draft', 'hunk 1 after');
  eq(n.rows[0].change, 'edit', 'replace → edit');
  eq(n.rows[1].change, 'add', 'insert → add');
});

await test('cellText covers the op vocabulary', () => {
  eq(cellText({ v: 0 }), '0', 'zero is content, not absence');
  eq(cellText({ f: '=SUM(A1:A9)' }), '=SUM(A1:A9)', 'formula');
  eq(cellText(null), '', 'cleared');
  eq(cellText({ fmt: 'f7' }), '(format f7)', 'format-only touch is reported, not faked as a value change');
});

await test('M0: ONE reviewer renders a Reckon AND a Draft envelope from the registry', () => {
  const rEnv = makeEnvelope({ app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  const dEnv = makeEnvelope({ app: 'draft', tool: 'draft.replaceRange', diff: DRAFT_DIFF });
  eq(rEnv.preview_renderer, 'cell-range', 'reckon renderer key');
  eq(dEnv.preview_renderer, 'prosemirror-steps', 'draft renderer key');

  const doc = fakeDoc();
  const { element, models } = renderReviewQueue([rEnv, dEnv], { actor: 'person' }, { doc });

  eq(models.length, 2, 'two proposals');
  eq(byClass(element, 'nk-rev').length, 2, 'two cards from one component');
  // Same component, no per-app branch: both cards have the same structure.
  const tables = byClass(element, 'nk-rev-diff');
  eq(tables.length, 2, 'both rendered a diff table');
  eq(byClass(element, 'nk-rev-row').length, 5, '3 reckon rows + 2 draft rows');
  // The payload survived the seam end to end, into the DOM.
  assert(text(element).includes('=A1*2'), 'reckon formula reached the DOM');
  assert(text(element).includes('final draft'), 'draft insertion reached the DOM');
  const apps = byClass(element, 'nk-rev-app').map((n) => n.textContent).sort();
  eq(apps.join(','), 'draft,reckon', 'both apps labelled');
});

await test('a person can commit; the button is live and unblocked', () => {
  const env = makeEnvelope({ app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  const model = buildReviewModel(env, { actor: 'person' });
  assert(model.committable, 'person may commit');
  eq(model.blockedReason, '', 'nothing to explain');
  const card = renderReview(model, { doc: fakeDoc() });
  const btn = byClass(card, 'nk-rev-commit')[0];
  eq(btn.textContent, 'Commit', 'live label');
  eq(btn.attrs.disabled, undefined, 'not disabled');
});

await test('an agent without an auto-commit grant is refused, and the refusal is LOUD', () => {
  const env = makeEnvelope({ app: 'draft', tool: 'draft.commit', diff: DRAFT_DIFF });
  const model = buildReviewModel(env, { actor: 'agent', reversible: true });
  eq(model.committable, false, 'refused');
  assert(model.blockedReason.includes('person-only'), `reason names the rule: ${model.blockedReason}`);

  const card = renderReview(model, { doc: fakeDoc() });
  const btn = byClass(card, 'nk-rev-commit')[0];
  eq(btn.attrs.disabled, 'disabled', 'control disabled');
  eq(btn.textContent, 'Commit (blocked)', 'the button says it is blocked');
  const why = byClass(card, 'nk-rev-why')[0];
  assert(why && why.textContent.includes('person-only'), 'the reason is ON SCREEN, not just in the model');
  eq(why.attrs.role, 'status', 'and announced to assistive tech');
  eq(btn.attrs['aria-describedby'], why.attrs.id, 'button points at its reason');
});

await test('an auto-commit grant lets an agent commit a reversible op', async () => {
  const root = newRootKey();
  const grant = await issueGrant(root, { caveats: [caveat.tools(['draft.commit']), caveat.autoCommit(true)] });
  const env = makeEnvelope({ app: 'draft', tool: 'draft.commit', diff: DRAFT_DIFF });
  eq(buildReviewModel(env, { actor: 'agent', reversible: true, grant }).decision.mode, 'auto', 'reversible → auto');
  eq(buildReviewModel(env, { actor: 'agent', reversible: false, grant }).committable, false, 'irreversible still refused');
});

await test('an expired proposal is uncommittable even for a person', () => {
  const env = makeEnvelope({ app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF, expires: 1000 });
  const model = buildReviewModel(env, { actor: 'person', now: 1001 });
  eq(model.expired, true, 'expired');
  eq(model.committable, false, 'expiry outranks person authority');
  assert(model.blockedReason.includes('expired'), 'reason names expiry');
  const card = renderReview(model, { doc: fakeDoc() });
  assert(byClass(card, 'nk-rev-expired').length === 1, 'expiry flagged in the header');
});

await test('the reviewer refuses to render an app that never registered a diff type', () => {
  let threw = false;
  try { buildReviewModel({ proposal_id: 'p', app: 'ghost', tool: 't', diff: {}, preview_renderer: 'x' }, { actor: 'person' }); }
  catch (_) { threw = true; }
  assert(threw, 'un-renderable proposal fails loud');
});

await test('every diff row carries a non-colour change label for a11y', () => {
  const env = makeEnvelope({ app: 'reckon', tool: 'reckon.setRange', diff: RECKON_DIFF });
  const card = renderReview(buildReviewModel(env, { actor: 'person' }), { doc: fakeDoc() });
  const rows = byClass(card, 'nk-rev-row');
  for (const r of rows) {
    assert(byClass(r, 'nk-sr').length === 1, 'row has a screen-reader change word');
    assert(r.attrs['data-change'], 'row carries its change class');
  }
  const ths = byTag(card, 'th').filter((t) => t.attrs.scope === 'col');
  eq(ths.length, 3, 'the diff table has scoped column headers');
});

if (failures.length) { console.error(`staging/reviewer: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`staging/reviewer conformance: ${passed}/${passed} passed`);
