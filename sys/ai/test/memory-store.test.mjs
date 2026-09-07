// Conformance — structured project memory (pure).
//   node sys/ai/test/memory-store.test.mjs
import { parseFact, buildMemoryIndex, noteToFact, recallTool, MEMORY_DIR, MEMORY_TYPES,
         findDuplicate, duplicateReply, slotHolder, createRememberBudget, budgetSpentReply, MAX_REMEMBER_PER_RUN, NEAR_DUPLICATE_JACCARD,
         checkRulesCap, rulesCapReply, RULES_CAP_CHARS, LESSON_CONTRACT, serializeFact }
  from '../memory-store.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

await test('parseFact: frontmatter + type + body', () => {
  const f = parseFact('---\nname: api-home\ndescription: The API lives in api/\ntype: reference\n---\nRoutes are in api/routes.js');
  eq(f.name, 'api-home', 'name');
  eq(f.description, 'The API lives in api/', 'description');
  eq(f.type, 'reference', 'type');
  assert(f.body.includes('Routes are in api/routes.js'), 'body');
});

await test('parseFact: unknown/absent type → project', () => {
  eq(parseFact('---\nname: x\ntype: bogus\n---\nb').type, 'project', 'bogus → project');
  eq(parseFact('---\nname: x\n---\nb').type, 'project', 'absent → project');
});

await test('buildMemoryIndex: empty when no facts', () => {
  eq(buildMemoryIndex([]), '', 'empty');
  eq(buildMemoryIndex(null), '', 'null');
  eq(buildMemoryIndex([{}]), '', 'no name/desc → skipped');
});

await test('buildMemoryIndex: name + type + description, mentions recall + remember', () => {
  const out = buildMemoryIndex([
    { name: 'api-home', description: 'API in api/', type: 'reference' },
    { name: 'tabs', description: 'Use tabs not spaces', type: 'project' },
  ]);
  assert(out.includes('# Project memory'), 'header');
  assert(out.includes('**api-home** (reference): API in api/'), 'fact 1 with type');
  assert(out.includes('**tabs** (project): Use tabs not spaces'), 'fact 2');
  assert(/`recall`/.test(out) && /`remember`/.test(out), 'names both tools');
});

await test('noteToFact: deterministic slug + description + serialized file', () => {
  const f = noteToFact('The build script is scripts/build.sh not make', 'reference');
  eq(f.slug, 'the-build-script-is-scripts-build', 'slug = first 6 kebab tokens');
  eq(f.type, 'reference', 'type honored');
  eq(f.description, 'The build script is scripts/build.sh not make', 'description = first line');
  assert(f.file.startsWith('---\nname: ' + f.slug + '\n'), 'frontmatter name matches slug');
  assert(f.file.includes('type: reference'), 'frontmatter type');
  assert(f.file.includes('The build script is scripts/build.sh not make'), 'body in file');
  // round-trips through parseFact
  const p = parseFact(f.file);
  eq(p.name, f.slug, 'round-trip name');
  eq(p.type, 'reference', 'round-trip type');
});

await test('noteToFact: multi-line — description is first line, body is full', () => {
  const f = noteToFact('Auth uses JWT.\nTokens expire in 1h; refresh at /auth/refresh.', 'project');
  eq(f.description, 'Auth uses JWT.', 'description = first line only');
  assert(f.body.includes('refresh at /auth/refresh'), 'body keeps the rest');
});

await test('noteToFact: default type + long-first-line truncation', () => {
  eq(noteToFact('a fact', undefined).type, 'project', 'default type');
  const long = 'x'.repeat(200);
  const f = noteToFact(long, 'project');
  assert(f.description.length <= 141 && f.description.endsWith('…'), 'truncated with ellipsis');
});

await test('noteToFact: an alnum-less note gets a distinct fallback slug, no crash (forward-pass S-5)', () => {
  // was: every such note slugged to the bare word "fact" and they all collided on one filename
  const f = noteToFact('', 'project');
  assert(/^fact-[a-z0-9]{1,6}$/.test(f.slug), `fallback slug is namespaced: ${f.slug}`);
  const a = noteToFact('!!! ???', 'project'), b = noteToFact('@@@ ***', 'project');
  assert(a.slug !== b.slug, `two alnum-less notes get two slugs: ${a.slug} vs ${b.slug}`);
  eq(noteToFact('!!! ???', 'project').slug, a.slug, 'the same note still round-trips to the same slug');
  // a note that DOES carry words is unaffected
  eq(noteToFact('The build tool is vite', 'project').slug, 'the-build-tool-is-vite', 'worded notes slug as before');
});

