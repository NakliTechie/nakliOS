// The command catalog (common rail step 1, docs/app-contract.md "Common rail"): the desktop's own
// registry plus the commands each open app registers through naklios.experimental_commands. It has
// the registry's shape (list, searchCommands, describeCommand, invokeCommand, toolSchemas), so the
// agent face runs app commands through the same grant check, staging and op-log as desktop ones.
// App commands carry the scopes `app:read` and `app:write`; `destructive` stages for the person.

export const APP_SCOPES = Object.freeze({ read: 'app:read', write: 'app:write', destructive: 'app:write' });
export const COMMAND_TIMEOUT_MS = 30000;
// How long a call to a declared command waits for its app to open and register.
export const LAUNCH_TIMEOUT_MS = 20000;
// A result crosses the rail whole, so one that large is an app defect, not an answer a caller can use.
export const MAX_RESULT_CHARS = 262144;
const MAX_COMMANDS = 64;
const NAME = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){0,3}$/;
const APP_ID = /^[a-z0-9][a-z0-9_-]*$/;

function fail(message) { return { ok: false, error: message }; }

// The subset of JSON Schema the rail checks at the boundary: an object with typed, required,
// enumerated properties. A handler that wants more checks them itself.
function checkSchema(schema) {
  if (schema == null) return { type: 'object', properties: {}, required: [], additionalProperties: false };
  if (typeof schema !== 'object' || Array.isArray(schema) || schema.type !== 'object') return null;
  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter(k => typeof k === 'string') : [];
  for (const key of required) if (!Object.hasOwn(properties, key)) return null;
  return structuredClone({ type: 'object', properties, required, additionalProperties: schema.additionalProperties === true });
}

export function validateInput(schema, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'arguments must be an object';
  if (!schema.additionalProperties) {
    for (const key of Object.keys(input)) if (!Object.hasOwn(schema.properties, key)) return `unknown argument: ${key}`;
  }
  for (const key of schema.required) if (input[key] === undefined) return `missing argument: ${key}`;
  for (const [key, rule] of Object.entries(schema.properties)) {
    const value = input[key];
    if (value === undefined || !rule || typeof rule !== 'object') continue;
    const type = rule.type;
    const ok = type === undefined
      || (type === 'array' ? Array.isArray(value)
        : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : type === 'integer' ? Number.isInteger(value)
        : typeof value === type && value !== null);
    if (!ok) return `${key} must be ${type}`;
    if (Array.isArray(rule.enum) && !rule.enum.includes(value)) return `${key} must be one of ${rule.enum.join(', ')}`;
    if (typeof rule.minLength === 'number' && typeof value === 'string' && value.length < rule.minLength) return `${key} is too short`;
  }
  return null;
}

/**
 * @param {object} opts
 * @param {object} opts.base       the desktop registry (createHostRegistry), whose names apps cannot take
 * @param {number} [opts.timeoutMs] how long a caller waits for an app's handler
 * @param {Function} [opts.setTimeoutFn]
 */
