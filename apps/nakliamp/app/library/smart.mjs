// Smart playlists (Y3): rules over the library index.
//
// A rule is a small JSON document the person owns, stored beside the M3U8s as
// `<name>.nakliamp-smart.json` in the folder root:
//
//   { "version": 1, "name": "Unplayed jazz", "match": "all",
//     "rules": [{ "field": "genre", "op": "is", "value": "Jazz" },
//               { "field": "playCount", "op": "is", "value": 0 }],
//     "limit": 50, "sort": { "key": "addedAt", "direction": "desc" } }
//
// Validation refuses unknown fields, operators and keys by name, because a
// rule file is data from disk and a silently ignored clause changes the list.
//
// Headless by contract: no DOM, no network.

import { sortTracks, SORT_KEYS } from './views.mjs';
import { safePlaylistFileName } from './playlist.mjs';

export const SMART_SUFFIX = '.nakliamp-smart.json';
export const SMART_VERSION = 1;

const TEXT_FIELDS = Object.freeze(['genre', 'artist', 'albumArtist', 'album', 'title', 'path']);
const NUMBER_FIELDS = Object.freeze(['year', 'rating', 'playCount', 'durationS']);
const DATE_FIELDS = Object.freeze(['lastPlayedAt', 'addedAt']);
const BOOLEAN_FIELDS = Object.freeze(['favourite']);

export const SMART_FIELDS = Object.freeze([...TEXT_FIELDS, ...NUMBER_FIELDS, ...DATE_FIELDS, ...BOOLEAN_FIELDS]);
export const SMART_OPS = Object.freeze([
  'is', 'is-not', 'contains', 'not-contains', 'gt', 'lt', 'between', 'in-last-days', 'not-in-last-days',
]);

/** Which operators each kind of field accepts. */
const OPS_FOR = Object.freeze({
  text: ['is', 'is-not', 'contains', 'not-contains'],
  number: ['is', 'is-not', 'gt', 'lt', 'between'],
  date: ['gt', 'lt', 'between', 'in-last-days', 'not-in-last-days'],
  boolean: ['is', 'is-not'],
});

const TOP_KEYS = Object.freeze(['version', 'name', 'match', 'rules', 'limit', 'sort']);
const RULE_KEYS = Object.freeze(['field', 'op', 'value']);
const MAX_RULES = 50;
const MAX_TEXT = 500;
const DAY_MS = 86_400_000;

export class SmartRuleError extends Error {
  constructor(message, where) {
    super(message);
    this.name = 'SmartRuleError';
    this.code = 'ERR_NAKLIAMP_SMART_INVALID';
    this.where = where;
  }
}

function kindOf(field) {
  if (TEXT_FIELDS.includes(field)) return 'text';
  if (NUMBER_FIELDS.includes(field)) return 'number';
  if (DATE_FIELDS.includes(field)) return 'date';
  return 'boolean';
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

function refuseUnknownKeys(object, allowed, where) {
  const unknown = Object.keys(object).filter(key => !allowed.includes(key));
  if (unknown.length) throw new SmartRuleError(`Unknown key in ${where}: ${unknown.join(', ')}`, where);
}

/** Refuse a clause value that does not suit the field kind and operator. */
function checkClauseValue(kind, field, op, value, where) {
  if (kind === 'text') {
    if (typeof value !== 'string' || value.length > MAX_TEXT) {
      throw new SmartRuleError(`${where}: ${field} needs a text value.`, where);
    }
  } else if (kind === 'boolean') {
    if (typeof value !== 'boolean') throw new SmartRuleError(`${where}: ${field} needs true or false.`, where);
  } else {
    checkNumericValue(field, op, value, where);
  }
}

function checkNumericValue(field, op, value, where) {
  if (op === 'between') {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(isNumber)) {
      throw new SmartRuleError(`${where}: between needs [low, high] numbers.`, where);
    }
  } else if (op === 'in-last-days' || op === 'not-in-last-days') {
    if (!isNumber(value) || value < 0) throw new SmartRuleError(`${where}: ${op} needs a number of days.`, where);
  } else if (!isNumber(value)) {
    throw new SmartRuleError(`${where}: ${field} needs a number.`, where);
  }
}

function validateClause(clause, index) {
  const where = `rules[${index}]`;
  if (!isPlainObject(clause)) throw new SmartRuleError(`${where} is not an object.`, where);
  refuseUnknownKeys(clause, RULE_KEYS, where);
  const { field, op, value } = clause;
  if (!SMART_FIELDS.includes(field)) throw new SmartRuleError(`Unknown field in ${where}: ${String(field)}`, where);
  if (!SMART_OPS.includes(op)) throw new SmartRuleError(`Unknown operator in ${where}: ${String(op)}`, where);
  const kind = kindOf(field);
  if (!OPS_FOR[kind].includes(op)) {
    throw new SmartRuleError(`Operator ${op} does not apply to field ${field} in ${where}.`, where);
  }
  checkClauseValue(kind, field, op, value, where);
  return { field, op, value: Array.isArray(value) ? [...value] : value };
}

