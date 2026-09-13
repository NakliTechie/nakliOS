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

import { extractJson, inferStructured, attemptsLine } from './structured.mjs';
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

// Tolerant JSON extraction — the first balanced value in the reply that parses with a proposals
// array (B4: the balanced scanner, so JSON wrapped in prose or a code fence, or preceded by another
// object, still comes out). Same contract as before: the proposals with a kind and a name, else [].
const wantProposals = (v) => Array.isArray(v?.proposals);
export function parseProposals(text) {
  const found = extractJson(text, { want: wantProposals });
  return found ? found.value.proposals.filter((p) => p && p.kind && p.name) : [];
}
// B4: what a reply must satisfy — the sentences the repair turn carries back to the model.
export function validateProposals(v) {
  const errors = [];
  if (!Array.isArray(v?.proposals)) return ['the JSON must be an object with a "proposals" array'];
  v.proposals.forEach((p, i) => {
    if (!p || typeof p !== 'object') { errors.push(`proposal ${i + 1} is not an object`); return; }
    if (p.kind !== 'skill' && p.kind !== 'fact') errors.push(`proposal ${i + 1} ("${String(p.name || '').slice(0, 40)}") needs "kind": "skill" or "fact"`);
    if (!p.name) errors.push(`proposal ${i + 1} has no "name"`);
  });
  return errors;
}

// Give a proposal the {goal, steps, paths} the fingerprint (C3) needs, defaulting from its fields.
function forFingerprint(p) {
  return { goal: p.goal || p.name || p.description || '', steps: Array.isArray(p.steps) ? p.steps : (p.content ? [String(p.content).slice(0, 200)] : [p.name || '']), paths: Array.isArray(p.paths) ? p.paths : [] };
}

// The fork. `infer` is the (narrow-toolset) model; `ledger` a proposal ledger (C3); `propose`
// the sink that STAGES a kept proposal (skill → planSkillWrite, fact → memory store) and returns
// { ok, staged } — it must never apply anything active. Returns a report; activeWrites is always 0.
// B4: the review's JSON goes through the structured ladder — `ladder` is an ordered list of
// { name, infer } rungs (the configured endpoint first; a fallback after it when the app has one);
// `infer` alone is a one-rung ladder. A malformed reply costs one repair turn that names what was
// wrong; the report carries the attempt trail, so a review that failed says how.
export async function runLearnReview({ record, infer = null, ladder = null, propose, ledger = null, now = Date.now() }) {
  const prompt = buildReviewPrompt(record);
  const rungs = Array.isArray(ladder) && ladder.length ? ladder : [{ name: 'default', infer }];
  const messages = [{ role: 'system', content: 'You are a terse reviewer. Reply only with the JSON described.' }, { role: 'user', content: prompt }];
  const res = await inferStructured({ ladder: rungs, messages, validate: validateProposals, extract: (text) => extractJson(text, { want: wantProposals }), retries: 1 });
  // ok → the validated reply; not ok → whatever parsed last, filtered item by item as the old parser
  // did (a reply with one malformed proposal among good ones still stages the good ones)
  const salvage = res.partial && Array.isArray(res.partial.proposals) ? res.partial.proposals : [];
  const proposals = (res.ok ? res.value.proposals : salvage).filter((p) => p && p.kind && p.name);
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
  return { prompt, proposalCount: proposals.length, staged, dropped: dropped.map((d) => ({ name: d.name, reason: d.reason })), activeWrites: 0,
    answered: res.ok, salvaged: !res.ok && proposals.length > 0, rung: res.rung, salvagedFrom: !res.ok && proposals.length > 0 ? res.partialRung : null, attempts: res.attempts, attemptsLine: attemptsLine(res) };
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
