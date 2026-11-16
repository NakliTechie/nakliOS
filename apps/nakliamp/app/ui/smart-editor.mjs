// smart-editor.mjs: create and edit a smart playlist (Y3).
//
// Name, match all or any, rule rows (field, operator, and a value input that suits
// the field), limit and sort, a live count of matching tracks, Save (through
// `smart.create`) and Export as M3U8 (through `playlist.create`, which freezes the
// current matches into a file).
//
// The form model is pure and exported for tests: `blankRow`, `opsFor`, `rowToClause`,
// `clauseToRow`, `formToRule`, `ruleToForm`, `ruleForCommand`. A row holds the raw
// strings the inputs show (`a`, and `b` for the upper bound of "between"), so a
// half-typed value never loses what the person wrote.

import { evaluateSmart, validateSmart, SMART_FIELDS } from '../library/smart.mjs';
import { SORT_KEYS } from '../library/views.mjs';
import { SORT_LABELS } from './browse.mjs';

/** Field labels and kinds. Kinds match the operator table in app/library/smart.mjs. */
export const FIELD_SPECS = Object.freeze({
  title: { label: 'Title', kind: 'text' },
  artist: { label: 'Artist', kind: 'text' },
  albumArtist: { label: 'Album artist', kind: 'text' },
  album: { label: 'Album', kind: 'text' },
  genre: { label: 'Genre', kind: 'text' },
  path: { label: 'File path', kind: 'text' },
  year: { label: 'Year', kind: 'number' },
  rating: { label: 'Rating', kind: 'rating' },
  playCount: { label: 'Play count', kind: 'number' },
  durationS: { label: 'Duration (minutes)', kind: 'minutes' },
  addedAt: { label: 'Date added', kind: 'date' },
  lastPlayedAt: { label: 'Last played', kind: 'date' },
  favourite: { label: 'Favourite', kind: 'boolean' },
});

export const OP_LABELS = Object.freeze({
  is: 'is', 'is-not': 'is not', contains: 'contains', 'not-contains': 'does not contain',
  gt: 'is more than', lt: 'is less than', between: 'is between',
  'in-last-days': 'is in the last', 'not-in-last-days': 'is not in the last',
});
const DATE_OP_LABELS = Object.freeze({ gt: 'is after', lt: 'is before', between: 'is between' });

const OPS_BY_KIND = Object.freeze({
  text: ['contains', 'not-contains', 'is', 'is-not'],
  number: ['is', 'is-not', 'gt', 'lt', 'between'],
  rating: ['is', 'is-not', 'gt', 'lt', 'between'],
  minutes: ['gt', 'lt', 'between', 'is', 'is-not'],
  date: ['in-last-days', 'not-in-last-days', 'gt', 'lt', 'between'],
  boolean: ['is', 'is-not'],
});

export const MAX_LIMIT = 10000; // the smart.create command schema's maximum

export class SmartFormError extends Error {
  constructor(message, row = null) {
    super(message);
    this.name = 'SmartFormError';
    this.row = row;
  }
}

export const kindOf = field => FIELD_SPECS[field]?.kind ?? 'text';
export const opsFor = field => OPS_BY_KIND[kindOf(field)];
export const opLabel = (field, op) => (kindOf(field) === 'date' && DATE_OP_LABELS[op]) || OP_LABELS[op] || op;

const pad = number => String(number).padStart(2, '0');

