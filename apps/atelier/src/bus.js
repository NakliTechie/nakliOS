// The command bus: the one path to every query and change (spec 002 §0, §6). Every door (the UI,
// window.atelier.tools, navigator.modelContext, the NakliOS rail) calls dispatch(); no door touches
// the document directly. Each call returns the result envelope from agent/tools.manifest.json.

// A handler throws CommandError to answer with a status other than ok (nothing is applied).
export class CommandError extends Error {
  constructor(status, message, remedy, extra = {}) { super(message); this.status = status; this.remedy = remedy; this.extra = extra; }
}

const STATUSES = new Set(['ok', 'stale', 'invalid', 'unsupported', 'staged', 'person_only', 'busy', 'outcome_unknown']);

// A small JSON Schema subset: the keywords agent/tools.manifest.json uses.
export function validate(schema, value, path = '') {
  if (!schema || typeof schema !== 'object') return null;
  const t = schema.type;
  const at = path || '(arguments)';
  if (schema.enum && !schema.enum.includes(value)) return { field: at, allowed: schema.enum, sent: value };
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { field: at, allowed: 'object', sent: value };
    for (const k of schema.required || []) if (!(k in value)) return { field: path ? `${path}.${k}` : k, allowed: 'required', sent: undefined };
    const props = schema.properties || {};
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) return { field: at, allowed: `at least ${schema.minProperties} properties`, sent: value };
    for (const [k, v] of Object.entries(value)) {
      const sub = path ? `${path}.${k}` : k;
      if (k in props) { const e = validate(props[k], v, sub); if (e) return e; }
      else if (schema.additionalProperties === false) return { field: sub, allowed: Object.keys(props), sent: v };
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const e = validate(schema.additionalProperties, v, sub); if (e) return e;
      }
    }
    return null;
  }
  if (t === 'array') {
    if (!Array.isArray(value)) return { field: at, allowed: 'array', sent: value };
    if (schema.minItems != null && value.length < schema.minItems) return { field: at, allowed: `at least ${schema.minItems} items`, sent: value.length };
    if (schema.maxItems != null && value.length > schema.maxItems) return { field: at, allowed: `at most ${schema.maxItems} items`, sent: value.length };
    for (let i = 0; i < value.length; i++) { const e = validate(schema.items, value[i], `${at}[${i}]`); if (e) return e; }
    return null;
  }
  if (t === 'string') return typeof value === 'string' ? null : { field: at, allowed: 'string', sent: value };
  if (t === 'boolean') return typeof value === 'boolean' ? null : { field: at, allowed: 'boolean', sent: value };
  if (t === 'number' || t === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (t === 'integer' && !Number.isInteger(value))) return { field: at, allowed: t, sent: value };
    if (schema.minimum != null && value < schema.minimum) return { field: at, allowed: `>= ${schema.minimum}`, sent: value };
    if (schema.maximum != null && value > schema.maximum) return { field: at, allowed: `<= ${schema.maximum}`, sent: value };
  }
  return null;
}

const BUSY_OK = new Set(['get_job', 'get_state', 'get_staged', 'get_capabilities', 'get_history']);

export function createBus(manifest, { busy = () => null } = {}) {
  const tools = new Map(manifest.tools.map((t) => [t.name, t]));
  const handlers = new Map();   // handler id → async (args, ctx) => result
  const state = { revision: 0, editList: [] };

  const envelope = (status, extra = {}) => {
    if (!STATUSES.has(status)) throw new Error(`status outside the closed set: ${status}`);
    return { status, revision: state.revision, ...extra };
  };

  async function dispatch(name, args = {}, { door = 'window', caller } = {}) {
    const tool = tools.get(name);
    if (!tool) return envelope('invalid', { error: { field: 'name', allowed: [...tools.keys()], sent: name, message: 'no such command' }, remedy: { action: 'fix_argument' } });
    if (tool.personOnly) return envelope('person_only', { error: { message: tool.personOnlyReason }, remedy: { action: 'use_ui_control', tool: name } });
    if (!handlers.has(tool.handler)) return envelope('unsupported', { error: { message: `${name} is not built in this version` }, remedy: { action: 'get_state', tool: 'get_capabilities' } });
    const err = validate(tool.inputSchema, args);
    if (err) return envelope('invalid', { error: { ...err, message: `invalid ${err.field}` }, remedy: { action: 'fix_argument', tool: name } });
    // While a long job holds the engine (a batch export), only job and state queries run.
    if (busy() && !BUSY_OK.has(name)) return envelope('busy', { jobId: busy(), error: { message: 'a job holds the engine' }, remedy: { action: 'get_job', tool: 'get_job' } });
    const fn = handlers.get(tool.handler);
    if (!fn) return envelope('unsupported', { error: { message: `${name} is not built in this version` }, remedy: { action: 'get_state', tool: 'get_capabilities' } });
    const guarded = tool.effect !== 'read' && 'revision' in (tool.inputSchema.properties || {});
    if (guarded && args.revision !== state.revision) return envelope('stale', { remedy: { action: 'retry_with_revision', tool: 'get_state' } });
    try {
      const { revision: _r, ...rest } = args;
      // A handler that changes only view or selection state calls ctx.viewOnly(): no revision bump.
      let viewOnly = false;
      const out = await fn(rest, { door, caller, state, viewOnly: () => { viewOnly = true; } });
      if (tool.effect !== 'read') {
        if (!viewOnly) state.revision++;
        state.editList.push({ command: name, door, caller: caller ?? null, args: rest, revision: state.revision, at: new Date().toISOString() });
      }
      return envelope('ok', { result: out ?? null });
    } catch (e) {
      if (e instanceof CommandError && STATUSES.has(e.status)) return envelope(e.status, { ...e.extra, error: { message: e.message }, remedy: e.remedy });
      return envelope('outcome_unknown', { error: { message: e.message }, remedy: { action: 'get_state', tool: 'get_state' } });
    }
  }

  return {
    manifest, state, dispatch,
    register(handlerId, fn) { handlers.set(handlerId, fn); },
    has(handlerId) { return handlers.has(handlerId); },
    built() { return manifest.tools.filter((t) => handlers.has(t.handler)).map((t) => t.name); },
  };
}
