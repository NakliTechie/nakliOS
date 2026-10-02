// Host-owned review bridge. App frames supply native diffs, while the host owns
// the registry, queue, rejection memory, and commit decision. A commit stays
// pending until the originating frame acknowledges its guarded application.
import { createReviewQueue } from './review-queue.mjs';
import { registerAppDiffTypes } from './diff-types.mjs';
import { createProposalLedger } from '../ai/proposal-fingerprint.mjs';
import { getDiffType } from './envelope.mjs';

const POISON_KEY = 'naklios.review.poison.v1';
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DIFF_CHARS = 256 * 1024;
const APP_TO_TOOL = Object.freeze({
  reckon: 'reckon.transaction',
  draft: 'draft.transaction',
  kanzen: 'kanzen.card-move',
});

function loadLedger(storage, now) {
  let seed = null;
  try {
    const raw = storage?.getItem(POISON_KEY);
    if (raw) seed = JSON.parse(raw);
  } catch (_) { /* An unavailable store leaves a session-local rejection ledger. */ }
  return createProposalLedger({ app: 'naklios', principal: 'person', now, seed });
}

export function createReviewHost({
  now = () => Date.now(),
  storage = null,
  sendDecision,
  onChange = () => {},
  record = async () => {},
  ackTimeoutMs = 10000,
} = {}) {
  if (typeof sendDecision !== 'function') throw new Error('review host needs sendDecision');
  if (!storage) { try { storage = globalThis.localStorage; } catch (_) {} }
  registerAppDiffTypes(['reckon', 'draft', 'kanzen']);
  const ledger = loadLedger(storage, now);
  const sources = new Map();
  const stagingSources = new Set();
  const applying = new Map();
  const queue = createReviewQueue({
    now,
    ledger,
    onApply(envelope) {
      const source = sources.get(envelope.proposal_id);
      if (!source) throw new Error('originating app closed');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          applying.delete(envelope.proposal_id);
          reject(new Error('app did not acknowledge the commit'));
        }, ackTimeoutMs);
        applying.set(envelope.proposal_id, { source, resolve, reject, timer });
        try { sendDecision(source, { type: 'naklios:review:commit', proposal_id: envelope.proposal_id }); }
        catch (error) {
          clearTimeout(timer);
          applying.delete(envelope.proposal_id);
          reject(error);
        }
      });
    },
  });

  async function stage({ source, app, tool, diff, expires = null, reversible = false } = {}) {
    if (!source) throw new Error('review stage needs its source frame');
    if (stagingSources.has(source) || [...sources.values()].includes(source)) {
      throw new Error('review the pending change before staging another');
    }
    stagingSources.add(source);
    try {
      if (typeof tool !== 'string' || !tool.trim() || tool.length > 120) throw new Error('invalid review tool');
      if (APP_TO_TOOL[app] !== tool) throw new Error('review tool does not match its app');
      let text;
      try { text = JSON.stringify(diff); } catch (_) { throw new Error('review diff is not JSON'); }
      if (!text || text.length > MAX_DIFF_CHARS) throw new Error('review diff exceeds the size limit');
      let preview;
      try { preview = getDiffType(app)?.normalize(diff); } catch (_) { /* Refuse a diff the reviewer cannot render. */ }
      if (!preview || !Array.isArray(preview.rows) || preview.rows.length === 0) {
        throw new Error('review diff has no renderable changes');
      }
      const deadline = expires == null ? now() + DEFAULT_TTL_MS : Number(expires);
      if (!Number.isFinite(deadline) || deadline <= now() || deadline > now() + MAX_TTL_MS) {
        throw new Error('review expiry must be in the next 24 hours');
      }
      if (await queue.isPoisoned({ app, tool, diff })) throw new Error('this change was discarded recently');
      const result = queue.stage({ app, tool, diff, expires: deadline, reversible });
      if (result.error) throw new Error(result.error);
      sources.set(result.proposal_id, source);
      onChange(queue.envelopes());
      try { await record('patch.staged', { app, proposal_id: result.proposal_id, tool }, { queued: true }); }
      catch (error) {
        queue.cancel(result.proposal_id);
        sources.delete(result.proposal_id);
        onChange(queue.envelopes());
        throw new Error(`History failed; review was not staged: ${String(error?.message || error)}`);
      }
      return result;
    } finally { stagingSources.delete(source); }
  }

  // The iframe identity and origin are verified by the shell before this call.
  // A duplicate acknowledgement never invokes the app callback a second time.
  function acknowledge({ source, proposal_id, ok, error } = {}) {
    const waiter = applying.get(proposal_id);
    if (!waiter || waiter.source !== source) return false;
    clearTimeout(waiter.timer);
    applying.delete(proposal_id);
    if (ok === true) waiter.resolve();
    else waiter.reject(new Error(String(error || 'app refused the staged change')));
    return true;
  }

  async function commit(proposal_id) {
    const entry = queue.list().find((item) => item.proposal_id === proposal_id);
    if (!entry) return { ok: false, reason: 'no such proposal' };
    const result = await queue.commit(proposal_id, { actor: 'person' });
    if (result.ok) {
      sources.delete(proposal_id);
      onChange(queue.envelopes());
      try { await record('patch.committed', { app: entry.app, proposal_id, tool: entry.tool }, { applied: true }); }
      catch (error) { return { ...result, historyError: String(error?.message || error) }; }
    }
    return result;
  }

  async function discard(proposal_id, reason = '') {
    const entry = queue.list().find((item) => item.proposal_id === proposal_id);
    if (!entry) return { ok: false, reason: 'no such proposal' };
    const result = await queue.discard(proposal_id, { reason });
    if (result.ok) {
      const source = sources.get(proposal_id);
      sources.delete(proposal_id);
      if (source) { try { sendDecision(source, { type: 'naklios:review:discard', proposal_id }); } catch (_) {} }
      try { storage?.setItem(POISON_KEY, JSON.stringify(ledger.export())); } catch (_) {}
      onChange(queue.envelopes());
      try { await record('patch.rejected', { app: entry.app, proposal_id, tool: entry.tool }, { reason }); }
      catch (error) { return { ...result, historyError: String(error?.message || error) }; }
    }
    return result;
  }

  async function detach(source) {
    const ids = [...sources].filter(([, frame]) => frame === source).map(([id]) => id);
    for (const id of ids) {
      const entry = queue.list().find(item => item.proposal_id === id);
      const waiter = applying.get(id);
      if (waiter) {
        clearTimeout(waiter.timer);
        applying.delete(id);
        waiter.reject(new Error('originating app closed'));
      }
      sources.delete(id);
      queue.cancel(id);
      onChange(queue.envelopes());
      if (entry) {
        try { await record('patch.abandoned', { app:entry.app, proposal_id:id, tool:entry.tool },
          { reason:'originating app closed' }); } catch (_) {}
      }
    }
  }

  return { stage, acknowledge, commit, discard, detach, envelopes: () => queue.envelopes(), size: () => queue.size() };
}
