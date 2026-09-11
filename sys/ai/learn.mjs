// The post-run review fork (C2).
// After a run, a NARROW-toolset pass reads the run's record and asks "should any skill or fact
// be saved or updated?" — and every output is STAGED, never applied. Nothing here writes: the
// caller supplies a `propose` sink (which routes a skill through planSkillWrite → staged, a fact
// through the memory store) and a proposal `ledger` (C3) so a rejected proposal is not
// re-proposed. Pure orchestration over injected infer/propose/ledger — headless-testable.
//
// The model is asked for JSON: { proposals: [ { kind:'skill'|'fact', name, description?,
// content?, note?, goal?, steps?, paths? } ] }. Anything else parses to zero proposals (a
// review that proposes nothing is the common, correct case).

import { filterProposals, createProposalLedger } from './proposal-fingerprint.mjs';
import { foldTranscript, foldSessionContext, foldDecisions, foldOutcome } from '../history/run-record.mjs';

// Build the review prompt from the record's folds. Bounded — the transcript is summarised to
// its shape, not dumped, so the review is cheap.
export function buildReviewPrompt(record) {
  const ev = record.events(), resolve = record.resolve;
  const ctx = foldSessionContext(ev, resolve);
  const decisions = foldDecisions(ev, resolve);
  const outcome = foldOutcome(ev, resolve);
  const passed = decisions.filter((d) => d.outcome === 'passed').map((d) => d.name);
  const failed = decisions.filter((d) => d.outcome === 'failed').map((d) => d.name);
  return [
    'You are reviewing a finished coding run to decide what is worth REMEMBERING for next time.',
    `Goal: ${ctx.goal || '(none recorded)'}`,
    `Outcome: ${outcome.label}${outcome.note ? ` (${outcome.note})` : ''}`,
    `Files touched: ${ctx.filesTouched.join(', ') || '(none)'}`,
    passed.length ? `Tools that led to a gate pass: ${passed.join(', ')}` : '',
    failed.length ? `Tools that led to a gate failure: ${failed.join(', ')}` : '',
    ctx.lastCheckpoint ? `Last checkpoint: ${ctx.lastCheckpoint}` : '',
    'Propose at most a few durable skills or facts (lessons, not logs). Reply ONLY with JSON:',
    '{ "proposals": [ { "kind": "skill"|"fact", "name": "...", "description": "...", "content": "...", "goal": "...", "steps": ["..."], "paths": ["..."] } ] }',
    'If nothing is worth saving, reply { "proposals": [] }.',
  ].filter(Boolean).join('\n');
}

// Tolerant JSON extraction — the first {...} block that parses with a proposals array.
export function parseProposals(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{'); if (start < 0) return [];
  for (let end = s.lastIndexOf('}'); end > start; end = s.lastIndexOf('}', end - 1)) {
    try { const o = JSON.parse(s.slice(start, end + 1)); if (Array.isArray(o?.proposals)) return o.proposals.filter((p) => p && p.kind && p.name); } catch (_) { /* keep shrinking */ }
  }
  return [];
}

// Give a proposal the {goal, steps, paths} the fingerprint (C3) needs, defaulting from its fields.
function forFingerprint(p) {
  return { goal: p.goal || p.name || p.description || '', steps: Array.isArray(p.steps) ? p.steps : (p.content ? [String(p.content).slice(0, 200)] : [p.name || '']), paths: Array.isArray(p.paths) ? p.paths : [] };
}

// The fork. `infer` is the (narrow-toolset) model; `ledger` a proposal ledger (C3); `propose`
// the sink that STAGES a kept proposal (skill → planSkillWrite, fact → memory store) and returns
// { ok, staged } — it must never apply anything active. Returns a report; activeWrites is always 0.
export async function runLearnReview({ record, infer, ledger = null, propose, now = Date.now() }) {
  const prompt = buildReviewPrompt(record);
  const reply = await infer({ messages: [{ role: 'system', content: 'You are a terse reviewer. Reply only with the JSON described.' }, { role: 'user', content: prompt }], tools: [] });
  const proposals = parseProposals(reply?.content ?? '');
  // fingerprint + poison-check: a proposal the reviewer already rejected is dropped.
  // Index-carried, because two proposals can share a name and kind: find() then returned the
  // FIRST match, so a poisoned proposal's CONTENT was staged under a clean one's fingerprint
  // — the exact re-proposal the poison ledger exists to stop (forward-pass NAF-03).
  const withFp = proposals.map((p, i) => ({ ...p, ...forFingerprint(p), _idx: i }));
  // Always fingerprint (an empty ledger drops nothing) so every staged proposal carries its fp —
  // the reviewer/poison memory keys on it whether or not a ledger was supplied.
  const { kept, dropped } = await filterProposals(ledger || createProposalLedger(), withFp, { now });
  const staged = [];
  for (const p of kept) {
    // reattach the original proposal fields (kept carries the fingerprint form)
    const orig = (Number.isInteger(p._idx) ? proposals[p._idx] : null) || p;
    const r = propose ? await propose({ ...orig, fp: p.fp }) : { ok: false };
    if (r && r.ok) staged.push({ kind: orig.kind, name: orig.name, fp: p.fp, staged: r.staged ?? true });
  }
  return { prompt, proposalCount: proposals.length, staged, dropped: dropped.map((d) => ({ name: d.name, reason: d.reason })), activeWrites: 0 };
}

// C5: when may the post-run review run UNATTENDED? Defer on a local model until idle; skip an
// aborted run (nothing to learn); otherwise fire. Pure predicate.
export const AUTO_REVIEW_IDLE_MS = 15_000;
export function shouldAutoReview({ outcome, stop, idleMs = 0, isLocalModel = false } = {}) {
  if (stop === 'aborted') return { review: false, why: 'aborted — nothing to learn' };
  if (outcome === 'unknown' && stop !== 'done') return { review: false, why: 'no outcome signal' };
  if (isLocalModel && idleMs < AUTO_REVIEW_IDLE_MS) return { review: false, why: `local model — deferring until ${AUTO_REVIEW_IDLE_MS}ms idle` };
  return { review: true, why: 'reviewing' };
}

// The explicit tool/handler name Anvil exposes for "Learn this run".
export function learnReviewTool() {
  return { type: 'function', function: { name: 'learn_this_run',
    description: 'Review the run that just finished and propose durable skills or facts worth keeping. Everything is STAGED for you to approve — nothing is saved active.',
    parameters: { type: 'object', properties: {} } } };
}
