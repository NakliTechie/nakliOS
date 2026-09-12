#!/usr/bin/env node
// AC-2 — does Anvil's always-on index cost QUALITY, or only tokens?
//   node scripts/probe-context-payload.mjs [dir-of-run-records ...]
//
// `buildSkillsIndex` + `buildMemoryIndex` are sent whole on every run (change-gated), after which
// they ride the retained transcript for every step. The prefix-cache design treats that purely as
// COST. The procedural-graph ablation (arXiv:2609.09153) says it is also QUALITY: same graph,
// full-and-raw beat no-graph on dialogue but LOST on embodied execution (72.58 -> 70.34), and
// full-and-summarised collapsed it (-> 54.48), while a localized 2-hop subgraph won all three.
// Long tool-heavy runs are Anvil's workload — that is the arm that would bite us.
//
// The question, made concrete: do skills and facts that sit in context and NEVER FIRE correlate
// with worse outcomes in the task classes where they never fire?
//
// WHY THIS IS A SCRIPT AND NOT A FOLD. Every fold in run-record.mjs reads the event chain. This
// reads the rendered SYSTEM PROMPT with a regex, because that is the only place the in-context set
// is recorded. Prompt formatting is not a substrate invariant — reword buildSkillsIndex and this
// breaks, which is exactly why it must not live where foldOutcome lives. It is a probe. It reports
// what it could not parse rather than assuming it parsed everything.
import { readFile, readdir, stat } from 'node:fs/promises';
import { loadRecord, foldOutcome, joined, isCorpusRecord } from '../sys/history/run-record.mjs';

// ── what was IN CONTEXT: the index blocks, as buildSkillsIndex/buildMemoryIndex render them ──
// Each block renders its entries differently, and getting this wrong is silent: a pattern that
// matches nothing reports the block as pure dead weight rather than as unparsed. Skills and facts
// are list items (`- **name**`); RULES are rendered by renderRule as `## name` headings, with no
// list marker and no bold. `unparsed` below exists because that mistake was made once here.
const LIST_ENTRY = /^- \*\*(.+?)\*\*/gm;
const RULE_ENTRY = /^## (.+?)\s*$/gm;
const BLOCKS = [
  { heading: '# Skills', kind: 'skill', entry: LIST_ENTRY },
  { heading: '# Project rules', kind: 'rule', entry: RULE_ENTRY },
  { heading: '# Project memory', kind: 'fact', entry: LIST_ENTRY },
  { heading: '# Memory', kind: 'fact', entry: LIST_ENTRY },
];

