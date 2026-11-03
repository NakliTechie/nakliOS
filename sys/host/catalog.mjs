// The command catalog (common rail step 1, docs/app-contract.md "Common rail"): the desktop's own
// registry plus the commands each open app registers through naklios.experimental_commands. It has
// the registry's shape (list, searchCommands, describeCommand, invokeCommand, toolSchemas), so the
// agent face runs app commands through the same grant check, staging and op-log as desktop ones.
// App commands carry the scopes `app:read` and `app:write`; `destructive` stages for the person.

export const APP_SCOPES = Object.freeze({ read: 'app:read', write: 'app:write', destructive: 'app:write' });
export const COMMAND_TIMEOUT_MS = 30000;
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
export function createCatalog({ base, timeoutMs = COMMAND_TIMEOUT_MS, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  if (!base) throw new Error('createCatalog requires the desktop registry');
  const apps = new Map(); // appId -> { owner, dispatch, commands: Map(fullName -> command) }
  const pending = new Map(); // invokeId -> { resolve, timer, appId }
  let invokeCounter = 0;

  function appCommands() { return [...apps.values()].flatMap(entry => [...entry.commands.values()]); }
  function find(name) {
    for (const entry of apps.values()) if (entry.commands.has(name)) return entry.commands.get(name);
    return null;
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
      run(input) {
        const problem = validateInput(inputSchema, input);
        if (problem) return Promise.resolve({ ok: false, code: 'EINVAL', message: problem });
        if (apps.get(appId) !== entry) return Promise.resolve({ ok: false, code: 'EGONE', message: `${appId} is not open` });
        const invokeId = `c${++invokeCounter}_${Date.now()}`;
        return new Promise(resolve => {
          const timer = setTimeoutFn(() => {
            pending.delete(invokeId);
            resolve({ ok: false, code: 'ETIMEOUT', message: `${name} did not answer within ${timeoutMs / 1000} s` });
          }, timeoutMs);
          pending.set(invokeId, { resolve, timer, appId });
          try { entry.dispatch({ invokeId, name: def.name, args: structuredClone(input) }); }
          catch (error) {
            clearTimeoutFn(timer); pending.delete(invokeId);
            resolve({ ok: false, code: 'EGONE', message: String(error?.message || error) });
          }
        });
      },
    };
  }

  // Replaces the app's whole set: a reload or a second register call never leaves stale commands.
  function register(appId, owner, defs, dispatch) {
    if (typeof appId !== 'string' || !APP_ID.test(appId)) return fail('invalid app id');
    if (typeof dispatch !== 'function') return fail('missing dispatch');
    if (!Array.isArray(defs)) return fail('commands must be a list');
    if (defs.length > MAX_COMMANDS) return fail(`at most ${MAX_COMMANDS} commands`);
    const entry = { owner, dispatch, commands: new Map() };
    for (const raw of defs) {
      if (!raw || typeof raw !== 'object') return fail('each command must be an object');
      const { name, description, scope } = raw;
      if (typeof name !== 'string' || !NAME.test(name)) return fail(`invalid command name: ${String(name)}`);
      if (typeof description !== 'string' || !description.trim()) return fail(`${name}: description is required`);
      if (!Object.hasOwn(APP_SCOPES, scope)) return fail(`${name}: scope must be read, write or destructive`);
      const input = checkSchema(raw.input);
      if (!input) return fail(`${name}: input must be an object schema`);
      const full = `${appId}.${name}`;
      if (base.describeCommand(full)) return fail(`${full} is a desktop command`);
      if (entry.commands.has(full)) return fail(`duplicate command: ${full}`);
      entry.commands.set(full, makeCommand(appId, { name, description: description.trim(), scope, input }, entry));
    }
    unregister(appId);
    apps.set(appId, entry);
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
    register, unregister, settle,
    apps: () => [...apps.keys()],
    get commands() { return Object.freeze([...base.commands, ...appCommands()]); },
    list: () => [...base.list(), ...appCommands().map(project)],
    searchCommands(query) {
      const q = String(query || '').trim().toLowerCase();
      const mine = appCommands().filter(c => !q || `${c.name}\n${c.description}`.toLowerCase().includes(q)).map(project);
      return [...base.searchCommands(query), ...mine];
    },
    describeCommand: name => { const c = find(name); return c ? project(c) : base.describeCommand(name); },
    invokeCommand(name, input, ctx) { const c = find(name); return c ? c.run(input || {}, ctx || {}) : base.invokeCommand(name, input, ctx); },
    toolSchemas: () => [...base.toolSchemas(), ...appCommands().map(schema)],
  };
}
