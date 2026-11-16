/* Reel command registry: one table for buttons, keys, the help sheet and agents.
 *
 * Each feature module exports COMMANDS, an array of plain definitions (no DOM, no handlers),
 * so scripts/build-commands.mjs can import every module in Node and write commands.json.
 * At runtime the module's install(ctx) binds a handler to each of its definitions with
 * ctx.registry.handle(name, fn). A definition with no handler is a parity failure.
 *
 * Definition fields:
 *   name         lower-case dotted id, e.g. "playback.seek" or "subtitle.load-file" (no camelCase)
 *   description  one sentence for agents and the help sheet
 *   scope        "read", "write" or "destructive" (a write that removes stored data and cannot be
 *                undone; hosts and agents ask the person before running it; review V22)
 *   input        JSON schema object ({ type: "object", properties, required })
 *   label        short human label for buttons and the help sheet
 *   shortcuts    optional list of { key, input? }: key is a spec such as "space", "arrowleft",
 *                "shift+arrowleft", ".", "?", "shift+n" (KeyboardEvent.key lowercased, modifiers
 *                shift and alt only, never ctrl or meta); input is passed when that key fires
 *   repeat       optional true: a held key runs the command again on each key repeat (skip, volume,
 *                delays, frame step). Without it a held key runs the command once (review V34).
 *   readTwin     for write and destructive commands: the read command that reports the changed value
 *
 * run() checks the input against the schema before the handler sees it (review V60): type, enum,
 * minimum, maximum, maxLength and pattern, for every declared property that is present.
 */

export const SCOPES = Object.freeze(['read', 'write', 'destructive']);

/* Letters and brackets are read from the physical key (event.code) when the layout types a character
   outside ASCII (Russian, Greek, Hebrew, Arabic) or a dead key, so M, F, S, [ and ] still fire there
   (review V33). A Latin layout keeps its own letters (AZERTY "a" stays "a"). "?" and the other symbols
   always come from event.key. */
const CODE_KEYS = Object.freeze({ BracketLeft: '[', BracketRight: ']' });
function physicalKey(code) {
  if (/^Key[A-Z]$/.test(code || '')) return code.slice(-1).toLowerCase();
  return CODE_KEYS[code] || null;
}

export function keySpec(event) {
  let key = event.key === ' ' ? 'space' : String(event.key || '').toLowerCase();
  const nonAscii = key === 'dead' || key === 'unidentified' || (key.length === 1 && key.charCodeAt(0) > 0x7e);
  if (nonAscii && physicalKey(event.code)) key = physicalKey(event.code);
  // On macOS, Option changes the character (Option+S types "ß"), so with Alt held a letter or digit
  // shortcut is read from the physical key instead.
  if (event.altKey && /^(Key[A-Z]|Digit[0-9])$/.test(event.code || '')) key = event.code.slice(-1).toLowerCase();
  const mods = [];
  if (event.altKey) mods.push('alt');
  // Shift is meaningful only for keys whose character does not already encode it.
  if (event.shiftKey && (key.length > 1 || /^[a-z]$/.test(key))) mods.push('shift');
  return [...mods, key].join('+');
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/* Returns why a value breaks a property schema, or null. A JSON-schema subset: type (one or a list),
   enum, minimum, maximum, maxLength, pattern. Numbers must be finite. */
export function schemaProblem(schema, value) {
  if (!schema || typeof schema !== 'object') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return 'must be a finite number';
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some(type => type === actual || (type === 'number' && actual === 'integer'))) {
      return `must be ${allowed.join(' or ')}, not ${actual}`;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `must be one of ${schema.enum.map(item => JSON.stringify(item)).join(', ')}`;
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `must be at least ${schema.minimum}`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `must be at most ${schema.maximum}`;
  }
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return `must be at most ${schema.maxLength} characters`;
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return 'has the wrong format';
  }
  return null;
}

function validateDefinition(def) {
  const problems = [];
  // The NakliOS rail rule (lower case, no camelCase), with a namespace required.
  if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){1,3}$/.test(def?.name || '')) problems.push('name');
  if (!def.description) problems.push('description');
  if (!SCOPES.includes(def.scope)) problems.push('scope');
  if (def.scope === 'destructive' && !def.readTwin) problems.push('readTwin');
  if (def.repeat !== undefined && def.repeat !== true) problems.push('repeat');
  if (!def.input || def.input.type !== 'object' || !Array.isArray(def.input.required)) problems.push('input');
  if (!def.label) problems.push('label');
  if (problems.length) throw new TypeError(`Command ${def?.name || '(unnamed)'} is missing or has a bad: ${problems.join(', ')}`);
}

const inputError = message => Object.assign(new TypeError(message), { code: 'ERR_COMMAND_INPUT' });

export function createRegistry() {
  const defs = new Map();
  const handlers = new Map();
  const shortcuts = new Map();

  function define(list) {
    for (const def of list) {
      validateDefinition(def);
      if (defs.has(def.name)) throw new Error(`Command ${def.name} is defined twice.`);
      for (const shortcut of def.shortcuts || []) {
        if (shortcuts.has(shortcut.key)) {
          throw new Error(`Shortcut ${shortcut.key} is claimed by ${shortcuts.get(shortcut.key).name} and ${def.name}.`);
        }
        shortcuts.set(shortcut.key, { name: def.name, input: shortcut.input || {} });
      }
      defs.set(def.name, Object.freeze({ ...def }));
    }
  }

  function handle(name, fn) {
    if (!defs.has(name)) throw new Error(`No command named ${name} to handle.`);
    if (handlers.has(name)) throw new Error(`Command ${name} already has a handler.`);
    handlers.set(name, fn);
  }

  function checkInput(def, input) {
    const value = input ?? {};
    if (typeof value !== 'object' || Array.isArray(value)) throw inputError(`${def.name} takes an object input.`);
    for (const key of def.input.required) {
      if (!(key in value) || value[key] === undefined) throw inputError(`${def.name} needs "${key}".`);
    }
    for (const [key, schema] of Object.entries(def.input.properties || {})) {
      if (!(key in value) || value[key] === undefined) continue;
      const problem = schemaProblem(schema, value[key]);
      if (problem) throw inputError(`${def.name}: "${key}" ${problem}.`);
    }
    return value;
  }

  async function run(name, input) {
    const def = defs.get(name);
    if (!def) throw Object.assign(new Error(`No command named ${name}.`), { code: 'ERR_COMMAND_NOT_FOUND' });
    const fn = handlers.get(name);
    if (!fn) throw Object.assign(new Error(`Command ${name} has no handler.`), { code: 'ERR_COMMAND_UNBOUND' });
    return fn(checkInput(def, input));
  }

  /* Returns { def, input } for a key spec, or null. */
  function forShortcut(spec) {
    const hit = shortcuts.get(spec);
    return hit ? { def: defs.get(hit.name), input: hit.input } : null;
  }

  function list() { return [...defs.values()]; }
  function unbound() { return [...defs.keys()].filter(name => !handlers.has(name)); }
  function has(name) { return defs.has(name); }

  return Object.freeze({ define, handle, run, forShortcut, list, unbound, has });
}

/* Serialisable manifest, the shape of Montella's commands.json plus label and shortcut. A destructive
   command carries scope "destructive"; hosts map it to a confirmation (WebMCP destructiveHint). */
export function manifest(definitions, accepts) {
  return {
    accepts,
    commands: definitions.map(({ name, description, scope, input, label, shortcuts, readTwin }) => ({
      name, description, scope, input, label,
      ...(shortcuts?.length ? { shortcuts } : {}),
      ...(readTwin ? { readTwin } : {}),
    })),
  };
}