function inContext(systemText) {
  const found = [];
  const unparsed = [];
  for (const { heading, kind, entry } of BLOCKS) {
    const at = systemText.indexOf(heading);
    if (at < 0) continue;
    // the block runs to the next top-level heading or the end
    const rest = systemText.slice(at + heading.length);
    const nextH = rest.search(/\n# /);
    const body = nextH < 0 ? rest : rest.slice(0, nextH);
    const names = [...body.matchAll(entry)].map((m) => m[1].trim().replace(/\s*_\(.*\)_$/, ''));
    if (!names.length) unparsed.push(heading);
    for (const name of names) found.push({ name, kind });
  }
  return { found, unparsed };
}

// ── what FIRED ──
// Both are attributed at the EVENT level, from the call's own arguments. An earlier version
// text-matched fact names out of recall RESULTS, on the belief that `recall` was a free-text
// query — it is not: `recallTool` (memory-store.mjs:500) takes `name`, "the fact name, exactly as
// listed". So the call itself names the fact, and the result never needs parsing. Result text is
// still scanned as a fallback, because a fact can also be named in a result the agent read.
// A RULE is injected whole and is never called. It cannot be attributed at all, in principle, and
// counting it as "never fired" would be the single most misleading number this probe could print.
function fired(rec) {
  const skills = new Set(); const facts = new Set();
  const ev = joined(rec.events(), rec.resolve);
  for (const e of ev) {
    if (e.tool === 'tool.called' && e.input?.name === 'skill' && e.input?.args?.name) skills.add(String(e.input.args.name));
    if (e.tool === 'tool.called' && e.input?.name === 'recall' && e.input?.args?.name) facts.add(String(e.input.args.name));
    if (e.tool === 'tool.responded' && e.input?.name === 'recall') {
      const text = typeof e.output?.result === 'string' ? e.output.result : JSON.stringify(e.output?.result ?? '');
      for (const m of text.matchAll(/\*\*(.+?)\*\*/g)) facts.add(m[1].trim());
    }
  }
  return { skills, facts };
}

// Where the index rides. Since F3 the app sends it as a tagged context message AFTER the prompt,
// never in the system prefix — so a probe that read only the system message saw "no index" on
// every real record (surfaced by N1, when the capture bed started sending it the app's way).
// Both places are read: older records and hand-built beds put it in the system message.
const CONTEXT_TAG = '[coordination] Working context for this run';
function systemOf(rec) {
  const start = joined(rec.events(), rec.resolve).find((e) => e.tool === 'run.started');
  const msgs = start?.input?.messages || [];
  return msgs.filter((m) => m?.role === 'system' || (m?.role === 'user' && String(m.content || '').startsWith(CONTEXT_TAG)))
    .map((m) => String(m.content || '')).join('\n');
}

// Task class: the run's tool set. Record-derived and stable — the same proxy groupOrdering uses.
function classOf(rec) {
  const start = joined(rec.events(), rec.resolve).find((e) => e.tool === 'run.started');
  const names = (start?.input?.tools || []).map((t) => t?.function?.name ?? t?.name).filter(Boolean).sort();
  return names.length ? names.join('+') : 'no-tools';
}

export function probe(records) {
  const rows = [];
  let eligible = 0, noIndex = 0;
  const unparsed = new Set();
  for (const rec of records) {
    const sys = systemOf(rec);
    const { found, unparsed: u } = inContext(sys);
    u.forEach((h) => unparsed.add(h));
    if (!found.length) { noIndex++; continue; }
    eligible++;
    const f = fired(rec);
    const label = foldOutcome(rec.events(), rec.resolve).label;
    const cls = classOf(rec);
    for (const item of found) {
      const used = item.kind === 'skill' ? f.skills.has(item.name)
                 : item.kind === 'fact' ? f.facts.has(item.name)
                 : null;                                   // rule: unattributable, by design
      rows.push({ class: cls, label, name: item.name, kind: item.kind, used });
    }
  }
  return { rows, eligible, noIndex, total: records.length, unparsed: [...unparsed] };
}

/**
 * AC-9's cheap first cut: which items were carried on runs that DIDN'T finish, and never fired
 * anywhere at all?
 *
 * The full write-admission gate — does a remembered lesson improve later runs? — needs replay and
 * a held-out comparison. This is the version that needs neither: an item present on failing runs,
 * absent from every success, and never once loaded, is at best paying rent. It is a SUSPECT LIST,
 * not a verdict; `carriedOnFailures` counts runs, and at small n that number is mostly noise.
 *
 * Rules are excluded here for the same reason they are excluded everywhere else in this file:
 * injected whole, never called, unattributable in principle.
 */
export function suspects(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.used === null) continue;
    const k = `${r.kind}:${r.name}`;
    const e = by.get(k) || { kind: r.kind, name: r.name, everFired: false, onFailures: 0, onSuccesses: 0, seen: 0 };
    e.seen++;
    if (r.used) e.everFired = true;
    if (r.label === 'success') e.onSuccesses++;
    else if (r.label === 'failure') e.onFailures++;
    by.set(k, e);
  }
  return [...by.values()]
    .filter((e) => !e.everFired && e.onFailures > 0 && e.onSuccesses === 0)
    .sort((a, b) => b.onFailures - a.onFailures || a.name.localeCompare(b.name));
}

