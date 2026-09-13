#!/usr/bin/env node
// PG-A2 (CRIB-C C2, 2026-09-13): does the always-on index hurt? A FOLD over saved run records, not
// a rewrite. For every record: which facts and skills were IN CONTEXT (the [coordination] working
// context message the run opened with), which FIRED (a `recall` / `skill` call by that name), the
// task class (gated / ungated), and the outcome (foldOutcome). Then, per class: the share of
// in-context items that never fired, in completed runs vs failed ones — the correlation the paper's
// ablation predicts (an unlocalized index hurts long tool-heavy runs). A number with its n; not a
// verdict. Records come from a directory of exported dumps (OPFS `anvil/runs/**`) or the corpus.
//
//   node scripts/probe-index-usage.mjs [dir ...]      default: sys/history/corpus (which carries no index)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadRecord, joined, foldOutcome, isCorpusRecord } from '../sys/history/run-record.mjs';

// One working-context message → the fact names (the `# Project memory` list and the `# Project rules`
// headings, never a lookalike line in the project notes above them) and the skill names.
export function indexInContext(messages) {
  const ctx = (messages || []).find((m) => m && m.role === 'user' && /^\[coordination\] Working context for this run/.test(String(m.content || '')));
  if (!ctx) return null;
  return parseContext(String(ctx.content));
}
export function parseContext(text) {
  const facts = [], skills = [];
  const skillsAt = text.indexOf('\n# Skills');
  const skillPart = skillsAt >= 0 ? text.slice(skillsAt) : '';
  const memAt = text.indexOf('\n# Project memory'), rulesAt = text.indexOf('\n# Project rules');
  const memPart = memAt >= 0 ? text.slice(memAt, skillsAt >= 0 && skillsAt > memAt ? skillsAt : undefined) : '';
  const rulesPart = rulesAt >= 0 ? text.slice(rulesAt, memAt > rulesAt ? memAt : (skillsAt > rulesAt ? skillsAt : undefined)) : '';
  for (const m of rulesPart.matchAll(/^## ([^\n]+)$/mg)) facts.push(m[1].trim());
  for (const m of memPart.matchAll(/^- \*\*([^*]+)\*\* \(/mg)) facts.push(m[1]);
  for (const m of skillPart.matchAll(/^- \*\*([^*]+)\*\*:/mg)) skills.push(m[1]);
  return { facts: [...new Set(facts)], skills: [...new Set(skills)] };
}
// Every working-context message the record's loops opened with, UNIONED: a re-loop re-renders the
// context, and a fact remembered mid-run appears in the later one (the checker: 7 of 29 records
// carried 2-3 contexts with 8 items the first lacked).
export function indexAcrossRun(ev) {
  let any = false; const facts = new Set(), skills = new Set();
  for (const e of ev) {
    if (e.tool !== 'run.started') continue;
    for (const m of (e.input && e.input.messages) || []) {
      if (!(m && m.role === 'user' && /^\[coordination\] Working context for this run/.test(String(m.content || '')))) continue;
      any = true; const p = parseContext(String(m.content)); p.facts.forEach((f) => facts.add(f)); p.skills.forEach((s) => skills.add(s));
    }
  }
  return any ? { facts: [...facts], skills: [...skills] } : null;
}

export function probeRecord(rec) {
  const ev = joined(rec.events(), rec.resolve);
  const started = ev.find((e) => e.tool === 'run.started');
  if (!started) return null;
  const inCtx = indexAcrossRun(ev);
  const tools = ((started.input && started.input.tools) || []).map((t) => t && t.function && t.function.name).filter(Boolean);
  const cls = tools.includes('task_done') ? 'gated' : 'ungated';
  // fired, per kind: a `recall` fires a fact, a `skill` call fires a skill — never each other
  const firedFacts = new Set(), firedSkills = new Set();
  for (const e of ev) {
    if (e.tool !== 'tool.called' || !e.input.args || !e.input.args.name) continue;
    if (e.input.name === 'recall') firedFacts.add(String(e.input.args.name));
    if (e.input.name === 'skill') firedSkills.add(String(e.input.args.name));
  }
  const out = foldOutcome(rec.events(), rec.resolve);
  const outcome = (out && out.label) || 'unknown'; // success (a gate corroborated) · failure · unknown (unclaimed: no gate)
  if (!inCtx) return { cls, outcome, indexed: false, inContext: 0, fired: 0, neverFired: [] };
  const neverFired = [...inCtx.facts.filter((n) => !firedFacts.has(n)), ...inCtx.skills.filter((n) => !firedSkills.has(n))];
  const inContext = inCtx.facts.length + inCtx.skills.length;
  return { cls, outcome, indexed: true, inContext, fired: inContext - neverFired.length, neverFired };
}

export function summarize(rows) {
  const by = {};
  for (const r of rows) {
    const k = r.cls; by[k] = by[k] || { runs: 0, indexed: 0, byOutcome: {} };
    by[k].runs++; if (r.indexed) by[k].indexed++;
    const o = by[k].byOutcome[r.outcome] = by[k].byOutcome[r.outcome] || { runs: 0, inContext: 0, neverFired: 0 };
    o.runs++; o.inContext += r.inContext; o.neverFired += r.neverFired.length;
  }
  const never = {};
  for (const r of rows) for (const n of r.neverFired) never[n] = (never[n] || 0) + 1;
  return { by, neverFiredMost: Object.entries(never).sort((a, b) => b[1] - a[1]).slice(0, 10) };
}

function loadDir(dir, dropped) {
  const out = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (isCorpusRecord(n)) { try { out.push({ path: p, rec: loadRecord(JSON.parse(readFileSync(p, 'utf8'))) }); } catch (e) { dropped.push(p + ': ' + (e && e.message)); } } } };
  walk(dir); return out;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const dirs = process.argv.slice(2); const dropped = [];
  const recs = dirs.length ? dirs.flatMap((d) => loadDir(d, dropped)) : loadDir(new URL('../sys/history/corpus/', import.meta.url).pathname, dropped);
  const rows = recs.map(({ rec }) => probeRecord(rec)).filter(Boolean);
  const s = summarize(rows);
  console.log(`index-usage probe: ${rows.length} record(s), ${rows.filter((r) => r.indexed).length} with an index in context${dropped.length ? `, ${dropped.length} file(s) could not be read` : ''}`);
  for (const d of dropped) console.log('  dropped: ' + d);
  const distinct = new Set(rows.flatMap((r) => r.neverFired)).size;
  const everInContext = rows.reduce((n, r) => n + r.inContext, 0);
  console.log(`  items in context ${everInContext} (${distinct} distinct never fired); records with more than one working context: ${recs.filter(({ rec }) => joined(rec.events(), rec.resolve).filter((e) => e.tool === 'run.started').length > 1).length}`);
  for (const [cls, g] of Object.entries(s.by)) {
    console.log(`  ${cls}: ${g.runs} run(s), ${g.indexed} indexed`);
    for (const [o, x] of Object.entries(g.byOutcome)) console.log(`    ${o}: ${x.runs} run(s) · in context ${x.inContext} · never fired ${x.neverFired}${x.inContext ? ` (${Math.round(100 * x.neverFired / x.inContext)}%)` : ''}`);
  }
  if (s.neverFiredMost.length) console.log('  never fired most: ' + s.neverFiredMost.map(([n, c]) => `${n} ×${c}`).join(', '));
  if (!rows.some((r) => r.indexed)) console.log('  NO ANSWER from these records — none opened with a working-context message; export app runs (OPFS anvil/runs/**) and point the probe at them.');
}