await test('recallTool + constants', () => {
  const t = recallTool();
  eq(t.function.name, 'recall', 'name');
  assert(t.function.parameters.required.includes('name'), 'name required');
  assert(t.function.parameters.properties.offset, 'recall pages long facts by offset (B5)');
  eq(MEMORY_DIR, '.anvil/memory', 'dir');
  assert(MEMORY_TYPES.includes('user') && MEMORY_TYPES.includes('reference'), 'types');
});

// ─────────────────────────────────── search before save + per-run cap (A2) ──
const P = (name, extra = {}) => parseFact(`---\nname: ${name}\ndescription: ${extra.description || name}\ntype: project\n${extra.status ? 'status: ' + extra.status + '\n' : ''}${extra.supersedes ? 'supersedes: ' + extra.supersedes + '\n' : ''}---\n${extra.body || extra.description || name}`);

await test('findDuplicate: exact — same text (normalised) as a live fact → refused with the next move', () => {
  const facts = [P('build-tool', { description: 'The build tool is Vite.', body: 'The build tool is Vite.\nSee package.json.' })];
  const d = findDuplicate(facts, 'the build tool is vite');
  assert(d && d.reason === 'exact' && d.existing === 'build-tool', JSON.stringify(d));
  eq(d.status, null, 'plain fact → status null'); eq(d.successor, null, 'no successor');
  assert(/already exists as "build-tool"/.test(duplicateReply(d)) && /`recall`/.test(duplicateReply(d)) && /`revise`/.test(duplicateReply(d)), 'reply names the fact and both next moves');
  const full = findDuplicate(facts, 'The build tool is Vite.\nSee package.json.');
  eq(full && full.reason, 'exact', 'matching the whole body is exact too');
});

await test('findDuplicate: near — first line ≥ 0.8 Jaccard with a live fact\'s description', () => {
  const facts = [P('tests-live', { description: 'Tests live under sys/ai/test and run with plain node', status: 'hypothesis' })];
  const d = findDuplicate(facts, 'Tests live under sys/ai/test and run with plain node, no runner');
  assert(d && d.reason === 'near' && d.existing === 'tests-live', JSON.stringify(d));
  eq(d.status, 'hypothesis', 'status carried — the agent may want to revise it');
  assert(/near-identical/.test(duplicateReply(d)) && /\(hypothesis\)/.test(duplicateReply(d)), 'reply says near + status');
  eq(findDuplicate(facts, 'The database is postgres'), null, 'an unrelated note is not a duplicate');
  eq(findDuplicate(facts, ''), null, 'empty note → null');
  eq(NEAR_DUPLICATE_JACCARD, 0.8, 'threshold pinned');
});

await test('findDuplicate: a NEGATION is a correction, not a near-duplicate (forward-pass M-1)', () => {
  const facts = [P('build-tool', { description: 'the build tool is vite' })];
  // the exact repro: {the,build,tool,not,vite} ∩ {the,build,tool,vite} = 4/5 = 0.80, AT the
  // threshold — so the correction was refused as a duplicate of the claim it corrects.
  eq(findDuplicate(facts, 'the build tool is NOT vite'), null, 'a polarity flip is not a duplicate');
  const facts2 = [P('build-tool', { description: 'the build tool is not vite' })];
  eq(findDuplicate(facts2, 'the build tool is vite'), null, 'the flip is symmetric');
  // and the guard is narrow: same-polarity near-duplicates are still refused
  const para = findDuplicate(facts, 'the build tool is vite here');
  assert(para && para.reason === 'near', 'same-polarity paraphrase still near: ' + JSON.stringify(para));
  const both = findDuplicate(facts2, 'the build tool is not vite anymore');
  assert(both && both.reason === 'near', 'two negated restatements still near: ' + JSON.stringify(both));
  // polarity is read off the TOKEN set, so a bare "no" (≤2 chars, never a token) cannot flip it:
  // "no, the build tool is vite" is a RESTATEMENT and must still be refused.
  const restate = findDuplicate(facts, 'no, the build tool is vite');
  assert(restate && restate.reason === 'near', 'a leading "no" does not make a restatement a correction: ' + JSON.stringify(restate));
});

