// Proposal fingerprints + poison memory (C3). A review fork will propose skills and
// facts; the P0 reviewer will reject some. Without a memory of refusal the next run
// re-proposes the same thing. So a rejected candidate's fingerprint is written with a
// cooloff, and a re-run never proposes that fingerprint. Pure.
//
// The fingerprint is a canonical identity for a PROPOSAL, not its wording:
//   fp:v1:sha256( goal=<tokens sorted deduped> | steps=<skeleton|per|step, order kept>
//                 | paths=<top-K sorted> )
// with five stability properties, pinned by property tests:
//   P1 determinism · P2 permutation invariance of goal tokens / casing / path order
//   P3 step ORDER is significant, words within a step are order-preserved and
//      stopword-stripped · P4 top-K stability (paths sorted, first K kept — a path
//      that sorts after the K-th does not change it; this is lexical, not centrality)
//   P5 token normalisation (plural stripping, stopwords) absorbs surface changes.
// Any change to the canonical form bumps the version — v2 fingerprints must not
// collide with v1 rejections, so the cooloff memory stays meaningful.
//
// Rejections live on their OWN ledger, not in a run record: a rejection happens in
// the reviewer, outside any loop, and the run vocabulary (RUN_EVENTS) stays the
// loop's. Same appendEvent contract as History, so the chain is tamper-evident.

import { appendEvent, contentHash, verifyChain, toNDJSON, fromNDJSON, eventHash } from '../history/ledger.mjs';

export const FINGERPRINT_VERSION = 'v1';
export const DEFAULT_TOP_K_PATHS = 5;
export const DEFAULT_COOLOFF_DAYS = 14;
export const PROPOSAL_EVENTS = Object.freeze(['proposal.rejected']);

// Negation is NEVER a stopword: a rejection memory that cannot tell "do not deploy" from
// "deploy" would poison a goal's opposite (the checker's finding). `do/does/did` stay too —
// they carry the negation in English.
const STOPWORDS = new Set(('a an the and or of to in on for with by at from as is are be was were it its this that ' +
  'these those into over under then than so if use using used via per all any some').split(' '));

// One token: lower-case, letters/digits only, simple plural stripped, stopwords out.
export function normToken(w) {
  let t = String(w == null ? '' : w).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!t || STOPWORDS.has(t)) return '';
  if (t.length > 4 && t.endsWith('ies')) t = t.slice(0, -3) + 'y';
  else if (t.length > 4 && t.endsWith('es') && /(s|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2); // boxes → box, but services → service
  else if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) t = t.slice(0, -1);
  return t;
}
function tokensOf(text) { return String(text == null ? '' : text).split(/[^A-Za-z0-9]+/).map(normToken).filter(Boolean); }
function normPath(p) { return String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/^\/+/, ''); }

// The canonical form — inspectable, so a test can say WHY two proposals match.
export function canonicalize({ goal = '', steps = [], paths = [] } = {}, { topK = DEFAULT_TOP_K_PATHS } = {}) {
  const goalTokens = [...new Set(tokensOf(goal))].sort();
  const stepSkeletons = (Array.isArray(steps) ? steps : [steps]).map((s) => tokensOf(s).join(' ')).filter(Boolean);
  const pathList = [...new Set((Array.isArray(paths) ? paths : [paths]).map(normPath).filter(Boolean))].sort().slice(0, topK);
  return { goal: goalTokens, steps: stepSkeletons, paths: pathList };
}
export function canonicalString(c) { return `goal=${c.goal.join(' ')}\nsteps=${c.steps.join('|')}\npaths=${c.paths.join(',')}`; }

export async function fingerprint(proposal, opts) {
  const c = canonicalize(proposal, opts);
  const h = await contentHash(canonicalString(c)); // 'sha256:<hex>'
  return `fp:${FINGERPRINT_VERSION}:${h.slice('sha256:'.length)}`;
}

// ───────────────────────────────────────────────── the poison ledger ──

