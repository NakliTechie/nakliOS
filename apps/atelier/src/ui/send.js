// The UI door: every control calls send(), which dispatches a manifest command through the bus with door
// 'ui'. Mutating commands get the current revision at the moment they are sent, because the person acts on
// what they see. A drag uses a coalescer: the newest value wins, at most one call per animation frame and
// one in flight, so a slider never queues stale values behind the renderer.

// run(value) → promise. merge(pending, next) combines values pushed in the same frame (default: next wins).
export function coalescer(run, { schedule = (f) => requestAnimationFrame(f), merge = (_a, b) => b } = {}) {
  let pending; let has = false; let scheduled = false; let inflight = null;
  function kick() { if (!scheduled) { scheduled = true; schedule(pump); } }
  function pump() {
    scheduled = false;
    if (inflight || !has) return;
    const v = pending; has = false; pending = undefined;
    inflight = Promise.resolve().then(() => run(v)).finally(() => { inflight = null; if (has) kick(); });
  }
  return {
    push(v) { pending = has ? merge(pending, v) : v; has = true; kick(); },
    get busy() { return has || scheduled || !!inflight; },
    // Resolves once every pushed value has been sent and answered.
    async settle() {
      while (has || scheduled || inflight) await (inflight ? inflight.catch(() => {}) : new Promise((r) => schedule(r)));
    },
  };
}

export function createSender({ bus, onReply = () => {} }) {
  const tools = new Map(bus.manifest.tools.map((t) => [t.name, t]));
  const guarded = (name) => 'revision' in (tools.get(name)?.inputSchema.properties || {});
  async function send(name, args = {}, { caller = 'person', quiet = false } = {}) {
    const a = { ...args };
    if (guarded(name)) a.revision = bus.state.revision;
    const reply = await bus.dispatch(name, a, { door: 'ui', caller });
    onReply(name, reply, { quiet, args: a });
    return reply;
  }
  // Read commands go through the bus too (door 'ui'); they add nothing to the edit list.
  const read = (name, args = {}) => send(name, args, { quiet: true });
  const lanes = new Map();
  // latest(key, name, build, merge): a coalesced lane; push(value) sends name with build(value).
  function latest(key, name, build, merge) {
    if (!lanes.has(key)) lanes.set(key, coalescer((v) => send(name, build(v)), { merge }));
    return lanes.get(key);
  }
  return { send, read, latest, guarded };
}

// A reply as a sentence for the person: the error's own message, capitalised, without the command name or
// status code (agents read those from the reply itself).
const PLAIN = {
  stale: 'The document changed before that could run. Try again.',
  busy: 'Atelier is busy with another task. Try again when it finishes.',
  denied: 'NakliOS did not allow that.',
  unsupported: 'That is not available here.',
  invalid: 'That could not be done.',
  outcome_unknown: 'That did not finish, and Atelier cannot tell whether anything changed.',
};
export function plainError(r) {
  const m = String(r?.error?.message ?? '').trim();
  if (!m) return PLAIN[r?.status] ?? 'That did not work.';
  const s = m[0].toUpperCase() + m.slice(1);
  return /[.!?)]$/.test(s) ? s : `${s}.`;
}