await test('findDuplicate: superseded — a note matching a retracted or superseded fact is refused with its successor', () => {
  const facts = [
    P('cache-guess', { description: 'The cache is redis', status: 'retracted' }),
    P('old-db', { description: 'The database is mysql' }),
    P('new-db', { description: 'The database is postgres', supersedes: 'old-db' }),
  ];
  const r = findDuplicate(facts, 'The cache is redis');
  assert(r && r.reason === 'superseded' && r.status === 'retracted' && r.successor === null, JSON.stringify(r));
  assert(/disproven — do not re-derive/.test(duplicateReply(r)) && /supersedes: "cache-guess"/.test(duplicateReply(r)), 'the retracted match names the exit: record the correction with supersedes');
  // the exit works: a correction that overlaps the claim it replaces is NOT refused when it declares supersedes
  eq(findDuplicate(facts, 'The cache is redis, not memcached', { exempt: ['cache-guess'] }), null, 'exempted fact is skipped');
  eq(findDuplicate(facts, 'The database is mysql', { exempt: 'old-db, new-db' }), null, 'exempt accepts a comma list');
  assert(/supersedes: "new-db"/.test(duplicateReply(findDuplicate(facts, 'The database is postgres'))), 'a live near/exact refusal also offers the supersedes exit');
  const s = findDuplicate(facts, 'The database is mysql');
  assert(s && s.reason === 'superseded' && s.existing === 'old-db' && s.successor === 'new-db', JSON.stringify(s));
  assert(/replaced by "new-db"/.test(duplicateReply(s)), duplicateReply(s));
  // a live match wins over a stale one
  const live = findDuplicate(facts, 'The database is postgres');
  eq(live && live.reason, 'exact', 'live fact reported first'); eq(live.existing, 'new-db', 'the successor, not the stale row');
});

await test('supersede CYCLE keeps exactly one live winner (forward-pass S-2)', () => {
  // A↔B: each claims to supersede the other. Both used to read as stale, so the index tagged
  // each "superseded by" the other and the claim vanished from the store entirely.
  const facts = [
    P('a-claim', { description: 'the cache is redis', supersedes: 'b-claim' }),
    P('b-claim', { description: 'the cache is memcached', supersedes: 'a-claim' }),
  ];
  const idx = buildMemoryIndex(facts);
  const superseded = (idx.match(/superseded by/g) || []).length;
  eq(superseded, 1, `exactly one member of the cycle is stale, not both:\n${idx}`);
  assert(/a-claim/.test(idx) && /b-claim/.test(idx), 'both facts still render');
  // disk order decides the winner: the last-written member stays live
  eq(slotHolder([
    P('a-slot', { description: 'x', supersedes: 'b-slot' }),
    P('b-slot', { description: 'y', supersedes: 'a-slot' }),
  ].map((f) => ({ ...f, slot: 'phase' })), 'phase'), 'b-slot', 'the later member of a cycle holds the slot');
  // a normal (acyclic) supersede is untouched
  const normal = buildMemoryIndex([P('old-x', { description: 'old' }), P('new-x', { description: 'new', supersedes: 'old-x' })]);
  eq((normal.match(/superseded by/g) || []).length, 1, 'an ordinary supersede still stales exactly its predecessor');
});

await test('createRememberBudget: the cap trips on the 6th (default 5), and the reply says so', () => {
  const b = createRememberBudget();
  eq(MAX_REMEMBER_PER_RUN, 5, 'default cap');
  for (let i = 1; i <= 5; i++){ const t = b.take(); assert(t.ok, `take ${i} ok`); eq(t.left, 5 - i, `left after ${i}`); }
  const sixth = b.take();
  assert(!sixth.ok && sixth.left === 0 && sixth.used === 5, JSON.stringify(sixth));
  eq(b.used, 5, 'used does not grow past the cap'); eq(b.left, 0, 'nothing left');
  assert(/recorded 5 learnings, its cap/.test(budgetSpentReply(sixth)), budgetSpentReply(sixth));
  const two = createRememberBudget(2); two.take(); two.take(); assert(!two.take().ok, 'custom cap honoured');
});

// ─────────────────────────────────── rules injected whole, weight-ordered, capped (A3) ──
const R = (name, body, extra = {}) => parseFact(`---\nname: ${name}\ndescription: ${name}\ntype: rule\n${extra.weight ? 'weight: ' + extra.weight + '\n' : ''}${extra.status ? 'status: ' + extra.status + '\n' : ''}${extra.supersedes ? 'supersedes: ' + extra.supersedes + '\n' : ''}---\n${body}`);

