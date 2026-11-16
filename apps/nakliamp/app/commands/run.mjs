// run.mjs — binds handlers to COMMANDS and runs them (N1, N3, K2).
//
// `bindCommands(handlers, { confirm })` returns `run(name, input, options)`:
//   1. an unknown name, or a name with no handler, refuses with `[not-found]`;
//   2. the input is validated against the command's JSON Schema, `[invalid-input]` if not;
//   3. a destructive command builds its diff (handler.diff), calls `confirm(request)` and
//      refuses with `[declined]` unless it resolves true. `options.approved` skips the
//      prompt when someone else already asked the person (the NakliOS host stages
//      destructive commands itself before it calls the handler).
//   4. a command marked `askEveryTime` (network.grant, N16) asks through `confirm` on every
//      call, `approved` or not, because turning a service on is the person's consent and
//      no caller may give it for them. `options.byPerson` skips the prompt; only the
//      Network panel's switch passes it, because that click is the person's answer.
// A handler is a function `(input, context) => result`, or `{ run, diff? }`.
// A queue-editing command (`ifRevision: true` in COMMANDS) may carry `if_revision`; when
// `revision()` has moved past it the command refuses with `[conflict]` before it runs,
// as cliamp's IPC v2 does. The handler never sees `if_revision`.
//
// Also here: the keyboard. `matchShortcut(event)` turns a KeyboardEvent-like object into
// `{ name, input }` and `keymapRows()` builds the keymap overlay from the same list.

import { COMMANDS, commandByName, railScope } from './commands.mjs';
import { revisionConflict } from '../player/queue.mjs';

export class CommandError extends Error {
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'CommandError';
    this.code = code;
  }
}

// ------------------------------------------------------------ validation ----

const typeOf = v => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

function typeMatches(type, v) {
  if (type === 'integer') return Number.isInteger(v);
  if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeOf(v) === type;
}

/**
 * Validate `value` against the JSON Schema subset NakliAmp uses: type, properties,
 * required, additionalProperties (false), enum, minimum, maximum, minLength, maxLength,
 * items, minItems, maxItems, minProperties, maxProperties. Returns a list of messages.
 */
export function validate(schema, value, path = 'input') {
  if (!schema || typeof schema !== 'object') return [];
  if (schema.type && !typeMatches(schema.type, value)) return [typeError(schema.type, path)];
  const errors = [];
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') errors.push(...rangeErrors(schema, path, value, 'minimum', 'maximum', (w, n) => `be ${w} ${n}`));
  if (typeof value === 'string') errors.push(...rangeErrors(schema, path, value.length, 'minLength', 'maxLength', (w, n) => `have ${w} ${n} characters`));
  if (Array.isArray(value)) errors.push(...arrayErrors(schema, value, path));
  if (typeOf(value) === 'object') errors.push(...objectErrors(schema, value, path));
  return errors;
}

const typeError = (type, path) => `${path} must be ${type === 'integer' ? 'an integer' : `of type ${type}`}`;

// `size` against the schema's lower and upper bound, named by `minKey` and `maxKey`.
function rangeErrors(schema, path, size, minKey, maxKey, describe) {
  const errors = [];
  if (schema[minKey] !== undefined && size < schema[minKey]) errors.push(`${path} must ${describe('at least', schema[minKey])}`);
  if (schema[maxKey] !== undefined && size > schema[maxKey]) errors.push(`${path} must ${describe('at most', schema[maxKey])}`);
  return errors;
}

function arrayErrors(schema, value, path) {
  const errors = rangeErrors(schema, path, value.length, 'minItems', 'maxItems', (w, n) => `have ${w} ${n} items`);
  if (schema.items) value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  return errors;
}

