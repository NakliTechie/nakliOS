// Host three-rail org policy evaluator (FS, AI, Agent/Commands).
// When entitlement is null (unmanaged MIT individual user), every check allows with zero friction.

function matchPattern(pattern, value) {
  if (!pattern || !value) return false
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1))
  return pattern === value
}

export function createOrgPolicy(entitlement = null) {
  const managed = Boolean(entitlement && entitlement.rails)
  const fs = entitlement?.rails?.fs ?? null
  const ai = entitlement?.rails?.ai ?? null
  const agent = entitlement?.rails?.agent ?? null

  return {
    managed,
    orgId: entitlement?.org_id ?? null,
    seatId: entitlement?.seat_id ?? null,
    policyVersion: entitlement?.policy_version ?? 0,

    // ── FS rail ────────────────────────────────────────────────────────────
    checkFsBackend(backendId) {
      if (!managed || !fs) return { ok: true }
      const allowed = Array.isArray(fs.allowed_backends) ? fs.allowed_backends : ['browser', 'fsa', 'crate']
      if (!allowed.includes(backendId)) {
        return { ok: false, code: 'EPOLICY', reason: `Storage backend '${backendId}' is disallowed by organisation policy` }
      }
      if (fs.required_backend && backendId !== fs.required_backend) {
        return { ok: false, code: 'EPOLICY', reason: `Organisation policy requires storage backend '${fs.required_backend}'` }
      }
      return { ok: true }
    },
    requiredFsBackend: () => (managed && fs ? fs.required_backend ?? null : null),
    folderLabel: () => (managed && fs ? fs.folder_label ?? null : null),
    templates: () => (managed && fs && Array.isArray(fs.templates) ? fs.templates : []),
    shouldAuditFs: () => Boolean(managed && fs?.audit_fs),

    // ── AI rail ────────────────────────────────────────────────────────────
    checkAiRequest({ runtime = 'local', modelId = null, isOrgGateway = false, usage = null } = {}) {
      if (!managed || !ai) return { ok: true }
      if (ai.mode === 'off') {
        return { ok: false, code: 'EPOLICY', reason: 'AI is disabled by organisation policy' }
      }
      if (ai.mode === 'local_only' && runtime === 'endpoint') {
        return { ok: false, code: 'EPOLICY', reason: 'Organisation policy permits on-device local models only' }
      }
      if (ai.mode === 'byok_only' && isOrgGateway) {
        return { ok: false, code: 'EPOLICY', reason: 'Organisation policy requires BYOK or local inference (managed gateway disabled)' }
      }
      if (ai.mode === 'gateway_only' && !isOrgGateway) {
        return { ok: false, code: 'EPOLICY', reason: 'Organisation policy requires the managed AI gateway' }
      }
      if (Array.isArray(ai.allowed_models) && modelId && !ai.allowed_models.includes(modelId)) {
        return { ok: false, code: 'EPOLICY', reason: `Model '${modelId}' is not permitted by organisation policy` }
      }
      const budget = ai.per_seat_budget
      if (budget && usage) {
        if (typeof budget.calls === 'number' && Number(usage.calls ?? 0) >= budget.calls) {
          return { ok: false, code: 'EPOLICY', reason: `Per-seat AI call budget (${budget.calls}) exhausted` }
        }
        if (typeof budget.tokens === 'number' && Number(usage.tokens ?? 0) >= budget.tokens) {
          return { ok: false, code: 'EPOLICY', reason: `Per-seat AI token budget (${budget.tokens}) exhausted` }
        }
        if (typeof budget.spend_usd === 'number' && Number(usage.spend_usd ?? 0) >= budget.spend_usd) {
          return { ok: false, code: 'EPOLICY', reason: `Per-seat AI spend budget ($${budget.spend_usd}) exhausted` }
        }
      }
      return { ok: true }
    },
    shouldAuditAi: () => Boolean(managed && ai?.audit_ai),

    // ── Agent / Command rail ───────────────────────────────────────────────
    isAppAllowed(appId) {
      if (!managed || !agent || !Array.isArray(agent.apps_allowlist)) return true
      return agent.apps_allowlist.includes(appId)
    },
    checkCommand(commandName) {
      if (!managed || !agent) return { outcome: 'allow' }
      const appId = String(commandName || '').split('.')[0]
      if (Array.isArray(agent.apps_allowlist) && appId && !agent.apps_allowlist.includes(appId)) {
        return { outcome: 'deny', code: 'EPOLICY', reason: `App '${appId}' is not on the organisation allow-list` }
      }
      for (const pat of agent.deny_commands || []) {
        if (matchPattern(pat, commandName)) {
          return { outcome: 'deny', code: 'EPOLICY', reason: `Command '${commandName}' is blocked by organisation policy (${pat})` }
        }
      }
      for (const pat of agent.force_review_commands || []) {
        if (matchPattern(pat, commandName)) {
          return { outcome: 'review', reason: `Command '${commandName}' requires person review under organisation policy (${pat})` }
        }
      }
      return { outcome: 'allow' }
    },
    allowDoor: () => (!managed || !agent ? true : agent.allow_door === true),
    allowRig: () => (!managed || !agent ? true : agent.allow_rig === true),
    allowThirdPartyApps: () => (!managed || !agent ? true : agent.allow_third_party_apps === true),
    allowNetEgress: () => (!managed || !agent ? true : agent.allow_net_egress === true),
    shouldSyncAudit: () => Boolean(managed && agent?.audit_sync),
  }
}