await test('rules: injected in full, first, highest weight first; retracted/superseded rules never bind', () => {
  const facts = [
    P('a-fact', { description: 'the api is in api/' }),
    R('low', 'Low rule body.', { weight: 2 }),
    R('high', 'High rule body — long enough to see.', { weight: 9 }),
    R('mid', 'Mid rule body.'),
    R('gone', 'Retracted rule.', { status: 'retracted' }),
    R('old-high', 'Old high rule.', { weight: 10 }),
    R('newer', 'Replaces old-high.', { supersedes: 'old-high' }),
  ];
  const out = buildMemoryIndex(facts);
  const at = (t) => out.indexOf(t);
  assert(at('# Project rules') >= 0 && at('# Project rules') < at('# Project memory'), 'rules block first');
  assert(at('## high') < at('## mid') && at('## mid') < at('## low'), `weight order high(9) > mid(5) > low(2): ${[at('## high'), at('## mid'), at('## low')]}`);
  assert(out.includes('High rule body — long enough to see.'), 'full body injected');
  assert(!out.includes('Retracted rule.') && !out.includes('Old high rule.'), 'retracted and superseded rules do not bind');
  assert(out.includes('Replaces old-high.'), 'the successor rule binds');
  assert(!/\*\*high\*\* \(rule\)/.test(out), 'a rule is not also an index line');
  assert(/owner's explicit instruction/.test(out), 'the owner outranks the rules');
  assert(out.includes('**a-fact** (reference)') || out.includes('**a-fact** (project)'), 'ordinary facts still listed');
  // rules only, no other facts → just the rules block; no rules → no block
  assert(buildMemoryIndex([R('only', 'Only rule.')]).startsWith('\n\n# Project rules') && !/# Project memory/.test(buildMemoryIndex([R('only', 'Only rule.')])), 'rules alone render alone');
  assert(!/# Project rules/.test(buildMemoryIndex([P('x')])), 'no rules → no rules block');
  // a rule may supersede an ordinary fact; the retracted footer survives a rules-only index
  const ruleOver = buildMemoryIndex([P('oldfact', { description: 'old claim' }), R('r', 'Rule replacing it.', { supersedes: 'oldfact' })]);
  assert(/\*\*oldfact\*\*.*superseded by \*\*r\*\*/.test(ruleOver), 'a fact superseded by a rule is tagged');
  assert(/1 fact\(s\) were retracted/.test(buildMemoryIndex([R('only', 'Only rule.'), P('dead', { status: 'retracted' })])), 'retracted footer survives when only rules are live');
});

await test('rules: weight round-trips (1–10, default 5 omitted); the cap errors before the write', () => {
  const w = parseFact(serializeFact({ ...R('r', 'b'), weight: 8 })); eq(w.weight, 8, 'weight kept');
  eq(parseFact(serializeFact({ ...R('r', 'b'), weight: 5 })).weight, 5, 'default weight');
  assert(!/weight:/.test(serializeFact({ ...R('r', 'b'), weight: 5 })), 'default weight not written');
  eq(parseFact('---\nname: r\ntype: rule\nweight: 99\n---\nb').weight, 5, 'out-of-range → default');
  eq(RULES_CAP_CHARS, 4000, 'cap pinned');
  // The cap counts what is INJECTED, headings and separators included (forward-pass S-4), so a
  // 3900-char body costs 3907 with its "## big\n" heading, not 3900.
  const big = R('big', 'x'.repeat(3900));
  const ok = checkRulesCap([big], 'y'.repeat(50));
  assert(ok.ok && ok.total === 3907 && ok.next === 3971, JSON.stringify(ok));
  const over = checkRulesCap([big], 'y'.repeat(200));
  assert(!over.ok && over.next === 4121 && over.count === 1, JSON.stringify(over));
  assert(/capped at 4000/.test(rulesCapReply(over)) && /4121/.test(rulesCapReply(over)) && /`revise`/.test(rulesCapReply(over)), rulesCapReply(over));
  // the property the cap exists for: anything it passes must actually RENDER within the cap
  const many = [1,2,3,4,5,6,7,8,9,10].map((n) => R('rule-number-' + n, 'z'.repeat(380)));
  const verdict = checkRulesCap(many, 'w'.repeat(40));
  const bodiesOnly = many.reduce((t, r) => t + String(r.body || '').length, 0);
  assert(verdict.total > bodiesOnly, `headings are counted, not just bodies (${verdict.total} > ${bodiesOnly})`);
  assert(buildMemoryIndex(many).includes(many.map((r) => `## ${r.name}\n${String(r.body).trim()}`).join('\n\n')), 'the cap measures the exact text that is injected');
  // the incoming rule is measured with ITS OWN heading, not a placeholder: a long slug and a
  // hypothesis marker both cost real characters in the injected block
  const plain = checkRulesCap([], 'body');
  const named = checkRulesCap([], 'body', { name: 'a-very-long-rule-name-indeed', status: 'hypothesis' });
  assert(named.next > plain.next + 20, `the prospective rule's own heading is counted (${named.next} vs ${plain.next})`);
  const gone = checkRulesCap([R('dead', 'x'.repeat(3900), { status: 'retracted' })], 'y'.repeat(200)); assert(gone.ok, 'a retracted rule frees its space');
  assert(/lessons, not logs/i.test(LESSON_CONTRACT) && /next time/.test(LESSON_CONTRACT), 'the contract says the two load-bearing things');
});

// ───────────────────────────── created: the slot's recency signal (S-3) ──

await test('created: round-trips, and an unparseable one degrades to absent', () => {
  const f = parseFact('---\nname: a\ndescription: d\ntype: project\ncreated: 2026-09-07T10:00:00.000Z\n---\nbody');
  eq(f.created, '2026-09-07T10:00:00.000Z', 'parsed');
  assert(/^created: 2026-09-07T10:00:00\.000Z$/m.test(serializeFact(f)), 'serialized on its own line:\n' + serializeFact(f));
  eq(parseFact(serializeFact(f)).created, f.created, 'round-trip');
  eq(parseFact('---\nname: a\ndescription: d\ntype: project\ncreated: last tuesday\n---\nb').created, null, 'garbage → absent, not an error');
  eq(parseFact('---\nname: a\ndescription: d\ntype: project\n---\nb').created, null, 'absent stays absent');
  assert(!/created:/.test(serializeFact({ name: 'a', description: 'd', type: 'project', body: 'b' })), 'an untimed fact writes no created line');
});

await test('noteToFact stamps created, and honours an injected one', () => {
  const fixed = noteToFact('The db is postgres', 'project', null, { created: '2020-01-02T03:04:05Z' });
  eq(fixed.created, '2020-01-02T03:04:05.000Z', 'injected time is used verbatim (normalised)');
  eq(parseFact(fixed.file).created, fixed.created, 'it reaches the file');
  const now = noteToFact('The db is mysql', 'project');
  assert(Math.abs(Date.parse(now.created) - Date.now()) < 60000, `stamped from the clock: ${now.created}`);
});

await test('slotHolder prefers the recorded time over array order, and degrades to disk order', () => {
  const F = (name, created) => ({ name, description: name, type: 'project', status: null, slot: 'phase',
    supersedes: [], derived_from: [], contradicts: [], created, body: name });
  // ALPHABETICALLY sorted — the array order says `c-old` is last, the clock says `a-new` is newest.
  const sorted = [F('a-new', '2026-09-07T10:00:00Z'), F('b-mid', '2026-05-01T00:00:00Z'), F('c-old', '2020-01-01T00:00:00Z')];
  eq(slotHolder(sorted, 'phase'), 'a-new', 'the chronologically newest holds the slot, not the last in the array');
  // reversing the array must not change the answer — that is the whole point of the field
  eq(slotHolder([...sorted].reverse(), 'phase'), 'a-new', 'the answer is order-independent once times exist');
  // no times at all → exactly the old behaviour, disk order
  const untimed = [F('first', null), F('second', null), F('third', null)];
  eq(slotHolder(untimed, 'phase'), 'third', 'an all-untimed store still answers by disk order');
  // mixed: a timed fact beats an untimed one wherever it sits in the array
  eq(slotHolder([F('timed', '2001-01-01T00:00:00Z'), F('untimed', null)], 'phase'), 'timed',
    'a fact that recorded when it was written beats one that never did, even when it comes first');
  // supersedes still wins over time: an older fact that supersedes the newer one holds
  const superseding = [F('young', '2026-09-07T10:00:00Z'), { ...F('elder', '2001-01-01T00:00:00Z'), supersedes: ['young'] }];
  eq(slotHolder(superseding, 'phase'), 'elder', 'the supersedes graph is consulted before the clock');
  // retracted is never a holder, however new
  eq(slotHolder([F('live', '2001-01-01T00:00:00Z'), { ...F('dead', '2026-09-07T10:00:00Z'), status: 'retracted' }], 'phase'),
    'live', 'a retracted fact does not hold the slot no matter how recent');
});

if (failures.length){
  console.error(`memory-store: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`memory-store conformance: ${passed}/${passed} passed`);
