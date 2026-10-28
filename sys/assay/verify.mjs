// Assay verifier — the three deterministic, fresh-context hooks the Menagerie
// verifier (§7) needs, as pure functions over an assay ledger's blocks. CLI entry
// points (`anvil verify wall|tests`, `anvil replay`) are thin wrappers over these;
// headless tests call these, not the DOM. Each returns { ok, code } — code is the
// process exit code (0 pass / 1 fail) — plus a reason for the failing case.

// verify wall — History contains zero `assay.wall.breach`, and no builder access
// under `assay:*:instrument` was recorded. In this model a denied builder read
// becomes a breach block, so a clean run has neither.
export function verifyWall(ledger, { campaign, requireEnforcement = false } = {}) {
  const breaches = ledger.ofType('assay.wall.breach', campaign);
  if (breaches.length) {
    return { ok: false, code: 1, reason: `${breaches.length} wall breach(es)`, breaches };
  }
  if (requireEnforcement && !ledger.ofType('assay.access', campaign).length) {
    return {ok:false,code:1,reason:'No enforced role access recorded'};
  }
  return { ok: true, code: 0, reason: '' };
}

// verify tests — the reward-hack screen. Walk `assay.candidate` blocks in round
// order; fail if the builder's own test count ever decreases, or any tests were
// deleted, WITHOUT a ledger reason on that candidate.
export function verifyTests(ledger, { campaign } = {}) {
  const cands = ledger.ofType('assay.candidate', campaign).slice().sort((a, b) => a.round - b.round);
  let prev = null;
  for (const c of cands) {
    const t = c.builder_tests || {};
    const count = Number(t.count);
    const deleted = Number(t.deleted || 0);
    const hasReason = typeof c.test_change_reason === 'string' && c.test_change_reason.length > 0;
    if (deleted > 0 && !hasReason) {
      return { ok: false, code: 1, reason: `round ${c.round}: ${deleted} test(s) deleted with no ledger reason` };
    }
    if (prev != null && count < prev && !hasReason) {
      return { ok: false, code: 1, reason: `round ${c.round}: test count ${count} < ${prev} with no ledger reason` };
    }
    prev = count;
  }
  return { ok: true, code: 0, reason: '' };
}

// replay — reconstruct lineage from the ledger; fail on a gap. Every directive must
// cite ≥1 existing finding cluster; every candidate past c0 must cite an existing
// directive. (finding → directive → candidate, each round.)
export function replay(ledger, { campaign } = {}) {
  const clusterIds = new Set();
  for (const f of ledger.ofType('assay.finding.v1', campaign)) {
    for (const cl of f.clusters || []) if (cl && cl.id != null) clusterIds.add(String(cl.id));
  }
  const directiveIds = new Set();
  for (const d of ledger.ofType('assay.directive.v1', campaign)) {
    if (!Array.isArray(d.from_findings) || d.from_findings.length === 0) {
      return { ok: false, code: 1, reason: `directive ${d.id ?? '?'} cites no finding` };
    }
    for (const fid of d.from_findings) {
      if (!clusterIds.has(String(fid))) {
        return { ok: false, code: 1, reason: `directive ${d.id ?? '?'} cites unknown finding "${fid}"` };
      }
    }
    if (d.id != null) directiveIds.add(String(d.id));
  }
  for (const c of ledger.ofType('assay.candidate', campaign)) {
    if (Number(c.round) >= 1) {
      const from = c.from_directive;
      if (from == null || !directiveIds.has(String(from))) {
        return { ok: false, code: 1, reason: `candidate round ${c.round} cites unknown directive "${from ?? ''}"` };
      }
    }
  }
  return { ok: true, code: 0, reason: '' };
}
