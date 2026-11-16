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
 *   scope        "read" or "write"
 *   input        JSON schema object ({ type: "object", properties, required })
 *   label        short human label for buttons and the help sheet
 *   shortcuts    optional list of { key, input? }: key is a spec such as "space", "arrowleft",
 *                "shift+arrowleft", ".", "?", "shift+n" (KeyboardEvent.key lowercased, modifiers
 *                shift and alt only, never ctrl or meta); input is passed when that key fires
 *   readTwin     for write commands: the read command that reports the changed value
 */

export function keySpec(event) {
  let key = event.key === ' ' ? 'space' : event.key.toLowerCase();
  // On macOS, Option changes the character (Option+S types "ß"), so with Alt held a letter or digit
  // shortcut is read from the physical key instead.
  if (event.altKey && /^(Key[A-Z]|Digit[0-9])$/.test(event.code || '')) key = event.code.slice(-1).toLowerCase();
  const mods = [];
  if (event.altKey) mods.push('alt');
  // Shift is meaningful only for keys whose character does not already encode it.
  if (event.shiftKey && (key.length > 1 || /^[a-z]$/.test(key))) mods.push('shift');
  return [...mods, key].join('+');
}

function validateDefinition(def) {
  const problems = [];
  // The NakliOS rail rule (lower case, no camelCase), with a namespace required.
  if (!/^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*){1,3}$/.test(def?.name || '')) problems.push('name');
  if (!def.description) problems.push('description');
  if (!['read', 'write'].includes(def.scope)) problems.push('scope');
  if (!def.input || def.input.type !== 'object' || !Array.isArray(def.input.required)) problems.push('input');
  if (!def.label) problems.push('label');
  if (problems.length) throw new TypeError(`Command ${def?.name || '(unnamed)'} is missing or has a bad: ${problems.join(', ')}`);
}

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
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw Object.assign(new TypeError(`${def.name} takes an object input.`), { code: 'ERR_COMMAND_INPUT' });
    }
    for (const key of def.input.required) {
      if (!(key in value)) {
        throw Object.assign(new TypeError(`${def.name} needs "${key}".`), { code: 'ERR_COMMAND_INPUT' });
      }
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

/* Serialisable manifest, the shape of Montella's commands.json plus label and shortcut. */
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