/** A `YYYY-MM-DD` string for a timestamp, in local time (what a date input shows). */
export function msToDateInput(ms) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a `YYYY-MM-DD` string, or null. */
export function dateInputToMs(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

/** A fresh row for `field` with its first operator and a sensible starting value. */
export function blankRow(field = 'genre') {
  const kind = kindOf(field);
  const op = OPS_BY_KIND[kind][0];
  const a = { boolean: 'true', rating: '4', date: '30', number: '', minutes: '', text: '' }[kind];
  return { field, op, a, b: '' };
}

/** Keep a row valid after the person picks a new field or operator. */
export function normaliseRow(row) {
  const ops = opsFor(row.field);
  if (ops.includes(row.op) && kindOf(row.field) === kindOf(row.previousField ?? row.field)) {
    const rest = { ...row };
    delete rest.previousField;
    return rest;
  }
  const fresh = blankRow(row.field);
  if (ops.includes(row.op)) fresh.op = row.op;
  return fresh;
}

function parseNumber(text, row, what) {
  const value = Number(String(text ?? '').trim());
  if (String(text ?? '').trim() === '' || !Number.isFinite(value)) {
    throw new SmartFormError(`Rule ${row + 1}: ${what} needs a number.`, row);
  }
  return value;
}

/** One rule row (raw input strings) to a rule clause `{ field, op, value }`. */
export function rowToClause(input, row = 0) {
  const { field, op } = input;
  if (!SMART_FIELDS.includes(field)) throw new SmartFormError(`Rule ${row + 1}: unknown field ${String(field)}.`, row);
  if (!opsFor(field).includes(op)) throw new SmartFormError(`Rule ${row + 1}: ${OP_LABELS[op] ?? op} does not apply to ${FIELD_SPECS[field].label}.`, row);
  const kind = kindOf(field);
  const label = FIELD_SPECS[field].label.toLowerCase();

  if (kind === 'text') return { field, op, value: String(input.a ?? '') };
  if (kind === 'boolean') return { field, op, value: String(input.a) !== 'false' };
  if (kind === 'date') return dateClause(field, op, input, row, label);
  return numberClause(field, op, input, row, { kind, label });
}

function dateClause(field, op, input, row, label) {
  if (op === 'in-last-days' || op === 'not-in-last-days') {
    const days = parseNumber(input.a, row, 'the number of days');
    if (days < 0) throw new SmartFormError(`Rule ${row + 1}: the number of days cannot be negative.`, row);
    return { field, op, value: days };
  }
  const toMs = (text, which) => {
    const ms = dateInputToMs(text);
    if (ms === null) throw new SmartFormError(`Rule ${row + 1}: ${which} needs a date.`, row);
    return ms;
  };
  if (op === 'between') return { field, op, value: [toMs(input.a, 'the first date'), toMs(input.b, 'the second date')] };
  return { field, op, value: toMs(input.a, label) };
}

function numberClause(field, op, input, row, { kind, label }) {
  const scale = kind === 'minutes' ? 60 : 1;
  const read = text => {
    const number = parseNumber(text, row, label);
    return kind === 'minutes' ? Math.round(number * scale * 1000) / 1000 : number;
  };
  if (op === 'between') return { field, op, value: [read(input.a), read(input.b)] };
  return { field, op, value: read(input.a) };
}

/** A rule clause back to a row of raw input strings. */
export function clauseToRow(clause) {
  const { field, op, value } = clause;
  const kind = kindOf(field);
  const show = number => {
    if (kind === 'date' && op !== 'in-last-days' && op !== 'not-in-last-days') return msToDateInput(number);
    if (kind === 'minutes') return String(Math.round((number / 60) * 1000) / 1000);
    return String(number);
  };
  if (kind === 'text') return { field, op, a: String(value ?? ''), b: '' };
  if (kind === 'boolean') return { field, op, a: value ? 'true' : 'false', b: '' };
  if (Array.isArray(value)) return { field, op, a: show(value[0]), b: show(value[1]) };
  return { field, op, a: show(value), b: '' };
}

/**
 * The whole form to a validated rule. Throws SmartFormError (for a row the
 * person can fix) or SmartRuleError (from app/library/smart.mjs).
 * form: `{ name, match, rows, limit (string), sortKey, sortDirection }`.
 */
export function formToRule(form) {
  const name = String(form.name ?? '').trim();
  if (!name) throw new SmartFormError('Give the smart playlist a name.');
  const rule = { name, match: form.match === 'any' ? 'any' : 'all', rules: (form.rows ?? []).map(rowToClause) };
  const limitText = String(form.limit ?? '').trim();
  if (limitText) {
    const limit = Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new SmartFormError(`The limit is a whole number from 1 to ${MAX_LIMIT}.`);
    }
    rule.limit = limit;
  }
  if (form.sortKey) rule.sort = { key: form.sortKey, direction: form.sortDirection === 'desc' ? 'desc' : 'asc' };
  return validateSmart(rule);
}