function validateHeader(rule) {
  if (rule.version !== undefined && rule.version !== SMART_VERSION) {
    throw new SmartRuleError(`Unsupported smart playlist version: ${String(rule.version)}`, 'version');
  }
  if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 200) {
    throw new SmartRuleError('A smart playlist needs a name.', 'name');
  }
  const match = rule.match ?? 'all';
  if (match !== 'all' && match !== 'any') throw new SmartRuleError(`Unknown match mode: ${String(match)}`, 'match');
  if (!Array.isArray(rule.rules)) throw new SmartRuleError('rules is not a list.', 'rules');
  if (rule.rules.length > MAX_RULES) throw new SmartRuleError(`At most ${MAX_RULES} rules.`, 'rules');
  return match;
}

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
    throw new SmartRuleError('limit is not a whole number from 1 to 100000.', 'limit');
  }
  return limit;
}

function validateSort(sort) {
  if (!isPlainObject(sort)) throw new SmartRuleError('sort is not an object.', 'sort');
  refuseUnknownKeys(sort, ['key', 'direction'], 'sort');
  if (!SORT_KEYS.includes(sort.key)) throw new SmartRuleError(`Unknown sort key: ${String(sort.key)}`, 'sort');
  const direction = sort.direction ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc') throw new SmartRuleError(`Unknown sort direction: ${String(direction)}`, 'sort');
  return { key: sort.key, direction };
}

/** Validate and normalise a rule object. Throws SmartRuleError naming the problem. */
export function validateSmart(rule) {
  if (!isPlainObject(rule)) throw new SmartRuleError('A smart playlist is not an object.', 'rule');
  refuseUnknownKeys(rule, TOP_KEYS, 'rule');
  const match = validateHeader(rule);
  const rules = rule.rules.map(validateClause);

  const out = { version: SMART_VERSION, name: rule.name.trim(), match, rules };
  if (rule.limit !== undefined && rule.limit !== null) out.limit = validateLimit(rule.limit);
  if (rule.sort !== undefined && rule.sort !== null) out.sort = validateSort(rule.sort);
  return out;
}

const fold = value => String(value ?? '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function fieldValue(track, field) {
  if (field === 'favourite') return Boolean(track.bookmarked);
  return track[field] ?? null;
}

function compileText(field, op, value) {
  const needle = fold(value);
  switch (op) {
    case 'is': return track => fold(fieldValue(track, field)) === needle;
    case 'is-not': return track => fold(fieldValue(track, field)) !== needle;
    case 'contains': return track => fold(fieldValue(track, field)).includes(needle);
    default: return track => !fold(fieldValue(track, field)).includes(needle);
  }
}

/**
 * Numbers and dates. A missing number never matches a comparison, so a
 * track with no year is not "before 1970".
 */
function compileNumeric(field, op, value, now) {
  const numeric = track => {
    const number = fieldValue(track, field);
    return isNumber(number) ? number : null;
  };
  switch (op) {
    case 'is': return track => numeric(track) === value;
    case 'is-not': return track => numeric(track) !== value;
    case 'gt': return track => { const n = numeric(track); return n !== null && n > value; };
    case 'lt': return track => { const n = numeric(track); return n !== null && n < value; };
    case 'between': {
      const [low, high] = value[0] <= value[1] ? value : [value[1], value[0]];
      return track => { const n = numeric(track); return n !== null && n >= low && n <= high; };
    }
    case 'in-last-days': {
      const since = now - value * DAY_MS;
      // 0 is the stored "never" for these fields.
      return track => { const n = numeric(track); return n !== null && n > 0 && n >= since; };
    }
    default: {
      const since = now - value * DAY_MS;
      return track => { const n = numeric(track); return !(n !== null && n > 0 && n >= since); };
    }
  }
}

/** Compile one clause into a predicate. Text compares fold case and accents. */
function compile(clause, now) {
  const { field, op, value } = clause;
  const kind = kindOf(field);
  if (kind === 'text') return compileText(field, op, value);
  if (kind === 'boolean') {
    return op === 'is' ? track => fieldValue(track, field) === value : track => fieldValue(track, field) !== value;
  }
  return compileNumeric(field, op, value, now);
}

/**
 * The tracks a rule selects, sorted and limited. A rule with no clauses
 * selects everything (match all) or nothing (match any).
 */
export function evaluateSmart(rule, tracks, { now = Date.now() } = {}) {
  const valid = validateSmart(rule);
  const predicates = valid.rules.map(clause => compile(clause, now));
  const selected = valid.match === 'all'
    ? tracks.filter(track => predicates.every(test => test(track)))
    : tracks.filter(track => predicates.some(test => test(track)));
  const sorted = valid.sort ? sortTracks(selected, valid.sort.key, valid.sort.direction) : selected;
  return valid.limit ? sorted.slice(0, valid.limit) : sorted;
}

/** Parse a `.nakliamp-smart.json` file. Throws SmartRuleError on bad JSON or rules. */
export function parseSmart(text) {
  let document;
  try {
    document = JSON.parse(String(text ?? ''));
  } catch (error) {
    throw new SmartRuleError(`Not valid JSON: ${error.message}`, 'json');
  }
  return validateSmart(document);
}

/** Serialise a rule. Stable key order and a trailing newline, so it diffs cleanly. */
export function serialiseSmart(rule) {
  const valid = validateSmart(rule);
  const ordered = { version: valid.version, name: valid.name, match: valid.match, rules: valid.rules };
  if (valid.limit) ordered.limit = valid.limit;
  if (valid.sort) ordered.sort = valid.sort;
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

/** The file name a smart playlist is saved under, in the folder root. */
export function smartFileName(name) {
  return `${safePlaylistFileName(name)}${SMART_SUFFIX}`;
}

export function isSmartPath(path) {
  return String(path ?? '').toLowerCase().endsWith(SMART_SUFFIX);
}
