// Assay live role executors — run each campaign role as an AGENT and turn what it
// emits into a validated ledger block. This is what replaces the demo scripts: the
// driver (runmode.mjs) calls these; each one runs the role's agent (injected as
// `runRole`, so the harness is testable without a live model), captures the block the
// role emits via its `emit` tool, stamps + validates it, and hands it back.
//
// The WALL is enforced here at the information boundary, backed by the role grant sets:
// each role is handed only a role-scoped VIEW of the ledger — the Builder never
// receives findings or instrument cases (only directives), the Lead receives finding
// SUMMARIES (clusters/weights) but never raw cases. A role that cannot see the
// instrument cannot leak them, independent of the Grant check on any file access.

import { validateBlock } from './ledger.mjs';
import { sealInstrument, measureInstrument } from './instrument.mjs';

// Condensed role manifests (Anvil amendment §1.1–1.3). The load-bearing constraints,
// as standing instructions handed to each role's agent.
export const ROLE_INSTRUCTIONS = {
  checker:
    'You are the CHECKER. Author and run the standard of completion BEFORE the builder builds. ' +
    'Survey the oracle/spec, map where behaviour lives, weight it, write cases, record goldens; byte-identity is the default and every relaxation carries a licensed TRADEOFF. ' +
    'When measuring a candidate: run the instrument, cluster failures by root cause, and report clusters + weights + ONE representative symptom + a subsystem-level repro hint — NEVER a case id, never raw output. ' +
    'You may expand the instrument; you may never weaken it, and never because of what the candidate contains. Emit your result with the `emit` tool.',
  builder:
    'You are the BUILDER. Build the candidate. You receive directives at the subsystem/behaviour level — a directive tells you WHERE the candidate is weak, not the answer. Probe the oracle first. ' +
    'Write your own tests; they are yours and are never the standard, and you never delete them to pass. You never see the instrument. You do not decide when the campaign is done. Emit your candidate with the `emit` tool.',
  lead:
    'You are the LEAD. Hold the whole outcome. Decide which findings are real; reject noise with a reason. Turn the rest into a directive ordered by measured weight, at the level of missing features/subsystems/behaviour — never naming a case. ' +
    'When the instrument stops discriminating, request expansion; you may not ship on a flat instrument. You propose ship; the verifier confirms; the Owner accepts. You see instrument SUMMARIES (weights, coverage, pass-rate) — never a case. Emit with the `emit` tool.',
};

// action → { role, the fields the role must emit, and how to build the block(s) }.
const ACTIONS = {
  'build-instrument': {
    role: 'checker',
    emit: 'Provide {version:int, areas:[{id,description,weight}], cases:[{id,area,command,expected:{exitCode:int,stdout?:string,stderr?:string},weight:number}]}. Use exact expected output. The harness seals cases and executes them; you cannot emit a pass rate.',
    build: (a) => ({ type: 'assay.instrument.v1', version: Number(a.version) || 1, ratchet_sha: String(a.ratchet_sha || 'sha256:0'), areas: a.areas || [], case_count: Number(a.case_count) || 0 }),
  },
  'build-candidate': {
    role: 'builder',
    emit: 'Provide {git_ref:string, test_count:int, deleted:int, test_change_reason?:string}.',
    build: (a, ctx) => ({ type: 'assay.candidate', round: ctx.round, git_ref: String(a.git_ref || ('c' + ctx.round)), from_directive: ctx.round >= 1 ? String(a.from_directive || '') : null, builder_tests: { count: Number(a.test_count) || 0, deleted: Number(a.deleted) || 0 }, ...(a.test_change_reason ? { test_change_reason: String(a.test_change_reason) } : {}) }),
  },
  measure: { role: 'checker' },
  adjudicate: {
    role: 'lead',
    emit: 'Provide {id:string, from_findings:[clusterId], items:[{area,weight,instruction}]}. Never name a case.',
    build: (a, ctx) => ({ type: 'assay.directive.v1', round: ctx.round, id: String(a.id || ('d' + ctx.round)), from_findings: a.from_findings || [], items: a.items || [] }),
  },
  'request-expansion': {
    role: 'lead',
    emit: 'Provide {area:string, reason:string}.',
    build: (a, ctx) => ({ type: 'assay.expansion', round: ctx.round, area: String(a.area || ''), reason: String(a.reason || '') }),
  },
  'propose-ship': {
    role: 'lead',
    emit: 'Provide {candidate_ref:string, rationale:string}.',
    build: (a, ctx) => ({ type: 'assay.ship', round: ctx.round, candidate_ref: String(a.candidate_ref || ''), lead_rationale: String(a.rationale || '') }),
  },
};