// Per class: of the items that sat in context, what share never fired, split by outcome. The
// correlation AC-2 asks for is between "carried dead weight" and "did worse".
export function summarise(rows) {
  const by = new Map();
  for (const r of rows) {
    if (r.used === null) continue;                          // rules never enter the arithmetic
    const g = by.get(r.class) || { class: r.class, byLabel: {} };
    const L = (g.byLabel[r.label] ||= { inContext: 0, fired: 0, runsSeen: 0 });
    L.inContext++; if (r.used) L.fired++;
    by.set(r.class, g);
  }
  return [...by.values()].map((g) => ({
    class: g.class,
    byLabel: Object.fromEntries(Object.entries(g.byLabel).map(([k, v]) => [k, {
      ...v, deadShare: v.inContext ? Math.round((1 - v.fired / v.inContext) * 100) / 100 : null,
    }])),
  }));
}

async function loadDir(dir) {
  const out = [];
  let names = [];
  try { names = await readdir(dir); } catch (_) { return out; }
  for (const n of names) {
    if (!isCorpusRecord(n)) continue;
    const p = new URL(n, dir.href ? dir : new URL(`file://${dir}/`));
    try {
      if ((await stat(p)).isFile()) out.push(loadRecord(JSON.parse(await readFile(p, 'utf8'))));
    } catch (_) { /* not a record */ }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2);
  const records = [];
  if (dirs.length) for (const d of dirs) records.push(...await loadDir(new URL(`file://${d.replace(/\/?$/, '/')}`)));
  else records.push(...await loadDir(new URL('../sys/history/corpus/', import.meta.url)));

  const r = probe(records);
  console.log(`records read: ${r.total}`);
  console.log(`  carried an index (eligible): ${r.eligible}`);
  console.log(`  no index in the system prompt or context message: ${r.noIndex}`);
  if (r.unparsed.length) console.log(`  block headings found but with no parseable entries: ${r.unparsed.join(', ')}`);

  if (!r.eligible) {
    // This is the honest outcome, not an error. A probe that printed a table over zero
    // observations would be manufacturing the finding it was written to look for.
    console.log('\nNO ANSWER. Not "no signal" — no DATA: not one record carried a skills or memory');
    console.log('index, so there is nothing here to correlate. Anvil\'s real runs persist to OPFS in');
    console.log('the browser; the repo corpus was captured from a bare harness prompt with no index.');
    console.log('\nWhat would make this answerable: capture bed runs on a project that HAS skills and');
    console.log('facts, export the records, and re-run this against them. AC-10 (localization) stays');
    console.log('gated until then — and closes unbuilt if the answer comes back null.');
    process.exit(0);
  }
  console.log('');
  for (const g of summarise(r.rows)) {
    console.log(`class ${g.class}`);
    for (const [label, v] of Object.entries(g.byLabel)) {
      console.log(`  ${label.padEnd(8)} in-context ${String(v.inContext).padStart(4)}  fired ${String(v.fired).padStart(4)}  never-fired share ${v.deadShare}`);
    }
  }
  const susp = suspects(r.rows);
  if (susp.length) {
    console.log('\nAC-9 suspects — carried on runs that did not finish, never fired anywhere:');
    for (const e of susp) console.log(`  ${e.kind.padEnd(6)} ${e.name.padEnd(20)} on ${e.onFailures} unfinished run(s), 0 successes, 0 uses`);
    console.log('  A suspect list, not a verdict: at this n, "never fired" is as likely to mean');
    console.log('  "the tasks never needed it" as "it is dead weight". Read it as where to look.');
  } else if (r.eligible) {
    console.log('\nAC-9 suspects: none — every carried item either fired somewhere or appeared on a run that finished.');
  }
  const rules = r.rows.filter((x) => x.used === null).length;
  if (rules) console.log(`\n(${rules} rule entries excluded: injected whole, never called, unattributable by design.)`);
}
