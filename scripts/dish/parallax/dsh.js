// DeepSeek Harness (dsh) adapter: a Cordis plugin that registers Parallax's six tools and its /peer commands.
// All behaviour lives in core.js; this file only maps dsh's context services onto the core's `host` object.
// API facts and their source lines: plan/research/2026-11-10-dsh-plugin-api.md (dsh v0.2.1-rc.5).

import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { Parallax } from './core.js'
import { TOOLS } from './manifest.js'
import { aliasOf, clip } from './stamp.js'

export const name = 'dsh-parallax'
export const inject = ['tools', 'agents', 'sessions', 'sessionController', 'sessionQuery', 'userQuestions', 'commands']

const RECORD = 'plugin:dsh-parallax/v1'
const SOURCE_KIND = 'peer'
const textOf = content => (Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n') : typeof content === 'string' ? content : '')
const isRootHeader = header => header?.origin !== 'subagent' && !header?.delegationDepth

// One core per plugin instance; a re-apply in the same realm keeps channels (module scope).
let shared

export function apply(ctx, config = {}) {
  const hydrated = new Set()

  async function readEvents(sessionId) {
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    return snapshot?.events ?? []
  }

  async function liveAgent(sessionId) {
    const live = ctx.agents.get(sessionId)
    if (live) return live
    const resolved = await ctx.sessionController.resolveAgent(sessionId)
    if (!resolved?.agent) throw new Error(resolved?.error?.message ?? `conversation ${aliasOf(sessionId)} could not be opened`)
    return resolved.agent
  }

  const peerMessage = (text, meta) => createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: SOURCE_KIND, form: 'relay', senderSessionId: meta.from, parallaxId: meta.parallaxId, peerKind: meta.kind, hop: meta.hop,
      ...(meta.requestId ? { requestId: meta.requestId } : {}), ...(meta.replyTo ? { replyTo: meta.replyTo } : {}) },
  })
  const SANDBOX_RANK = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 }

  const host = {
    now: () => Date.now(),
    randomId: () => globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12),

    // Conversations in the caller's folder only, unless the profile sets `scope: all`, so an automated conversation never
    // reaches unrelated work.
    async list(selfId) {
      const { items } = await ctx.sessionController.list({}, AbortSignal.timeout(10_000))
      const archived = new Set(ctx.get('workspaceRegistry')?.archivedSessionIds ?? [])
      const selfCwd = items.find(row => row.sessionId === selfId)?.cwd ?? ctx.agents.get(selfId)?.session?.header?.cwd
      const sameScope = row => config.scope === 'all' || !selfCwd || row.cwd === selfCwd
      const rows = items.filter(row => !row.blank && row.origin !== 'subagent' && !row.parentSessionId && !archived.has(row.sessionId) && sameScope(row))
      return Promise.all(rows.map(async row => {
        let title = row.projections?.values?.title
        if (!title) { try { title = (await ctx.sessionQuery.readTitle(row.sessionId))?.title } catch { /* untitled */ } }
        return { id: row.sessionId, title: title || `conversation ${aliasOf(row.sessionId)}`, running: Boolean(row.running) }
      }))
    },

    async askPerson(sessionId, card, signal) {
      const agent = ctx.agents.get(sessionId)
      const result = await ctx.userQuestions.ask({
        questions: [{ id: 'parallax', header: card.header, question: card.question, detail: card.detail, options: card.options.map(label => ({ label })) }],
        ...(agent ? { agent } : {}),
        signal,
      })
      const answer = result?.answers?.find(a => a.id === 'parallax')
      // Free text never grants anything: only one selected option counts.
      return answer && !answer.custom?.trim() && answer.selected?.length === 1 ? answer.selected[0] : undefined
    },

    async deliver(toId, { text, target, wakeup, meta }) {
      const agent = await liveAgent(toId)
      const message = peerMessage(text, meta)
      agent.send(message, target === 'next-step' ? 'next-step' : 'next-turn', wakeup)
      try { await ctx.sessions.flush(agent.session) } catch { /* the inbox splice is still in memory; the receipt reads it */ }
      return { messageId: message.id }
    },

    // Swap a still-queued message in place, so the peer sees one current version (dsh-peer-sessions merges bursts the same way).
    async replace(toId, messageId, { text, meta }) {
      const agent = ctx.agents.get(toId)
      if (!agent) return undefined
      const message = peerMessage(text, meta)
      if (!agent.inbox.replace(messageId, message)) return undefined
      try { await ctx.sessions.flush(agent.session) } catch { /* replacement already applied in memory */ }
      return { messageId: message.id }
    },

    // queued: still in the inbox. claimed: taken into a turn (or entered the log). discarded: cancelled.
    async deliveryState(toId, messageId) {
      const live = ctx.agents.get(toId)
      if (live && [...live.inbox.nextTurn, ...live.inbox.nextStep].some(m => m.id === messageId)) return 'queued'
      const lists = { 'next-turn': [], 'next-step': [] }
      let state = 'unknown'
      for (const event of await readEvents(toId)) {
        if (event.type === 'user/message' && event.data?.id === messageId) return 'claimed'
        if (event.type !== 'agent/inbox/spliced') continue
        const list = lists[event.data?.target] ?? []
        const removed = list.splice(event.data.start ?? 0, event.data.removedCount ?? 0, ...(event.data.inserted ?? []).map(m => m.id))
        if (event.data.inserted?.some(m => m.id === messageId)) state = 'queued'
        if (removed.includes(messageId)) state = event.data.outcome === 'canceled' ? 'discarded' : 'claimed'
      }
      return state
    },

    async withdraw(toId, messageId) {
      const agent = ctx.agents.get(toId)
      if (!agent) return false
      const removed = agent.inbox.remove(messageId)
      if (removed) { try { await ctx.sessions.flush(agent.session) } catch { /* removal already applied in memory */ } }
      return removed
    },

    async context(toId, { view, maxMessages }) {
      const out = {}
      const projections = await ctx.sessionController.projections({ sessionId: toId }, AbortSignal.timeout(10_000))
      const values = projections?.values ?? {}
      if (values.goal?.goal?.objective) out.goal = `${values.goal.goal.objective} (${values.goal.goal.phase ?? 'active'})`
      if (Array.isArray(values.todos)) out.todos = values.todos.map(t => ({ text: t.content, done: t.status === 'completed' }))
      const events = await readEvents(toId)
      if (view === 'activity') {
        out.activity = events.filter(e => e.type === 'tool/result' || e.type === 'tool/call').slice(-maxMessages)
          .map(e => clip(`${e.type} ${e.data?.name ?? e.data?.call?.name ?? ''}`.trim(), 200))
      } else {
        // Only what a person or a peer said, and what the model answered; harness context (runtime notes, skill
        // reminders) also arrives as user/message events and is not the conversation (seen in dsh, 2026-11-10).
        const spoken = e => (e.type === 'user/message' && ['user', SOURCE_KIND].includes(e.data?.source?.kind)) || e.type === 'assistant/message'
        out.messages = events.filter(spoken).slice(-maxMessages).map(e => (
          e.type === 'user/message'
            ? { role: 'user', text: textOf(e.data?.content) }
            : { role: 'assistant', text: textOf(e.data?.message?.content) }))
      }
      return out
    },

    // A new top-level conversation with the caller's permission preset, read back before its first turn.
    async delegate(callerId, { task, title, permission }) {
      const presets = ctx.get('permissionPresets')
      if (!presets) return { refused: 'This host has no permission presets, so Parallax cannot clamp a new conversation\'s permissions.' }
      const caller = await liveAgent(callerId)
      const sandboxPolicy = ctx.get('sandboxPolicy')
      const approval = ctx.get('approval')
      const sandboxOverride = sandboxPolicy?.overrideOf?.(caller.session)
      const approvalOverride = approval?.overrideOf?.(caller.session)
      const callerPreset = presets.current(caller.session)
      let preset = callerPreset
      if (permission !== undefined && permission !== callerPreset) {
        // A named preset is accepted only when it is no wider: a sandbox no wider and the same approval policy.
        if (!presets.names?.includes(permission)) return { refused: `Unknown permission preset "${permission}". Known: ${(presets.names ?? []).join(', ')}.` }
        const mine = presets.resolve(callerPreset)
        const theirs = presets.resolve(permission)
        const narrower = SANDBOX_RANK[theirs?.sandbox] !== undefined && SANDBOX_RANK[mine?.sandbox] !== undefined
          && SANDBOX_RANK[theirs.sandbox] <= SANDBOX_RANK[mine.sandbox] && theirs.approval === mine.approval
        if (!narrower) return { refused: `Preset "${permission}" is not narrower than this conversation's ("${callerPreset}").` }
        preset = permission
      }
      const created = await ctx.sessionController.create({ cwd: caller.session.header?.cwd })
      const child = await liveAgent(created.sessionId)
      presets.set(child.session, preset)
      // The caller's own overrides (dsh's access-mode picker sets them) carry over, narrowed to the chosen preset's sandbox.
      let childSandbox = sandboxOverride
      if (childSandbox !== undefined && preset !== callerPreset) {
        const presetSandbox = presets.resolve(preset)?.sandbox
        if (SANDBOX_RANK[presetSandbox] < SANDBOX_RANK[childSandbox]) childSandbox = presetSandbox
      }
      if (childSandbox !== undefined) setSandboxMode(child.session, childSandbox)
      if (approvalOverride !== undefined) setApprovalPolicy(child.session, approvalOverride)
      const readBack = presets.current(child.session) === preset
        && (childSandbox === undefined || sandboxPolicy?.overrideOf?.(child.session) === childSandbox)
        && (approvalOverride === undefined || approval?.overrideOf?.(child.session) === approvalOverride)
      if (!readBack) return { refused: 'The new conversation\'s permissions did not read back as no wider than this conversation\'s, so it was not started.' }
      const callerTitle = (await host.list(callerId)).find(row => row.id === callerId)?.title ?? 'a conversation'
      child.followup(createUserMessage({
        content: [{ type: 'text', text: [
          `[parallax · delegated task · started by "${callerTitle}" (${aliasOf(callerId)}), with permissions no wider than its own]`,
          `Title: ${title}`, '', task, '',
          `When you finish or need a decision, report with peer_send to "${aliasOf(callerId)}".`,
        ].join('\n') }],
        source: { kind: SOURCE_KIND, form: 'relay', senderSessionId: callerId, peerKind: 'delegate' },
      }))
      try { await ctx.sessions.flush(child.session) } catch { /* followup already queued */ }
      return { childId: created.sessionId, permission: childSandbox ? `${preset} (sandbox ${childSandbox})` : preset }
    },

    async record(sessionId, data) {
      const agent = ctx.agents.get(sessionId) ?? (await liveAgent(sessionId))
      appendPluginRecord(agent.session, RECORD, data)
      await ctx.sessions.flush(agent.session)
    },
  }

  shared ??= new Parallax(host, { consent: config.consent, delegateApproval: config.delegateApproval, defaultWake: config.defaultWake, maxHops: config.maxHops })
  shared.host = host
  const core = shared

  // Grants live in the log of the conversation whose person approved them, so read every reachable log once.
  async function hydrateAll() {
    for (const row of await host.list(undefined)) {
      if (hydrated.has(row.id)) continue
      hydrated.add(row.id)
      try {
        const records = (await readEvents(row.id)).map(pluginRecordOf).filter(r => r?.type === RECORD).map(r => r.data)
        core.hydrate(row.id, records)
      } catch { hydrated.delete(row.id) }
    }
  }

  const callerOf = exec => ({
    sessionId: exec.agent?.id,
    root: Boolean(exec.agent) && isRootHeader(exec.agent.session?.header) && (ctx.agents.roots?.() ?? [exec.agent]).some(a => a.id === exec.agent.id),
    signal: exec.signal,
  })

  for (const tool of TOOLS) {
    // dsh's schema compiler accepts `required` only as true, so optional parameters omit it.
    const parameters = Object.fromEntries(Object.entries(tool.parameters).map(([key, { required, ...spec }]) => [key, required ? { ...spec, required: true } : spec]))
    ctx.effect(() => ctx.tools.register(defineTool({
      name: tool.name,
      description: tool.description,
      parameters,
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { json: { type: 'string', required: true } } },
        render: (_args, value) => [{ type: 'text', text: value.json }],
      },
      async execute(args, exec) {
        await hydrateAll()
        const result = await core[tool.name](callerOf(exec), args ?? {})
        return { json: JSON.stringify(result, null, 1) }
      },
    })), `${name}: ${tool.name}`)
  }

  // Person-only acts. Commands come from the composer, never from the model's tool registry.
  ctx.effect(() => ctx.commands.register({
    name: 'peer',
    description: 'Peer conversations: /peer connect <peer> [once|session] · /peer revoke <peer> · /peer wake <always|replies|never>',
    async handler({ agent, rawInput }) {
      await hydrateAll()
      const [verb, ...rest] = String(rawInput ?? '').trim().split(/\s+/)
      let result
      if (verb === 'connect') {
        const tier = rest.at(-1) === 'once' || rest.at(-1) === 'session' ? rest.pop() : 'session'
        result = await core.personConnect(agent.id, rest.join(' '), tier)
      } else if (verb === 'revoke') result = await core.personRevoke(agent.id, rest.join(' '))
      else if (verb === 'wake') result = await core.personSetWake(agent.id, rest[0])
      else return { kind: 'error', text: 'Use /peer connect <peer> [once|session], /peer revoke <peer> or /peer wake <always|replies|never>.' }
      return result.ok ? { kind: 'success', text: JSON.stringify(result) } : { kind: 'error', text: result.message }
    },
  }), `${name}: /peer`)

  ctx.effect(() => ctx.commands.register({
    name: 'peers',
    description: 'List peer conversations, open channels and waiting requests for this conversation.',
    async handler({ agent }) {
      await hydrateAll()
      const result = await core.peer_list({ sessionId: agent.id, root: true })
      return { kind: 'success', text: JSON.stringify(result, null, 1) }
    },
  }), `${name}: /peers`)
}