function objectErrors(schema, value, path) {
  const props = schema.properties ?? {};
  const present = Object.keys(value).filter(k => value[k] !== undefined);
  const errors = [];
  for (const key of schema.required ?? []) {
    if (value[key] === undefined) errors.push(`${path}.${key} is required`);
  }
  for (const key of present) {
    if (props[key]) errors.push(...validate(props[key], value[key], `${path}.${key}`));
    else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not a known field`);
  }
  errors.push(...propertyCountErrors(schema, present.length, Object.keys(props), path));
  return errors;
}

function propertyCountErrors(schema, count, names, path) {
  const errors = [];
  if (schema.minProperties !== undefined && count < schema.minProperties) {
    errors.push(`${path} needs at least ${schema.minProperties} of: ${names.join(', ')}`);
  }
  if (schema.maxProperties !== undefined && count > schema.maxProperties) {
    errors.push(`${path} takes at most ${schema.maxProperties} of: ${names.join(', ')}`);
  }
  return errors;
}

// ------------------------------------------------------------------- run ----

/**
 * @param {Record<string, Function | { run: Function, diff?: Function }>} handlers
 * @param {{ confirm?: (request: { name, label, input, diff }) => boolean|Promise<boolean>,
 *           revision?: () => number }} [options]
 */
export function bindCommands(handlers = {}, { confirm = null, revision = null } = {}) {
  return async function run(name, input = {}, { approved = false, byPerson = false, context = {} } = {}) {
    const { command, handler, runFn } = resolveHandler(handlers, name);
    const given = input ?? {};
    const errors = validate(command.input, given);
    if (errors.length) throw new CommandError('invalid-input', `${name}: ${errors.join('; ')}.`);
    const args = command.ifRevision ? withoutRevision(given, revision) : given;
    const ask = command.askEveryTime ? !byPerson : command.scope === 'destructive' && !approved;
    if (ask) await askApproval({ name, command, handler, args, context, confirm });
    return runFn(args, context);
  };
}

// Refuse a stale `if_revision` with `[conflict]`; return the input without it.
function withoutRevision(input, revision) {
  const { if_revision: expected, ...rest } = input;
  if (expected !== undefined) {
    const current = typeof revision === 'function' ? revision() : null;
    const conflict = current === null ? null : revisionConflict(expected, current);
    if (conflict) throw new CommandError('conflict', conflict);
  }
  return rest;
}

// The command and its run function, or a `[not-found]` refusal.
function resolveHandler(handlers, name) {
  const command = commandByName.get(name);
  if (!command) throw new CommandError('not-found', `No command named ${String(name)}.`);
  const handler = handlers[name];
  const runFn = typeof handler === 'function' ? handler : handler?.run;
  if (typeof runFn !== 'function') throw new CommandError('not-found', `${name} has no handler in this build.`);
  return { command, handler, runFn };
}

// Build the diff, ask `confirm`, and refuse with `[declined]` unless it says true.
async function askApproval({ name, command, handler, args, context, confirm }) {
  const diff = typeof handler?.diff === 'function' ? await handler.diff(args, context) : null;
  let ok = false;
  if (typeof confirm === 'function') ok = (await confirm({ name, label: command.label, input: args, diff })) === true;
  if (!ok) throw new CommandError('declined', `${command.label} was not approved.`);
}

/**
 * The list `host.registerCommands` takes. The host stages destructive commands and asks
 * the person before it calls a handler, so these calls arrive approved.
 */
export function hostCommandList(run) {
  return COMMANDS.map(c => ({
    name: c.name,
    description: c.description,
    input: c.input,
    scope: railScope(c),
    handler: args => run(c.name, args ?? {}, { approved: true, context: { from: 'host' } }),
  }));
}

// -------------------------------------------------------------- keyboard ----

const NAMED = { ' ': 'Space', Spacebar: 'Space', Esc: 'Escape', Del: 'Delete', Left: 'ArrowLeft', Right: 'ArrowRight', Up: 'ArrowUp', Down: 'ArrowDown' };

/**
 * The canonical shortcut string for a KeyboardEvent-like object, or null for a bare
 * modifier. Order: Mod (Ctrl or Cmd), Alt, Shift, key. Letters are upper case and
 * Shift is written out for them, so `v` is 'V' and Shift+v is 'Shift+V' whatever Caps
 * Lock says. Punctuation and digits already carry Shift in the character, so '?' is '?'.
 * With Alt, the physical key decides (Alt+1 types '¡' on a Mac).
 */
export function shortcutOf(event) {
  if (!event || typeof event.key !== 'string') return null;
  if (['Shift', 'Alt', 'Control', 'Meta', 'AltGraph', 'CapsLock'].includes(event.key)) return null;
  let key = physicalKey(event);
  const letter = /^[a-z]$/i.test(key);
  if (letter) key = key.toUpperCase();
  const named = key.length > 1;
  const mods = [];
  if (event.ctrlKey || event.metaKey) mods.push('Mod');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey && (letter || named)) mods.push('Shift');
  return [...mods, key].join('+');
}

// The key name; with a modifier held, the physical digit or letter key decides.
function physicalKey(event) {
  const key = NAMED[event.key] ?? event.key;
  if (!(event.altKey || event.ctrlKey || event.metaKey)) return key;
  const code = typeof event.code === 'string' ? event.code : '';
  const m = code.match(/^(?:Digit|Numpad)(\d)$/) || code.match(/^Key([A-Z])$/);
  return m ? m[1] : key;
}

function buildKeyIndex() {
  const index = new Map();
  for (const c of COMMANDS) {
    for (const b of c.keys ?? []) {
      if (index.has(b.key)) throw new Error(`Shortcut ${b.key} is bound to both ${index.get(b.key).name} and ${c.name}`);
      index.set(b.key, { name: c.name, input: b.input ? { ...b.input } : {} });
    }
  }
  return index;
}
const KEY_INDEX = buildKeyIndex();

function inEditable(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName || '').toUpperCase());
}

// Roles whose element presses, opens or picks on Enter or Space itself (N7).
const ACTIVATING_ROLES = new Set(['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox',
  'radio', 'switch', 'option', 'treeitem', 'gridcell', 'combobox', 'slider', 'spinbutton']);

/** True when Enter and Space belong to the focused element: a button, link, summary or an interactive role. */
export function ownsActivationKeys(target) {
  if (!target || typeof target !== 'object') return false;
  if (/^(BUTTON|A|SUMMARY)$/.test(String(target.tagName || '').toUpperCase())) return true;
  const role = typeof target.getAttribute === 'function' ? String(target.getAttribute('role') ?? '').trim().toLowerCase() : '';
  return ACTIVATING_ROLES.has(role);
}

const MODAL = '[aria-modal="true"],[role="menu"]';

/**
 * True when a modal dialog or an open menu owns the keyboard (N8): the target sits
 * inside one, or the target's document holds an open modal (focus fell to the body).
 */
export function behindModal(target) {
  if (!target || typeof target !== 'object') return false;
  if (typeof target.closest === 'function' && target.closest(MODAL)) return true;
  const doc = target.nodeType === 9 ? target : target.ownerDocument;
  return Boolean(doc && typeof doc.querySelector === 'function' && doc.querySelector('[aria-modal="true"]'));
}

/**
 * `{ name, input }` for a key press, or null when no command owns it, focus is in a
 * text field, a modal dialog or menu is open, or the key is Enter or Space on an
 * element that activates on it.
 */
export function matchShortcut(event) {
  const target = event?.target;
  if (inEditable(target) || behindModal(target)) return null;
  const key = shortcutOf(event);
  if (!key) return null;
  if ((key === 'Space' || key === 'Enter') && ownsActivationKeys(target)) return null;
  const hit = KEY_INDEX.get(key);
  return hit ? { name: hit.name, input: { ...hit.input } } : null;
}

const ARROWS = { ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' };

/** How a shortcut is shown to a person. `mac` picks ⌘ and ⌥ over Ctrl and Alt. */
export function displayKey(key, { mac = false } = {}) {
  return key.split('+').map(part => {
    if (part === 'Mod') return mac ? '⌘' : 'Ctrl';
    if (part === 'Alt') return mac ? '⌥' : 'Alt';
    if (part === 'Shift') return mac ? '⇧' : 'Shift';
    if (part === 'Escape') return 'Esc';
    if (part === 'Delete') return mac ? 'Delete' : 'Del';
    return ARROWS[part] ?? part;
  }).join(mac ? '' : '+');
}

/**
 * Rows for the keymap overlay (K2), grouped in COMMANDS order:
 * `[{ group, groupLabel, rows: [{ name, keys: [display strings], label }] }]`.
 * A command with more than four keys (number keys, ratings) collapses into one row.
 */
export function keymapRows({ mac = false, groupLabels = {} } = {}) {
  const groups = new Map();
  for (const c of COMMANDS) {
    if (!c.keys?.length) continue;
    if (!groups.has(c.group)) groups.set(c.group, { group: c.group, groupLabel: groupLabels[c.group] ?? c.group, rows: [] });
    groups.get(c.group).rows.push(...commandRows(c, mac));
  }
  return [...groups.values()];
}

// One row per key, or one collapsed "first to last" row for a long run such as
// the digits 0 to 9. A command with a handful of named keys stays listed.
function commandRows(c, mac) {
  if (c.keys.length > 5) {
    const first = displayKey(c.keys[0].key, { mac });
    const last = displayKey(c.keys[c.keys.length - 1].key, { mac });
    return [{ name: c.name, keys: [`${first} to ${last}`], label: c.keymapLabel ?? c.label }];
  }
  return c.keys.map(b => ({ name: c.name, keys: [displayKey(b.key, { mac })], label: b.label ?? c.label }));
}