/** The rule row an error points at (SmartFormError.row or SmartRuleError.where 'rules[n]'), or -1. */
export function problemRow(problem) {
  if (Number.isInteger(problem?.row)) return problem.row;
  const match = /^rules\[(\d+)\]/.exec(String(problem?.where ?? ''));
  return match ? Number(match[1]) : -1;
}

/** A stored rule to the form model. */
export function ruleToForm(rule) {
  if (!rule) return { name: '', match: 'all', rows: [blankRow('genre')], limit: '', sortKey: '', sortDirection: 'asc' };
  const valid = validateSmart(rule);
  return {
    name: valid.name,
    match: valid.match,
    rows: valid.rules.map(clauseToRow),
    limit: valid.limit ? String(valid.limit) : '',
    sortKey: valid.sort?.key ?? '',
    sortDirection: valid.sort?.direction ?? 'asc',
  };
}

/** The `smart.create` input: the command schema has no `version` key. */
export function ruleForCommand(rule) {
  const rest = { ...validateSmart(rule) };
  delete rest.version;
  return rest;
}

/** Distinct values of a text field, most common first, for input suggestions. */
export function suggestionsFor(tracks, field, max = 400) {
  if (!['artist', 'albumArtist', 'album', 'genre'].includes(field)) return [];
  const counts = new Map();
  for (const track of tracks) {
    const value = track[field];
    if (typeof value === 'string' && value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, max).map(([value]) => value);
}

// ------------------------------------------------------------------- DOM ----

const CSS = `
.ns{display:flex;flex-direction:column;gap:12px;width:100%;max-width:760px;margin:auto;min-width:0;color:var(--ink,var(--text))}
.ns h2{margin:0;font:600 18px var(--display,var(--body));letter-spacing:-.02em}
.ns label{display:flex;flex-direction:column;gap:4px;font:10px var(--mono);color:var(--faint,var(--muted));letter-spacing:.04em;min-width:0}
.ns input,.ns select{min-height:36px;padding:6px 10px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink,var(--text));font:13px var(--body);max-width:100%;min-width:0}
.ns button{font:inherit;color:inherit}
.ns-btn{min-height:36px;padding:6px 12px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);cursor:pointer;font:11px var(--mono)!important;white-space:nowrap}
.ns-btn:hover{border-color:var(--accent)}
.ns-btn[disabled]{opacity:.45;cursor:default}
.ns-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,var(--bg));font-weight:700}
.ns-line{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.ns-line>label{flex:1 1 150px}
.ns-rules{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.ns-rule{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2)}
.ns-rule[aria-invalid=true]{border-color:var(--refuse,var(--accent))}
.ns-rule select,.ns-rule input{flex:1 1 120px}
.ns-rule .ns-unit{font:11px var(--mono);color:var(--muted)}
.ns-rule .ns-x{flex:none;width:32px;padding:0}
.ns-count{font:12px var(--mono);color:var(--muted);margin:0}
.ns-error{color:var(--refuse,var(--accent));font-size:12px;margin:0}
.ns-error:empty{display:none}
.ns-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
`;

let instance = 0;

const isAbsent = value => value === null || value === undefined || value === false;

function setAttr(node, name, value) {
  if (name === 'class') node.className = value;
  else if (name === 'text') node.textContent = value;
  else if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
  else node.setAttribute(name, value === true ? '' : String(value));
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (!isAbsent(value)) setAttr(node, name, value);
  }
  for (const child of children.flat()) if (!isAbsent(child)) node.append(child);
  return node;
}

function injectCss(id, css) {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  document.head.append(el('style', { id, text: css }));
}

const errorText = error => String(error?.message ?? error ?? 'Something went wrong.');

/**
 * Mount the smart playlist editor.
 * `update({ rule })` loads an existing rule (or `{ rule: null }` for a new one).
 * Returns `{ update(state), destroy(), currentRule() }`.
 */
