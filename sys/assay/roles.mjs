// Assay roles + the wall — over the P0 Grant primitive (sys/identity/grant.mjs).
//
// The wall (Menagerie §2) is one Grant fact, not a prompt: the instrument scope is
// reachable by {checker, lead:summary, owner} and writable by {checker} only; the
// builder's grant set does not include it. A denied access to the instrument
// lands as an `assay.wall.breach` block in the shared History chain — the audit the
// doc promises, built on the deny path that already exists (agent-face → ECAP → log).
//
// A Grant scope caveat ANDs with the others, so one grant = one resource. A ROLE
// therefore holds a SET of grants; authorize() is an OR over the set. The mode
// (r/rw/exec/append/summary) rides a `tools` caveat, since a scope caveat only
// constrains the target prefix. Because scope matching is `/`-delimited,
// `assay:<c>:instrument` and `assay:<c>:instrument:summary` are cleanly disjoint —
// the checker's raw-case scope never leaks to the lead's summary grant.

import { issueGrant, verifyGrant, caveat } from '../identity/grant.mjs';

// Access mode → the tool names a call may carry under this grant.
const MODE_TOOLS = {
  r: ['read'],
  rw: ['read', 'write'],
  w: ['write'],
  exec: ['exec'],
  'r+exec': ['read', 'exec'],
  append: ['append'],
  summary: ['read'], // read of the *summary* scope only
};

// Resource → the scope leaf under `assay:<campaign>:`. `instrument:summary` is a
// deliberately separate leaf from `instrument` (see the disjointness note above).
const RESOURCE_LEAF = {
  candidate: 'candidate', oracle: 'oracle', fixtures: 'fixtures', spec: 'spec',
  directives: 'directives', ledger: 'ledger', instrument: 'instrument',
  'instrument:summary': 'instrument:summary', findings: 'findings',
};

// The three role manifests' grant columns (Anvil amendment §1.1–1.3), as
// { resource: mode }. Builder has NO instrument entry — that omission IS the wall.
export const ROLE_GRANTS = Object.freeze({
  builder: { candidate: 'rw', oracle: 'exec', fixtures: 'r', spec: 'r', directives: 'r', ledger: 'append' },
  checker: { instrument: 'rw', oracle: 'exec', fixtures: 'r', spec: 'r', candidate: 'r+exec', ledger: 'append' },
  lead: { findings: 'r', 'instrument:summary': 'summary', candidate: 'r', ledger: 'rw', directives: 'w' },
});

export const ROLES = Object.freeze(Object.keys(ROLE_GRANTS));

// Non-delegable actions, declared not omitted (Anvil amendment §1).
export const PERSON_ONLY = Object.freeze(['campaign.start', 'ship.accept', 'instrument.retract']);

// Mint a role's grant set for a campaign. `rootKey` is the issuer secret (FIF).
// Each grant binds principal + scope + tools (+ ttl), so it authorizes exactly one
// resource at one mode for one actor.
export async function mintRole(rootKey, { campaign, role, principal, now = 0, ttlMs = 3600_000 }) {
  const spec = ROLE_GRANTS[role];
  if (!spec) throw new Error(`unknown role "${role}"`);
  if (!campaign || !principal) throw new Error('mintRole needs campaign + principal');
  const grants = [];
  for (const [resource, mode] of Object.entries(spec)) {
    const leaf = RESOURCE_LEAF[resource];
    const tools = MODE_TOOLS[mode];
    if (!leaf || !tools) throw new Error(`bad role spec entry ${resource}:${mode}`);
    grants.push(await issueGrant(rootKey, {
      caveats: [
        caveat.principal(principal),
        caveat.scope(`assay:${campaign}:${leaf}`),
        caveat.tools(tools),
        caveat.ttl(now + ttlMs),
      ],
    }));
  }
  return { role, campaign, principal, grants };
}

// The wall check: does this role's grant set authorize (target, tool) for `principal`?
// OR over the set — the first grant that verifies wins. `ctx` needs principal, tool,
// target, now; revocationList defaults to empty but is passed explicitly (the
// enforcement-point contract in grant.mjs requires it).
export async function authorize(roleSet, rootKey, ctx) {
  const full = { revocationList: new Set(), ...ctx };
  let lastReason = 'no grant in the set';
  for (const grant of roleSet.grants) {
    const r = await verifyGrant(grant, rootKey, full);
    if (r.ok) return { ok: true, grant_id: grant.identifier, reason: '' };
    lastReason = r.reason;
  }
  return { ok: false, reason: `denied (${ctx.tool} ${ctx.target}): ${lastReason}` };
}

// Guarded access: authorize, and on a DENIED reach into the raw instrument scope,
// record an `assay.wall.breach` block. This is the Grant→History wall in one call.
export async function guardedAccess(roleSet, rootKey, ctx, ledger, { campaign, tool_call_id = null } = {}) {
  const res = await authorize(roleSet, rootKey, ctx);
  await ledger.append({
    type:'assay.access', campaign:campaign || roleSet.campaign, actor:ctx.principal,
    ts:Number(ctx.now)||0, scope:String(ctx.target), tool:String(ctx.tool), allowed:res.ok,
  });
  if (!res.ok && isInstrumentRaw(ctx.target)) {
    await ledger.append({
      type: 'assay.wall.breach',
      campaign: campaign || roleSet.campaign,
      actor: ctx.principal,
      ts: Number(ctx.now) || 0,
      scope: String(ctx.target),
      tool_call_id,
    });
  }
  return res;
}

// The raw instrument scope (cases, goldens, raw results) — NOT the summary leaf.
function isInstrumentRaw(target) {
  const t = String(target || '');
  const m = t.match(/^assay:[^:]+:instrument(\/|$)/);
  return !!m; // instrument or instrument/... ; instrument:summary does not match
}
