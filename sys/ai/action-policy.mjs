// AC-7b — standing grants: the owner's answer to "always allow this", held where the agent
// cannot reach it, and revocable in one place.
//
// WHERE THIS LIVES, AND WHY IT MATTERS. The policy is APP STATE, not a workspace file. Every other
// piece of per-project config Anvil reads — .anvil/hooks.json, .anvil/procedural.json,
// .anvil/skills/ — sits in the workspace, and every one of them is content the agent can write,
// which is why skills go through Sentinel and staging and why the procedural override is narrow.
// A policy file in the workspace would be strictly worse than either: an agent that can write its
// own authorization has not escaped the gate, it has become the gate. So this is keyed off the
// owner's app state and there is no code path that lets a tool write it.
//
// A standing grant lifts a REFUSAL the owner would otherwise have to answer by hand every time.
// It cannot lift `critical`, and that is structural rather than a rule: `applyPolicy` only ever
// consults `verdict.liftable`, which the critical branch sets false.

/** A grant answers one question: may this class of action proceed without asking again? */
export function normalisePolicy(raw) {
  const allow = {};
  const src = (raw && typeof raw === 'object' && raw.allow && typeof raw.allow === 'object') ? raw.allow : {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof k !== 'string' || !k) continue;
    if (v === true) allow[k] = true;
    else if (v && typeof v === 'object' && v.always === true) allow[k] = { always: true, at: Number(v.at) || 0, scope: v.scope === 'task' ? 'task' : 'always' };
  }
  return { allow };
}

export function grant(policy, id, { now = Date.now(), scope = 'always' } = {}) {
  const p = normalisePolicy(policy);
  if (!id) return p;
  return { allow: { ...p.allow, [id]: { always: true, at: now, scope } } };
}

export function revoke(policy, id) {
  const p = normalisePolicy(policy);
  const allow = { ...p.allow };
  delete allow[id];
  return { allow };
}

export function isGranted(policy, id) {
  if (!id) return false;
  const p = normalisePolicy(policy);
  const g = p.allow[id];
  // normalisePolicy is the single place that decides what a grant may LOOK like — it stores only
  // `true` or `{always:true}` and drops everything else, so the shape is already guaranteed here.
  // A mutation loosening this to `!!g` is therefore inert, which is correct layering rather than a
  // gap: the property is asserted against normalisePolicy, where it actually lives.
  return g === true || (!!g && g.always === true);
}

/**
 * Apply the owner's standing grants to a verdict.
 *
 * Only a LIFTABLE denial can be lifted. `critical` sets `liftable:false`, so no grant, however it
 * was written into state, can reach it — including one hand-edited into localStorage.
 */
export function applyPolicy(verdict, policy) {
  if (!verdict || verdict.outcome !== 'deny') return verdict;
  if (!verdict.liftable) return verdict;
  if (!isGranted(policy, verdict.id)) return verdict;
  return {
    ...verdict,
    outcome: 'allow',
    authorization: 'medium',            // the rung a standing grant occupies — see action-gate.mjs
    liftedBy: 'policy',
    rationale: `Allowed by a standing permission you set for "${verdict.id}". Change it in Policy.`,
  };
}

/** What the policy screen shows: every class, whether it is granted, and whether it may be. */
export function policyRows(classes, policy) {
  return (classes || []).map((c) => ({
    ...c,
    granted: c.liftable ? isGranted(policy, c.id) : false,
    fixed: !c.liftable,
  }));
}

/** The sentence a refusal ends with, so a blocked owner knows where to go. */
export const POLICY_HINT = 'You can change what needs asking in ⋯ → Policy.';
