// agent-face — Rig's C4 governed surface over the C1 registry.
//
// Everything a non-operator caller does goes through here: the registry stays
// the single capability shape, and this layer adds the governance §6 requires —
// grant enforcement per command, destructive-op staging, and the append-only
// op-log. window.rig (below, via installWindowRig) and Kiln both call invoke;
// neither gets its own path to capability.

// Conventional path-carrying input keys for fs.*/git.* commands. A command may
// override with an explicit `pathParams` array in its metadata.
const PATH_KEYS = new Set(['path', 'from', 'to', 'cwd', 'filepath']);

/**
 * @param {object} opts
 * @param {object} opts.registry  a createRegistry(...) / buildRigRegistry(...) result
 * @param {object} opts.grant     a createGrant(...) — the session authorisation
 * @param {object} opts.opLog     a createOpLog(...) — append-only audit
 * @param {string} [opts.actor='agent']   actor id recorded on the op-log
 * @param {string} [opts.caller=null]      caller id (session/subagent provenance)
 */
export function createAgentFace({ registry, grant, opLog, actor = 'agent', caller = null, capability = null }) {
  if (!registry) throw new Error('createAgentFace requires a registry');
  if (!grant) throw new Error('createAgentFace requires a grant');
  if (!opLog) throw new Error('createAgentFace requires an opLog');

  const staged = new Map(); // proposalId -> { name, input }
  let counter = 0;

  // Optional agent capability grant (P0.1). ADDITIVE: when a caller presents a
  // capability (a bound `verify(ctx) -> {ok, reason}` closure — the app wraps the
  // macaroon grant + root key + revocation list), every invoke/accept is checked
  // against it. When `capability` is null (today's callers), this is a no-op and
  // behaviour is exactly as before. The Rig core stays decoupled from the crypto —
  // the closure is injected, not imported.
  async function capabilityCheck(command, input, name) {
    if (!capability || typeof capability.verify !== 'function') return null;
    const pathArgs = pathArgsOf(command, input).map((a) => a.path);
    let res;
    try { res = await capability.verify({ tool: name, command, input, target: pathArgs[0] || (command && command.scope) || '' }); }
    catch (e) { res = { ok: false, reason: String(e && e.message || e) }; }
    if (!res || !res.ok) return { ok: false, code: 'ECAP', message: `capability denied: ${(res && res.reason) || 'no reason'}` };
    return null;
  }

  function pathArgsOf(command, input) {
    const keys = Array.isArray(command.pathParams)
      ? command.pathParams
      : [...PATH_KEYS].filter((k) => input && k in input);
    return keys.filter((k) => input && typeof input[k] === 'string').map((k) => ({ key: k, path: input[k] }));
  }

  // Returns a denial result, or null when allowed.
  function grantCheck(command, input) {
    if (!grant.allowsScope(command.scope)) {
      return { ok: false, code: 'EGRANT', message: `scope not granted: ${command.scope}` };
    }
    // A mutating scope is anything that writes or removes; a read never trips the read-only
    // regions below, so a granted directory stays readable while staying unwritable. A
    // command may declare `sourceParams` — path arguments it only READS (fs.copy's `from`),
    // so copying a file OUT of a read-only region works while writing INTO it does not.
    // fs.move declares none on purpose: a move deletes its source.
    const mutating = /:(write|remove)$/.test(String(command.scope || ''));
    const sources = new Set(Array.isArray(command.sourceParams) ? command.sourceParams : []);
    for (const { key, path: p } of pathArgsOf(command, input)) {
      if (!grant.allowsPath(p)) {
        return { ok: false, code: 'EGRANT', message: `path outside grant: ${p}` };
      }
      if (mutating && !sources.has(key) && typeof grant.isReadOnly === 'function' && grant.isReadOnly(p)) {
        return { ok: false, code: 'EGRANT', message: `path is read-only under this grant: ${p}` };
      }
    }
    return null;
  }

  async function logAnd(name, input, status, who) {
    await opLog.append({ actor: who || actor, caller, command: name, args: input, status });
  }

  async function runThroughRegistry(name, input, who) {
    const result = await registry.invokeCommand(name, input, { actor: who || actor, caller, grant });
    await logAnd(name, input, result.ok ? 'ok' : (result.code || 'error'), who);
    return result;
  }

  async function invoke(name, input = {}) {
    const command = registry.describeCommand(name);
    if (!command) {
      const miss = await registry.invokeCommand(name, input, { actor, caller });
      await logAnd(name, input, 'unknown');
      return miss; // typed ENOCMD with suggestions — never a throw
    }
    const capDenied = await capabilityCheck(command, input, name);
    if (capDenied) { await logAnd(name, input, capDenied.code); return capDenied; }
    const denied = grantCheck(command, input);
    if (denied) { await logAnd(name, input, denied.code); return denied; }
    if (command.destructive) {
      const proposalId = 'p' + (++counter);
      staged.set(proposalId, { name, input });
      await logAnd(name, input, 'staged');
      return {
        ok: false, staged: true, proposalId, command: name, input,
        scope: command.scope, summary: command.summary,
        message: `destructive — staged for operator accept (${proposalId})`,
      };
    }
    return runThroughRegistry(name, input);
  }

  // Operator-only: execute a staged destructive proposal. Grant is re-checked at
  // accept time in case it was revoked or narrowed after staging.
  async function accept(proposalId) {
    // Attribution is the FACE's authenticated principal, NOT a caller-supplied 'by':
    // an agent face can never self-accept as the operator (was Med6 — forged provenance
    // and, combined with commit actor-binding, forged operator commits). Execution is
    // unchanged; only the honest actor label changes.
    const p = staged.get(proposalId);
    if (!p) return { ok: false, code: 'ENOPROPOSAL', message: `no staged proposal: ${proposalId}` };
    staged.delete(proposalId);
    const command = registry.describeCommand(p.name);
    const capDenied = await capabilityCheck(command, p.input, p.name);
    if (capDenied) { await logAnd(p.name, p.input, capDenied.code, actor); return capDenied; }
    const denied = grantCheck(command, p.input);
    if (denied) { await logAnd(p.name, p.input, denied.code, actor); return denied; }
    return runThroughRegistry(p.name, p.input, actor);
  }

  function reject(proposalId) {
    const had = staged.has(proposalId);
    staged.delete(proposalId);
    return had;
  }

  return {
    invoke,
    accept,
    reject,
    pendingProposals: () => [...staged.keys()],
    // discovery + tool-schema emit — metadata only, straight from the registry
    searchCommands: (q) => registry.searchCommands(q),
    describeCommand: (n) => registry.describeCommand(n),
    toolSchemas: () => registry.toolSchemas(),
    grant,
  };
}