const ROLE_ACTOR = (role, C) => (role === 'owner' ? 'actor:human:owner' : 'actor:agent:' + role + ':' + C);

// The role-scoped ledger view — the wall at the information boundary.
export function viewFor(role, ledger, C) {
  if (role === 'checker') {
    return { instrument: ledger.ofType('assay.instrument.v1', C), candidates: ledger.ofType('assay.candidate', C), directives: ledger.ofType('assay.directive.v1', C) };
  }
  if (role === 'builder') {
    // NEVER findings, measures, or instrument — only directives and prior candidates.
    return { directives: ledger.ofType('assay.directive.v1', C), candidates: ledger.ofType('assay.candidate', C) };
  }
  if (role === 'lead') {
    // Finding SUMMARIES (cluster/area/weight), never raw output; directives; candidates.
    return {
      findings: ledger.ofType('assay.finding.v1', C).map((f) => ({ round: f.round, clusters: (f.clusters || []).map((c) => ({ id: c.id, area: c.area, weight: c.weight })) })),
      directives: ledger.ofType('assay.directive.v1', C), candidates: ledger.ofType('assay.candidate', C),
    };
  }
  return {};
}

// Build the executor map the driver consumes. `runRole({role, action, round, instructions,
// emitSpec, view, goal}) → emittedArgs | null` runs the role's agent and returns what it
// passed to `emit` (or null if it emitted nothing → the campaign pauses). `clock` yields a
// monotonic ts. campaign.start is the Owner's input, not an agent.
export function makeCampaignExecutors({ campaign, goal, ship_bar = 0.85, runRole, clock, access, runCheck }) {
  const C = campaign;
  let t = 0;
  const ts = typeof clock === 'function' ? clock : () => ++t;
  let instrument;
  const exec = {
    'campaign.start': async () => ({ type: 'assay.campaign', campaign: C, actor: 'actor:human:owner', ts: ts(), goal, ship_bar }),
  };
  for (const [action, spec] of Object.entries(ACTIONS)) {
    exec[action] = async (ctx) => {
      if (typeof access !== 'function') throw new Error('Campaign needs enforced role access');
      const authorize = async (resource, tool='read') => {
        const result=await access(spec.role,resource,tool,ctx);
        if (!result?.ok) throw new Error(result?.reason || 'Role access denied');
        return result;
      };
      if(action==='measure') {
        await authorize('instrument','read');
        const blocks=await measureInstrument(instrument,runCheck,{round:ctx.round});
        return blocks.map(b=>({...b,campaign:C,actor:ROLE_ACTOR('checker',C),ts:ts()}));
      }
      await authorize(spec.role==='builder'?'candidate':spec.role==='checker'?'instrument':'findings',spec.role==='lead'?'read':'write');
      const view = viewFor(spec.role, ctx.ledger, C);
      const emitted = await runRole({ role: spec.role, action, round: ctx.round, instructions: ROLE_INSTRUCTIONS[spec.role], emitSpec: spec.emit, view, goal, authorize });
      if (emitted == null) return null;
      if(action==='build-instrument') {
        if(instrument)throw new Error('Instrument is already sealed');
        instrument=await sealInstrument(emitted);
        emitted.ratchet_sha=instrument.hash;emitted.case_count=instrument.cases.length;
      }
      const built = [].concat(spec.build(emitted, { round: ctx.round }));
      const actor = ROLE_ACTOR(spec.role, C);
      const blocks = built.map((b) => ({ ...b, campaign: C, actor, ts: ts() }));
      for (const b of blocks) { const err = validateBlock(b); if (err) throw new Error(`role ${spec.role} emitted an invalid ${b.type}: ${err}`); }
      return blocks;
    };
  }
  return exec;
}