export function createCatalog({ base, timeoutMs = COMMAND_TIMEOUT_MS, launchTimeoutMs = LAUNCH_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  if (!base) throw new Error('createCatalog requires the desktop registry');
  const apps = new Map(); // appId -> { owner, dispatch, commands: Map(fullName -> command) }
  // An app's manifest (apps/<id>/commands.json) declares its commands ahead of time, so they are listed while the
  // app is closed; a call opens the app, waits for it to register, then runs inside it.
  const declared = new Map(); // appId -> { commands: Map(fullName -> command), launch }
  const launching = new Map(); // appId -> Promise<boolean>
  const waiters = new Map(); // appId -> [resolve]
  const pending = new Map(); // invokeId -> { resolve, timer, appId }
  let invokeCounter = 0;

  function appCommands() {
    const live = [...apps.values()].flatMap(entry => [...entry.commands.values()]);
    const idle = [...declared].filter(([appId]) => !apps.has(appId)).flatMap(([, d]) => [...d.commands.values()]);
    return [...live, ...idle];
  }
  function find(name) {
    for (const entry of apps.values()) if (entry.commands.has(name)) return entry.commands.get(name);
    for (const [appId, d] of declared) if (!apps.has(appId) && d.commands.has(name)) return d.commands.get(name);
    return null;
  }

  // One parser for declarations and registrations: a Map(fullName -> { name, description, scope, input }).
  function parse(appId, defs) {
    if (typeof appId !== 'string' || !APP_ID.test(appId)) return { error: 'invalid app id' };
    if (!Array.isArray(defs)) return { error: 'commands must be a list' };
    if (defs.length > MAX_COMMANDS) return { error: `at most ${MAX_COMMANDS} commands` };
    const out = new Map();
    for (const raw of defs) {
      if (!raw || typeof raw !== 'object') return { error: 'each command must be an object' };
      const { name, description, scope } = raw;
      if (typeof name !== 'string' || !NAME.test(name)) return { error: `invalid command name: ${String(name)}` };
      if (typeof description !== 'string' || !description.trim()) return { error: `${name}: description is required` };
      if (!Object.hasOwn(APP_SCOPES, scope)) return { error: `${name}: scope must be read, write or destructive` };
      const input = checkSchema(raw.input);
      if (!input) return { error: `${name}: input must be an object schema` };
      const full = `${appId}.${name}`;
      if (base.describeCommand(full)) return { error: `${full} is a desktop command` };
      if (out.has(full)) return { error: `duplicate command: ${full}` };
      out.set(full, { name, description: description.trim(), scope, input });
    }
    return { defs: out };
  }

  function ensureOpen(appId) {
    if (apps.has(appId)) return Promise.resolve(true);
    if (launching.has(appId)) return launching.get(appId);
    const d = declared.get(appId);
    const started = new Promise(resolve => {
      let done = false;
      const finish = ok => { if (done) return; done = true; clearTimeoutFn(timer); launching.delete(appId); resolve(ok); };
      const timer = setTimeoutFn(() => finish(false), launchTimeoutMs);
      const list = waiters.get(appId) || [];
      list.push(() => finish(true));
      waiters.set(appId, list);
      Promise.resolve().then(() => d.launch(appId)).catch(() => finish(false));
    });
    launching.set(appId, started);
    return started;
  }

  function declaredCommand(appId, def) {
    const name = `${appId}.${def.name}`;
    return {
      name, summary: def.description, description: def.description,
      scope: APP_SCOPES[def.scope], destructive: def.scope === 'destructive',
      inputSchema: def.input, returnSchema: { type: 'object' },
      annotations: { readOnlyHint: def.scope === 'read', app: appId, opensApp: true },
      async run(input, ctx) {
        const problem = validateInput(def.input, input);
        if (problem) return { ok: false, code: 'EINVAL', message: problem };
        if (!(await ensureOpen(appId))) return { ok: false, code: 'ELAUNCH', message: `${appId} did not open and register within ${launchTimeoutMs / 1000} s` };
        const live = apps.get(appId)?.commands.get(name);
        return live ? live.run(input, ctx) : { ok: false, code: 'EGONE', message: `${appId} did not register ${name}` };
      },
    };
  }

  // Declares an app's commands from its manifest. `launch(appId)` opens the app (the host opens it minimized).
  function declare(appId, defs, launch) {
    if (typeof launch !== 'function') return fail('missing launch');
    const parsed = parse(appId, defs);
    if (parsed.error) return fail(parsed.error);
    const commands = new Map([...parsed.defs].map(([full, def]) => [full, declaredCommand(appId, def)]));
    declared.set(appId, { commands, defs: parsed.defs, launch });
    return { ok: true, declared: [...commands.keys()] };
  }

  function makeCommand(appId, def, entry) {
    const name = `${appId}.${def.name}`;
    const inputSchema = def.input;
    return {
      name,
      summary: def.description,
      description: def.description,
      scope: APP_SCOPES[def.scope],
      destructive: def.scope === 'destructive',
      inputSchema,
      returnSchema: { type: 'object' },
      annotations: { readOnlyHint: def.scope === 'read', app: appId },
      run(input, ctx) {
        const problem = validateInput(inputSchema, input);
        if (problem) return Promise.resolve({ ok: false, code: 'EINVAL', message: problem });
        if (apps.get(appId) !== entry) return Promise.resolve({ ok: false, code: 'EGONE', message: `${appId} is not open` });
        const invokeId = `c${++invokeCounter}_${Date.now()}`;
        return new Promise(resolve => {
          const timer = setTimeoutFn(() => {
            pending.delete(invokeId);
            try { entry.dispatch({ invokeId, cancel: true }); } catch { /* the window has gone */ }
            resolve({ ok: false, code: 'ETIMEOUT', message: `${name} did not answer within ${timeoutMs / 1000} s; it was told to stop, but work already started may finish` });
          }, timeoutMs);
          pending.set(invokeId, { resolve, timer, appId });
          try { entry.dispatch({ invokeId, name: def.name, args: structuredClone(input), caller: ctx?.caller ?? null }); }
          catch (error) {
            clearTimeoutFn(timer); pending.delete(invokeId);
            resolve({ ok: false, code: 'EGONE', message: String(error?.message || error) });
          }
        });
      },
    };
  }

  // Replaces the app's whole set: a reload or a second register call never leaves stale commands. An app with a
  // manifest may register only what it declared, at the declared scope; the manifest's text and schema are used.
  function register(appId, owner, defs, dispatch) {
    if (typeof dispatch !== 'function') return fail('missing dispatch');
    const parsed = parse(appId, defs);
    if (parsed.error) return fail(parsed.error);
    const manifest = declared.get(appId);
    const entry = { owner, dispatch, commands: new Map() };
    for (const [full, def] of parsed.defs) {
      const promised = manifest?.defs.get(full);
      if (manifest && !promised) return fail(`${full} is not in ${appId}'s commands.json`);
      if (promised && promised.scope !== def.scope) return fail(`${full}: scope ${def.scope} differs from the declared ${promised.scope}`);
      entry.commands.set(full, makeCommand(appId, promised || def, entry));
    }
    unregister(appId);
    apps.set(appId, entry);
    for (const resolve of waiters.get(appId) || []) resolve();
    waiters.delete(appId);
    return { ok: true, registered: [...entry.commands.keys()] };
  }

  // Drops the app's commands and fails its calls still waiting. `owner`, when given, must match,
  // so a stale window's close cannot remove a newer registration.
  function unregister(appId, owner) {
    const entry = apps.get(appId);
    if (!entry || (owner !== undefined && entry.owner !== owner)) return false;
    apps.delete(appId);
    for (const [id, call] of pending) {
      if (call.appId !== appId) continue;
      clearTimeoutFn(call.timer); pending.delete(id);
      call.resolve({ ok: false, code: 'EGONE', message: `${appId} closed` });
    }
    return true;
  }

  // The app's answer. Only the window that registered may answer its own calls.
  function settle(appId, owner, invokeId, outcome) {
    const call = pending.get(invokeId);
    const entry = apps.get(appId);
    if (!call || call.appId !== appId || !entry || entry.owner !== owner) return false;
    clearTimeoutFn(call.timer); pending.delete(invokeId);
    if (outcome && typeof outcome.error === 'string') call.resolve({ ok: false, code: 'EAPP', message: outcome.error });
    else if ((JSON.stringify(outcome?.result) || '').length > MAX_RESULT_CHARS) call.resolve({ ok: false, code: 'ETOOBIG', message: `${appId} answered with more than ${MAX_RESULT_CHARS} characters` });
    else call.resolve({ ok: true, result: outcome ? outcome.result : undefined });
    return true;
  }

  const project = command => structuredClone({
    name: command.name, summary: command.summary, description: command.description,
    inputSchema: command.inputSchema, returnSchema: command.returnSchema,
    destructive: command.destructive, scope: command.scope, annotations: command.annotations,
  });
  const schema = command => structuredClone({
    name: command.name, description: command.summary, inputSchema: command.inputSchema,
    annotations: command.annotations, scope: command.scope, destructive: command.destructive,
  });

  return {
    declare, register, unregister, settle,
    apps: () => [...apps.keys()],
    get commands() { return Object.freeze([...base.commands, ...appCommands()]); },
    list: () => [...base.list(), ...appCommands().map(project)],
    searchCommands(query) {
      // Every word counts on its own, so "add kanzen card" finds kanzen.card.add; the best match comes first.
      const words = String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const score = c => words.filter(word => `${c.name}\n${c.description}`.toLowerCase().includes(word)).length;
      const mine = appCommands().map(c => [score(c), c]).filter(([s]) => !words.length || s > 0)
        .sort((a, b) => b[0] - a[0]).map(([, c]) => project(c));
      return [...base.searchCommands(query), ...mine];
    },
    describeCommand: name => { const c = find(name); return c ? project(c) : base.describeCommand(name); },
    invokeCommand(name, input, ctx) { const c = find(name); return c ? c.run(input || {}, ctx || {}) : base.invokeCommand(name, input, ctx); },
    toolSchemas: () => [...base.toolSchemas(), ...appCommands().map(schema)],
  };
}