// A tiny chain of proposal.* events with payloads by hash — same shape as the run
// recorder, same tamper-evidence, its own vocabulary.
// `seed` (PG-A3): a stored export ({events, blobs}) to continue — rejections persist across sessions.
export function createProposalLedger({ app = 'anvil', principal = 'local', now = () => Date.now(), seed = null } = {}) {
  const events = []; const blobs = new Map(); let head = null; let queue = Promise.resolve();
  if (seed && seed.events) {
    const evs = typeof seed.events === 'string' ? fromNDJSON(seed.events) : seed.events.slice();
    for (const e of evs) events.push(e);
    for (const [k, v] of (seed.blobs instanceof Map ? seed.blobs : Object.entries(seed.blobs || {}))) blobs.set(k, v);
  }
  async function append(tool, input, output) {
    if (head === null && events.length) head = await eventHash(events[events.length - 1]); // continuing a seeded chain
    const { event, head: h } = await appendEvent(head, { ts: now(), principal, door: 'call', tool, app, input, output, grant_id: null });
    head = h; events.push(event); blobs.set(event.input_hash, input); blobs.set(event.output_hash, output); return event;
  }
  const enqueue = (tool, input, output) => { const p = queue.then(() => append(tool, input, output)); queue = p.catch(() => {}); return p; };
  return {
    // Record a rejection: the fingerprint, why, and how long it stays poisoned.
    // `label` (PG-A3): the proposal in words, so the next review can be TOLD what was refused.
    reject({ fp, reason = '', cooloffDays = DEFAULT_COOLOFF_DAYS, by = principal, label = '' } = {}) {
      if (!/^fp:v\d+:[0-9a-f]{64}$/.test(String(fp))) return Promise.reject(new Error(`not a fingerprint: ${fp}`));
      const lbl = String(label || '').replace(/\s+/g, ' ').trim().slice(0, 200); // one line: it is printed as a bullet in the next review's prompt
      return enqueue('proposal.rejected', { fp, by, ...(lbl ? { label: lbl } : {}) }, { reason: String(reason).replace(/\s+/g, ' ').trim().slice(0, 500), cooloff_days: Number(cooloffDays) || 0 });
    },
    settled() { return queue; },
    events() { return events.slice(); },
    head() { return head; },
    resolve(e) { return { input: blobs.get(e.input_hash), output: blobs.get(e.output_hash) }; },
    verify() { return verifyChain(events); },
    export() { return { events: toNDJSON(events), blobs: Object.fromEntries(blobs) }; },
  };
}
export function loadProposalLedger({ events, blobs }) {
  const evs = typeof events === 'string' ? fromNDJSON(events) : events.slice();
  const map = blobs instanceof Map ? new Map(blobs) : new Map(Object.entries(blobs || {}));
  return { events: () => evs.slice(), resolve: (e) => ({ input: map.get(e.input_hash), output: map.get(e.output_hash) }), verify: () => verifyChain(evs), head: () => null };
}

// Is this fingerprint poisoned at `now`? The LATEST rejection decides; a cooloff of 0
// never poisons. Read-only fold over the ledger.
export function isPoisoned(ledger, fp, now = Date.now()) {
  let last = null;
  for (const e of ledger.events()) {
    if (e.tool !== 'proposal.rejected') continue;
    const { input, output } = ledger.resolve(e) || {};
    if (!input || input.fp !== fp) continue;
    last = { ts: e.ts, cooloffDays: Number(output?.cooloff_days) || 0, reason: output?.reason || '' };
  }
  if (!last) return { poisoned: false, until: null, reason: null };
  const until = last.ts + last.cooloffDays * 86_400_000;
  return { poisoned: now < until, until, reason: last.reason };
}

// PG-A3: what is poisoned right now, in words — the list the next review is told, so the model does
// not spend a proposal on something the owner refused (the filter still drops an equivalent).
export function rejectedList(ledger, now = Date.now()) {
  const latest = new Map();
  for (const e of ledger.events()) {
    if (e.tool !== 'proposal.rejected') continue;
    const { input, output } = ledger.resolve(e) || {};
    if (!input || !input.fp) continue;
    latest.set(input.fp, { fp: input.fp, label: input.label || '', reason: output?.reason || '', until: e.ts + (Number(output?.cooloff_days) || 0) * 86_400_000 });
  }
  return [...latest.values()].filter((r) => now < r.until);
}

// The fork's gate: keep only proposals whose fingerprint is not poisoned. Each
// proposal is `{ goal, steps, paths, ... }`; the result carries its fp.
export async function filterProposals(ledger, proposals, { now = Date.now(), topK } = {}) {
  const kept = [], dropped = [];
  for (const p of (proposals || [])) {
    const fp = await fingerprint(p, { topK });
    const v = isPoisoned(ledger, fp, now);
    (v.poisoned ? dropped : kept).push({ ...p, fp, ...(v.poisoned ? { until: v.until, reason: v.reason } : {}) });
  }
  return { kept, dropped };
}