export function mountSmartEditor(root, ctx) {
  injectCss('nakliamp-css-smart-editor', CSS);
  const uid = `ns${++instance}`;
  let form = ruleToForm(null);
  let editingName = null;
  let previewTimer = 0;
  let lastValid = null;
  const cleanups = [];

  const nameInput = el('input', { type: 'text', id: `${uid}-name`, maxlength: '120', required: true, autocomplete: 'off' });
  const matchSelect = el('select', { id: `${uid}-match` },
    el('option', { value: 'all', text: 'all of the rules' }), el('option', { value: 'any', text: 'any of the rules' }));
  const rulesList = el('ul', { class: 'ns-rules', 'aria-label': 'Rules' });
  const addButton = el('button', { type: 'button', class: 'ns-btn' }, 'Add rule');
  const limitInput = el('input', { type: 'number', min: '1', max: String(MAX_LIMIT), step: '1', inputmode: 'numeric', placeholder: 'No limit', id: `${uid}-limit` });
  const sortSelect = el('select', { id: `${uid}-sort` }, el('option', { value: '', text: 'Library order' }),
    SORT_KEYS.map(key => el('option', { value: key, text: SORT_LABELS[key] ?? key })));
  const directionSelect = el('select', { id: `${uid}-dir` },
    el('option', { value: 'asc', text: 'Ascending' }), el('option', { value: 'desc', text: 'Descending' }));
  const count = el('p', { class: 'ns-count', role: 'status', 'aria-live': 'polite' });
  const error = el('p', { class: 'ns-error', role: 'alert' });
  const exportButton = el('button', { type: 'button', class: 'ns-btn' }, 'Export as M3U8');
  const cancelButton = el('button', { type: 'button', class: 'ns-btn' }, 'Cancel');
  const saveButton = el('button', { type: 'submit', class: 'ns-btn primary' }, 'Save');
  const heading = el('h2', { id: `${uid}-heading`, text: 'New smart playlist' });
  const datalists = el('div', { hidden: true });

  const formEl = el('form', { class: 'ns', 'aria-labelledby': `${uid}-heading`, novalidate: true },
    heading,
    el('div', { class: 'ns-line' },
      el('label', { for: `${uid}-name` }, 'Name', nameInput),
      el('label', { for: `${uid}-match` }, 'Match', matchSelect)),
    rulesList,
    el('div', {}, addButton),
    el('div', { class: 'ns-line' },
      el('label', { for: `${uid}-limit` }, 'Limit (tracks)', limitInput),
      el('label', { for: `${uid}-sort` }, 'Sort by', sortSelect),
      el('label', { for: `${uid}-dir` }, 'Direction', directionSelect)),
    count, error,
    el('div', { class: 'ns-actions' }, exportButton, cancelButton, saveButton),
    datalists);
  root.replaceChildren(formEl);

  const tracks = () => { try { return ctx.library?.tracks?.() ?? []; } catch { return []; } };

  function buildDatalists() {
    const all = tracks();
    datalists.replaceChildren(...['artist', 'albumArtist', 'album', 'genre'].map(field =>
      el('datalist', { id: `${uid}-list-${field}` }, suggestionsFor(all, field).map(value => el('option', { value })))));
  }

  function valueInputs(row, index) {
    const kind = kindOf(row.field);
    const label = which => `Rule ${index + 1} ${which}`;
    const onValue = key => event => { form.rows[index][key] = event.target.value; schedulePreview(); };
    if (kind === 'boolean') {
      const select = el('select', { 'aria-label': label('value'), onchange: onValue('a') },
        el('option', { value: 'true', text: 'yes' }), el('option', { value: 'false', text: 'no' }));
      select.value = row.a === 'false' ? 'false' : 'true';
      return [select];
    }
    if (kind === 'rating') return ratingInputs(row, index, label, onValue);
    if (kind === 'date' && (row.op === 'in-last-days' || row.op === 'not-in-last-days')) {
      return [el('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', value: row.a, 'aria-label': label('number of days'), oninput: onValue('a') }),
        el('span', { class: 'ns-unit', text: 'days' })];
    }
    return typedInputs(row, kind, label, onValue);
  }

  function ratingInputs(row, index, label, onValue) {
    const make = (key, which) => {
      const select = el('select', { 'aria-label': label(which), onchange: onValue(key) },
        [0, 1, 2, 3, 4, 5].map(stars => el('option', { value: String(stars), text: stars ? `${stars} star${stars === 1 ? '' : 's'}` : 'no rating' })));
      select.value = row[key] || '0';
      if (!row[key]) form.rows[index][key] = '0';
      return select;
    };
    return row.op === 'between' ? [make('a', 'lowest value'), el('span', { class: 'ns-unit', text: 'and' }), make('b', 'highest value')] : [make('a', 'value')];
  }

  function inputExtra(row, kind) {
    if (kind === 'text') return { list: ['artist', 'albumArtist', 'album', 'genre'].includes(row.field) ? `${uid}-list-${row.field}` : null, autocomplete: 'off' };
    return kind === 'date' ? {} : { step: 'any', inputmode: 'decimal' };
  }

  function typedInputs(row, kind, label, onValue) {
    const type = kind === 'date' ? 'date' : kind === 'text' ? 'text' : 'number';
    const extra = inputExtra(row, kind);
    const make = (key, which) => el('input', { type, value: row[key], 'aria-label': label(which), oninput: onValue(key), ...extra });
    if (row.op === 'between') return [make('a', 'lowest value'), el('span', { class: 'ns-unit', text: 'and' }), make('b', 'highest value')];
    return [make('a', 'value')];
  }

  function renderRules(focusIndex = -1) {
    const items = form.rows.map((row, index) => {
      const fieldSelect = el('select', { 'aria-label': `Rule ${index + 1} field` },
        Object.entries(FIELD_SPECS).map(([field, spec]) => el('option', { value: field, text: spec.label })));
      fieldSelect.value = row.field;
      fieldSelect.addEventListener('change', () => {
        form.rows[index] = normaliseRow({ ...row, field: fieldSelect.value, previousField: row.field });
        renderRules(index);
        schedulePreview();
      });
      const opSelect = el('select', { 'aria-label': `Rule ${index + 1} operator` },
        opsFor(row.field).map(op => el('option', { value: op, text: opLabel(row.field, op) })));
      opSelect.value = row.op;
      opSelect.addEventListener('change', () => {
        const wasBetween = row.op === 'between';
        form.rows[index] = { ...row, op: opSelect.value };
        const kind = kindOf(row.field);
        const dayOps = ['in-last-days', 'not-in-last-days'];
        if (kind === 'date' && dayOps.includes(row.op) !== dayOps.includes(opSelect.value)) {
          form.rows[index].a = dayOps.includes(opSelect.value) ? '30' : '';
          form.rows[index].b = '';
        }
        if (wasBetween && opSelect.value !== 'between') form.rows[index].b = '';
        renderRules(index);
        schedulePreview();
      });
      const remove = el('button', { type: 'button', class: 'ns-btn ns-x', 'aria-label': `Remove rule ${index + 1}` }, '×');
      remove.addEventListener('click', () => {
        form.rows.splice(index, 1);
        renderRules(Math.min(index, form.rows.length - 1));
        if (!form.rows.length) addButton.focus();
        schedulePreview();
      });
      return el('li', { class: 'ns-rule', 'data-row': String(index) }, fieldSelect, opSelect, ...valueInputs(form.rows[index], index), remove);
    });
    rulesList.replaceChildren(...items);
    if (!items.length) rulesList.append(el('li', { class: 'ns-count', text: 'No rules: every track matches when the playlist matches all rules.' }));
    if (focusIndex >= 0) rulesList.querySelector(`[data-row="${focusIndex}"] select`)?.focus();
  }

  function paintForm() {
    nameInput.value = form.name;
    matchSelect.value = form.match;
    limitInput.value = form.limit;
    sortSelect.value = form.sortKey;
    directionSelect.value = form.sortDirection;
    directionSelect.disabled = !form.sortKey;
    heading.textContent = editingName ? `Edit smart playlist: ${editingName}` : 'New smart playlist';
    renderRules();
    preview();
  }

  function readForm() {
    form.name = nameInput.value;
    form.match = matchSelect.value;
    form.limit = limitInput.value;
    form.sortKey = sortSelect.value;
    form.sortDirection = directionSelect.value;
    directionSelect.disabled = !form.sortKey;
  }

  function markRow(rowIndex) {
    for (const node of rulesList.querySelectorAll('.ns-rule')) {
      node.setAttribute('aria-invalid', String(Number(node.dataset.row) === rowIndex));
    }
  }

  /** Validate and count. A form with no name still previews its count. */
  function preview() {
    previewTimer = 0;
    readForm();
    lastValid = null;
    try {
      const rule = formToRule({ ...form, name: form.name.trim() || 'Preview' });
      const matches = evaluateSmart(rule, tracks());
      lastValid = { rule, matches };
      count.textContent = `${matches.length.toLocaleString()} track${matches.length === 1 ? '' : 's'} match${matches.length === 1 ? 'es' : ''} now.`;
      error.textContent = '';
      markRow(-1);
    } catch (problem) {
      count.textContent = '';
      error.textContent = errorText(problem);
      markRow(problemRow(problem));
    }
    exportButton.disabled = !lastValid || !lastValid.matches.length;
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, 120);
  }

  formEl.addEventListener('input', event => { if (!event.target.closest('.ns-rule')) schedulePreview(); });
  formEl.addEventListener('change', event => { if (!event.target.closest('.ns-rule')) schedulePreview(); });
  formEl.addEventListener('keydown', event => {
    // Typing in the editor must never reach the player's single-key shortcuts.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); ctx.close?.(); return; }
    event.stopPropagation();
  });
  addButton.addEventListener('click', () => {
    form.rows.push(blankRow('genre'));
    renderRules(form.rows.length - 1);
    schedulePreview();
  });
  cancelButton.addEventListener('click', () => ctx.close?.());

  formEl.addEventListener('submit', async event => {
    event.preventDefault();
    clearTimeout(previewTimer);
    readForm();
    let rule;
    try {
      rule = formToRule(form);
    } catch (problem) {
      error.textContent = errorText(problem);
      const at = problemRow(problem);
      (at >= 0 ? rulesList.querySelector(`[data-row="${at}"] input, [data-row="${at}"] select`) : nameInput)?.focus();
      return;
    }
    saveButton.disabled = true;
    try {
      await ctx.run('smart.create', { rule: ruleForCommand(rule) });
      ctx.toast?.(`Saved smart playlist ${rule.name}`);
      ctx.close?.();
    } catch (problem) {
      error.textContent = errorText(problem);
    } finally {
      saveButton.disabled = false;
    }
  });

  exportButton.addEventListener('click', async () => {
    preview();
    if (!lastValid?.matches.length) return;
    const name = form.name.trim() || 'Smart playlist';
    exportButton.disabled = true;
    try {
      await ctx.run('playlist.create', { name, ids: lastValid.matches.map(track => track.id) });
      ctx.toast?.(`Exported ${lastValid.matches.length} tracks to the playlist ${name}`);
    } catch (problem) {
      error.textContent = errorText(problem);
    } finally {
      exportButton.disabled = !lastValid?.matches.length;
    }
  });

  const offLibrary = ctx.library?.onChange?.(() => { buildDatalists(); schedulePreview(); });
  if (typeof offLibrary === 'function') cleanups.push(offLibrary);

  buildDatalists();
  paintForm();

  return {
    update(state = {}) {
      if (!('rule' in state)) { schedulePreview(); return; }
      try {
        form = ruleToForm(state.rule ?? null);
        editingName = state.rule ? form.name : null;
        error.textContent = '';
      } catch (problem) {
        form = ruleToForm(null);
        editingName = null;
        error.textContent = `This smart playlist could not be read: ${errorText(problem)}`;
      }
      buildDatalists();
      paintForm();
      nameInput.focus();
    },
    destroy() {
      clearTimeout(previewTimer);
      for (const fn of cleanups) { try { fn(); } catch { /* already gone */ } }
      root.replaceChildren();
    },
    currentRule() {
      readForm();
      return formToRule(form);
    },
  };
}
