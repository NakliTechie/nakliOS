// v1x-library-tools.mjs — duplicates (L14), batch rename and find and replace (T5),
// and the folder list (L13).
//
// NakliAmp never deletes a music file. "Keep one" in the duplicates view hides the
// other copies from the library view only (ctx.library.hide), and the files stay on
// disk. Renames and tag rewrites are destructive, so they go through the commands
// `tags.rename_files`, `tags.find_replace` and `track.edit_tags`, whose runner shows the
// change and waits for approval. When a build has no handler for one of them, the
// panel shows the same change in confirmCommand and applies it itself.
//
// Also exports the small helpers the other v1.x panels share: runOr, writeTagPatches,
// plainError and the base CSS.

import { findDuplicates } from '../library/duplicates.mjs';
import {
  RENAME_TOKENS, REPLACE_FIELDS, planRename, planFindReplace, canRenameOnDisk, renameOnDisk,
} from '../library/rename.mjs';
import { inFolder } from '../library/folders.mjs';
import { saveTagsToHandle } from '../tags/save.mjs';
import { h, injectCss, nextId, confirmCommand } from './dialog.mjs';

// ------------------------------------------------------- shared helpers ----

/** An error's message without the "[code] " prefix the headless modules add. */
export function plainError(error) {
  return String(error?.message ?? error ?? 'Something went wrong.').replace(/^\[[a-z-]+\] /i, '');
}

const hasCode = (error, code) => error?.code === code || String(error?.message ?? '').startsWith(`[${code}]`);
const isNotFound = error => hasCode(error, 'not-found');
/** True when the person declined a destructive command's confirm step. */
export const isDeclined = error => hasCode(error, 'declined');

/**
 * Run a command; when the build has no handler for it (`[not-found]`), run
 * `fallback()` instead. With no runner at all, the fallback runs directly.
 */
export async function runOr(ctx, name, input, fallback) {
  if (typeof ctx?.run !== 'function') {
    if (fallback) return fallback();
    throw Object.assign(new Error(`[not-found] ${name} is not available in this build.`), { code: 'not-found' });
  }
  try {
    return await ctx.run(name, input);
  } catch (error) {
    if (fallback && isNotFound(error)) return fallback();
    throw error;
  }
}

/**
 * Write tag patches `[{ ids, patch }]`. Uses the shell's batch writer
 * (ctx.editTags, one approval for the lot) when present, else one
 * `track.edit_tags` command per item, each approved on its own. A `picture`
 * in a patch is dropped on the command path (the command has no such field);
 * an item's `coverFrom` (a MusicBrainz release id) is passed through instead.
 * Returns `{ written, refused, failed: [{ ids, error }] }` (counted in items).
 */
export async function writeTagPatches(ctx, items, { title = 'Write tags' } = {}) {
  const list = (items ?? []).filter(hasChange);
  if (!list.length) return { written: 0, refused: 0, failed: [] };
  if (typeof ctx?.editTags === 'function') return batchResult(await ctx.editTags(list, { title }), list.length);
  const out = { written: 0, refused: 0, failed: [] };
  for (const item of list) await editOne(ctx, item, out);
  return out;
}

const hasChange = item => Boolean(item?.ids?.length && item.patch && (Object.keys(item.patch).length || item.coverFrom));

const batchResult = (result, count) => ({
  written: Number(result?.written ?? count), refused: Number(result?.refused ?? 0), failed: result?.failed ?? [],
});

// The command input for one item: the patch without `picture`, plus `coverFrom`.
function editInput(item) {
  const { picture: _picture, ...patch } = item.patch;
  const input = { ids: item.ids.map(String), patch };
  if (item.coverFrom) input.coverFrom = item.coverFrom;
  return input;
}

const wasRefused = result => result === false || Boolean(result?.cancelled) || result?.approved === false;

async function editOne(ctx, item, out) {
  const input = editInput(item);
  if (!Object.keys(input.patch).length && !input.coverFrom) return;
  try {
    if (wasRefused(await ctx.run('track.edit_tags', input))) out.refused += 1;
    else out.written += 1;
  } catch (error) {
    if (isDeclined(error)) out.refused += 1;
    else out.failed.push({ ids: item.ids, error: plainError(error) });
  }
}

/** "3 files written", "1 refused", "2 failed", joined. */
export function writeSummary(result, noun = 'file') {
  const parts = [];
  if (result.written) parts.push(`${result.written} ${noun}${result.written === 1 ? '' : 's'} written`);
  if (result.refused) parts.push(`${result.refused} not approved`);
  if (result.failed?.length) parts.push(`${result.failed.length} failed: ${String(result.failed[0].error).replace(/\.$/, '')}`);
  return parts.length ? `${parts.join(', ')}.` : 'Nothing was written.';
}

const trackName = track => track?.title || String(track?.path ?? '').split('/').pop() || 'Untitled';

export const BASE_CSS = `
.nk-v1x,.nk-v1x *{box-sizing:border-box}
.nk-v1x{--c-ink:var(--ink,var(--text));color:var(--c-ink);display:grid;gap:14px;min-width:0;overflow-wrap:anywhere}
.nk-v1x section{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--panel-2);min-width:0;display:grid;gap:8px}
.nk-v1x h3{margin:0;font-size:14px}
.nk-v1x h4{margin:4px 0 0;font-size:13px}
.nk-v1x p{margin:0;line-height:1.5}
.nk-v1x .hint{color:var(--muted);font-size:12px}
.nk-v1x .err{color:var(--refuse,#c0392b)}
.nk-v1x .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.nk-v1x .f{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 160px}
.nk-v1x label{font-size:12px;color:var(--muted)}
.nk-v1x label.switch{display:inline-flex;align-items:center;gap:6px;font-size:inherit;color:var(--c-ink);cursor:pointer}
.nk-v1x input[type=text],.nk-v1x input[type=password],.nk-v1x input[type=number],.nk-v1x select{min-height:36px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--c-ink);font:inherit;min-width:0;max-width:100%;width:100%}
.nk-v1x input[type=checkbox],.nk-v1x input[type=radio]{accent-color:var(--accent);width:18px;height:18px;margin:0;flex:none}
.nk-v1x .btn{min-height:36px;padding:6px 12px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--c-ink);cursor:pointer;font:inherit}
.nk-v1x .btn:hover{border-color:var(--accent)}
.nk-v1x .btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,#1a1206);font-weight:700}
.nk-v1x .btn.danger{border-color:var(--refuse,#c0392b);color:var(--refuse,#c0392b)}
.nk-v1x .btn[disabled]{opacity:.5;cursor:not-allowed}
.nk-v1x .list{margin:0;padding:0;list-style:none;display:grid;gap:6px;max-height:min(50vh,460px);overflow:auto}
.nk-v1x .item{display:grid;gap:4px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--panel);min-width:0}
.nk-v1x .item small{color:var(--muted);display:block}
.nk-v1x .pair{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:6px;align-items:start;font-size:13px}
.nk-v1x .pair .to{font-weight:650}
.nk-v1x .tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted)}
.nk-v1x .tag.warn{border-color:var(--warn,var(--accent));color:var(--warn,var(--accent))}
.nk-v1x .mono{font-family:var(--mono,ui-monospace,monospace);font-size:12px}
.nk-v1x :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media(max-width:480px){.nk-v1x .pair{grid-template-columns:minmax(0,1fr)}.nk-v1x .pair .arrow{display:none}}
`;

export function injectBaseCss() { injectCss('v1x-base', BASE_CSS); }

// ------------------------------------------------------- duplicates: pure ----

const KIND_LABELS = { exact: 'Exact copy', likely: 'Likely the same recording' };

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '') return '';
  const s = Math.round(Number(seconds));
  if (!Number.isFinite(s) || s < 0) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const folderOf = path => String(path ?? '').split('/').slice(0, -1).join('/') || '(top folder)';

/** Fields the compare view shows, in order, as [label, value-of-track]. */
const COMPARE_FIELDS = [
  ['Title', t => t.title ?? ''],
  ['Artist', t => t.artist ?? ''],
  ['Album', t => t.album ?? ''],
  ['Year', t => (Number.isFinite(t.year) ? String(t.year) : '')],
  ['Length', t => formatDuration(t.durationS)],
  ['Size', t => formatSize(t.size)],
  ['Format', t => [t.codec, t.bitrate ? `${Math.round(t.bitrate / 1000)} kbps` : null, t.sampleRate ? `${t.sampleRate / 1000} kHz` : null].filter(Boolean).join(', ')],
  ['Plays', t => String(t.playCount ?? 0)],
  ['Stars', t => String(t.rating ?? 0)],
  ['Folder', t => folderOf(t.path)],
  ['File', t => String(t.path ?? '').split('/').pop()],
];

/**
 * The compare table for a group: `[{ field, values: [...], differs }]`, one
 * value per track in the order given.
 */
export function compareRows(tracks) {
  return COMPARE_FIELDS.map(([field, read]) => {
    const values = tracks.map(t => read(t ?? {}));
    return { field, values, differs: new Set(values).size > 1 };
  });
}

/** Groups with their tracks, skipping ids the library no longer has and groups that fall below two. */
export function duplicateRows(groups, getTrack, { hiddenIds = new Set() } = {}) {
  const rows = [];
  for (const group of groups ?? []) {
    const tracks = group.ids.map(id => getTrack(id)).filter(t => t && !hiddenIds.has(t.id));
    if (tracks.length < 2) continue;
    const keepId = tracks.some(t => t.id === group.keepId) ? group.keepId : tracks[0].id;
    const lead = tracks.find(t => t.id === keepId) ?? tracks[0];
    rows.push({
      kind: group.kind, key: group.key, keepId, tracks,
      heading: `${KIND_LABELS[group.kind] ?? group.kind}: ${trackName(lead)}${lead.artist ? ` by ${lead.artist}` : ''} (${tracks.length} files)`,
    });
  }
  return rows;
}

// --------------------------------------------------------- duplicates: UI ----

const DUP_CSS = `
.nk-dup .cmp{display:grid;gap:2px;font-size:12px}
.nk-dup .cmp div{display:grid;grid-template-columns:70px repeat(var(--n),minmax(0,1fr));gap:6px}
.nk-dup .cmp .d{color:var(--accent)}
.nk-dup .member{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center}
@media(max-width:480px){.nk-dup .cmp div{grid-template-columns:minmax(0,1fr)}.nk-dup .cmp div > :first-child{font-weight:650}}
`;

export function mountDuplicates(root, ctx) {
  injectBaseCss();
  injectCss('v1x-duplicates', DUP_CSS);
  const id = nextId('dup');
  const hiddenHere = new Set();
  let kind = 'all';

  const kindSelect = h('select', { id: `${id}-kind` },
    [['all', 'All groups'], ['exact', 'Exact copies'], ['likely', 'Likely the same recording']].map(([value, text]) => h('option', { value, textContent: text })));
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const list = h('ul', { className: 'list', 'aria-label': 'Duplicate groups' });
  const container = h('div', { className: 'nk-v1x nk-dup' },
    h('section', {},
      h('div', { className: 'row' }, h('div', { className: 'f' }, h('label', { htmlFor: `${id}-kind`, textContent: 'Show' }), kindSelect)),
      h('p', { className: 'hint', textContent: 'NakliAmp never deletes files. Keeping one copy hides the others from the library view; they stay on disk.' }),
      status, list));
  root.append(container);

  kindSelect.addEventListener('change', () => { kind = kindSelect.value; render(); });

  function groups() {
    const tracks = ctx.library?.tracks?.() ?? [];
    const all = findDuplicates(tracks);
    return duplicateRows(kind === 'all' ? all : all.filter(g => g.kind === kind), tid => ctx.library?.getTrack?.(tid) ?? null, { hiddenIds: hiddenHere });
  }

  async function keep(group, keepId) {
    const hide = group.tracks.map(t => t.id).filter(tid => tid !== keepId);
    try {
      if (typeof ctx.library?.hide === 'function') await ctx.library.hide(hide);
      for (const tid of hide) hiddenHere.add(tid);
      ctx.toast?.(typeof ctx.library?.hide === 'function'
        ? `Hid ${hide.length} copy${hide.length === 1 ? '' : ' copies'} from the library view. The files are still on disk.`
        : `Hid ${hide.length} from this list only; this build cannot hide tracks from the library view yet.`);
    } catch (error) { ctx.toast?.(plainError(error)); }
    render();
  }

  function renderGroup(group, index) {
    let keepId = group.keepId;
    const name = `${id}-g${index}`;
    const members = group.tracks.map(track => {
      const radio = h('input', { type: 'radio', name, value: track.id, checked: track.id === keepId, 'aria-label': `Keep ${trackName(track)}, ${folderOf(track.path)}` });
      radio.addEventListener('change', () => { if (radio.checked) keepId = track.id; });
      const play = h('button', { type: 'button', className: 'btn', textContent: 'Play', 'aria-label': `Play ${trackName(track)} from ${folderOf(track.path)}`, onclick: () => ctx.playTracks?.([track.id], 0) });
      return h('div', { className: 'member' }, radio,
        h('div', {}, trackName(track), h('small', { textContent: [formatSize(track.size), formatDuration(track.durationS), folderOf(track.path)].filter(Boolean).join(' · ') })),
        play);
    });
    const cmp = h('div', { className: 'cmp', hidden: true, style: `--n:${group.tracks.length}` },
      compareRows(group.tracks).map(row => h('div', { className: row.differs ? 'd' : '' }, h('span', { textContent: row.field }), row.values.map(v => h('span', { textContent: v || '-' })))));
    const compare = h('button', { type: 'button', className: 'btn', textContent: 'Compare', 'aria-expanded': 'false' });
    compare.addEventListener('click', () => {
      cmp.hidden = !cmp.hidden;
      compare.setAttribute('aria-expanded', String(!cmp.hidden));
    });
    const keepButton = h('button', { type: 'button', className: 'btn primary', textContent: 'Keep the chosen copy', onclick: () => keep(group, keepId) });
    return h('li', { className: 'item' },
      h('h4', { textContent: group.heading }),
      h('div', { role: 'radiogroup', 'aria-label': `Copy to keep for ${group.heading}` }, members),
      h('div', { className: 'row' }, compare, keepButton),
      cmp);
  }

  function render() {
    const rows = groups();
    list.replaceChildren(...rows.map(renderGroup));
    status.textContent = rows.length
      ? `${rows.length} group${rows.length === 1 ? '' : 's'} found. The suggested copy to keep is the one you play most, then the larger file.`
      : 'No duplicates found.';
  }

  const off = ctx.library?.onChange?.(() => render());
  render();
  return {
    update() { render(); },
    destroy() { if (typeof off === 'function') off(); container.remove(); },
  };
}

// ---------------------------------------------------------- rename: pure ----

export const RENAME_PRESETS = Object.freeze([
  '%track% - %title%',
  '%artist% - %title%',
  '%track% %artist% - %title%',
  '%disc%-%track% %title%',
]);

const STATUS_WORDS = {
  rename: 'renamed', same: 'already named so', empty: 'no tags for the pattern', virtual: 'part of a cue sheet', conflict: 'name clash',
};

/** Plan a rename and count each status. Returns `{ rows, counts, error }`. */
export function renamePreview(records, pattern) {
  try {
    const rows = planRename(records, pattern);
    const counts = { rename: 0, same: 0, empty: 0, virtual: 0, conflict: 0 };
    for (const row of rows) counts[row.status] += 1;
    return { rows, counts, error: null };
  } catch (error) {
    return { rows: [], counts: null, error: plainError(error) };
  }
}

/** "4 to rename, 1 name clash." */
export function renameSummary(counts) {
  if (!counts) return '';
  const parts = [];
  if (counts.rename) parts.push(`${counts.rename} to rename`);
  for (const key of ['same', 'empty', 'virtual', 'conflict']) if (counts[key]) parts.push(`${counts[key]} ${STATUS_WORDS[key]}`);
  return parts.length ? `${parts.join(', ')}.` : 'Nothing selected.';
}

export const statusWord = status => STATUS_WORDS[status] ?? status;

/** Insert `%token%` into `value` at the selection, returning `{ value, caret }`. */
export function insertToken(value, start, end, token) {
  const text = String(value ?? '');
  const a = Number.isInteger(start) ? start : text.length;
  const b = Number.isInteger(end) ? end : a;
  const piece = `%${token}%`;
  return { value: text.slice(0, a) + piece + text.slice(b), caret: a + piece.length };
}

export const FIELD_LABELS = Object.freeze({ title: 'Title', artist: 'Artist', album: 'Album', albumArtist: 'Album artist', genre: 'Genre' });

/**
 * Plan find and replace and flatten it for the preview:
 * `{ plans, rows: [{ id, name, field, before, after }], error }`.
 */
export function replacePreview(records, options) {
  if (!options?.find) return { plans: [], rows: [], error: null };
  try {
    const plans = planFindReplace(records, options);
    const byId = new Map(records.map(r => [r.id, r]));
    const rows = plans.flatMap(plan => Object.keys(plan.patch).map(field => ({
      id: plan.id, name: trackName(byId.get(plan.id)), field: FIELD_LABELS[field] ?? field, before: plan.before[field], after: plan.patch[field] ?? '',
    })));
    return { plans, rows, error: null };
  } catch (error) {
    return { plans: [], rows: [], error: plainError(error) };
  }
}

/** The confirm diff for a find and replace, in the shape confirmCommand reads. */
export function replaceDiff(rows) {
  return {
    title: `Change tags in ${new Set(rows.map(r => r.id)).size} files?`,
    approveLabel: 'Write tags',
    lines: rows.map(r => `${r.name}, ${r.field}: "${r.before}" to "${r.after || '(empty)'}"`),
  };
}

/** The confirm diff for a rename. */
export function renameDiff(rows) {
  const moving = rows.filter(r => r.status === 'rename');
  return {
    title: `Rename ${moving.length} file${moving.length === 1 ? '' : 's'}?`,
    approveLabel: 'Rename files',
    lines: moving.map(r => `${r.from} to ${r.to}`),
    notes: ['NakliAmp rescans the folder afterwards so the library follows the new names.'],
  };
}

// ------------------------------------------------------------ rename: UI ----

function previewPair(from, to, extra) {
  return h('li', { className: 'item' },
    h('div', { className: 'pair' }, h('span', { textContent: from }), h('span', { className: 'arrow', 'aria-hidden': 'true', textContent: 'to' }), h('span', { className: 'to', textContent: to })),
    extra ? h('small', { textContent: extra }) : null);
}

function renameSection(ctx, id, getRecords) {
  const pattern = h('input', { type: 'text', id: `${id}-pattern`, value: RENAME_PRESETS[0], autocomplete: 'off', spellcheck: 'false' });
  const presets = h('select', { id: `${id}-presets`, 'aria-label': 'Pattern presets' },
    h('option', { value: '', textContent: 'Presets' }), RENAME_PRESETS.map(p => h('option', { value: p, textContent: p })));
  const tokens = h('div', { className: 'row', role: 'group', 'aria-label': 'Insert a token into the pattern' },
    RENAME_TOKENS.map(token => h('button', { type: 'button', className: 'btn mono', textContent: `%${token}%`, 'aria-label': `Insert ${token} token`, onclick: () => {
      const next = insertToken(pattern.value, pattern.selectionStart, pattern.selectionEnd, token);
      pattern.value = next.value;
      pattern.focus();
      pattern.setSelectionRange?.(next.caret, next.caret);
      render();
    } })));
  const summary = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const support = h('p', { className: 'hint' });
  const list = h('ul', { className: 'list', 'aria-label': 'Rename preview' });
  const apply = h('button', { type: 'button', className: 'btn primary', textContent: 'Rename files' });
  let preview = { rows: [], counts: null, error: null };
  let supported = true;

  function render() {
    preview = renamePreview(getRecords(), pattern.value);
    summary.textContent = preview.error ?? renameSummary(preview.counts);
    summary.classList.toggle('err', Boolean(preview.error));
    list.replaceChildren(...preview.rows.slice(0, 200).map(row => previewPair(row.from, row.to, row.status === 'rename' ? null : statusWord(row.status))));
    apply.disabled = !supported || !preview.counts?.rename;
    apply.textContent = preview.counts?.rename ? `Rename ${preview.counts.rename} file${preview.counts.rename === 1 ? '' : 's'}` : 'Rename files';
  }

  async function checkSupport() {
    const first = getRecords().find(r => !r.virtual);
    let handle = null;
    try { handle = first ? await ctx.library?.handleFor?.(first) : null; } catch { handle = null; }
    supported = !handle || canRenameOnDisk(handle);
    support.textContent = supported ? 'Renaming keeps each file in its folder and keeps its extension.' : 'This browser cannot rename files. Renaming needs a Chromium browser, such as Chrome or Edge.';
    support.classList.toggle('err', !supported);
    render();
  }

  // The folder handle lets renameOnDisk check the new name is free; without it, it refuses (N37).
  async function renameOne(row) {
    const track = ctx.library?.getTrack?.(row.id);
    const parent = await ctx.library?.parentFor?.(track);
    await renameOnDisk(await ctx.library.handleFor(track), row.to, { parent });
  }

  async function renameDirect(rows) {
    if (!(await confirmCommand({ label: 'Rename files', diff: renameDiff(rows) }))) return;
    let done = 0;
    for (const row of rows.filter(r => r.status === 'rename')) {
      try { await renameOne(row); done += 1; } catch (error) { ctx.toast?.(plainError(error)); break; }
    }
    if (done) await ctx.library?.rescan?.();
    ctx.toast?.(`${done} file${done === 1 ? '' : 's'} renamed.`);
  }

  apply.addEventListener('click', async () => {
    const rows = preview.rows;
    const ids = rows.filter(r => r.status === 'rename').map(r => String(r.id));
    try {
      await runOr(ctx, 'tags.rename_files', { ids, pattern: pattern.value }, () => renameDirect(rows));
    } catch (error) { ctx.toast?.(plainError(error)); }
    render();
  });
  pattern.addEventListener('input', render);
  presets.addEventListener('change', () => { if (presets.value) { pattern.value = presets.value; presets.value = ''; render(); } });

  const section = h('section', { 'aria-labelledby': `${id}-rn-h` },
    h('h3', { id: `${id}-rn-h`, textContent: 'Rename files from tags' }),
    h('div', { className: 'row' },
      h('div', { className: 'f' }, h('label', { htmlFor: `${id}-pattern`, textContent: 'Pattern' }), pattern),
      presets),
    tokens, support, summary, list, h('div', { className: 'row' }, apply));
  return { section, render, checkSupport };
}

function replaceSection(ctx, id, getRecords) {
  const find = h('input', { type: 'text', id: `${id}-find`, autocomplete: 'off', spellcheck: 'false' });
  const replace = h('input', { type: 'text', id: `${id}-replace`, autocomplete: 'off', spellcheck: 'false' });
  const fieldBoxes = REPLACE_FIELDS.map(field => {
    const box = h('input', { type: 'checkbox', checked: true, id: `${id}-fld-${field}` });
    return { field, box, label: h('label', { className: 'switch', htmlFor: `${id}-fld-${field}` }, box, FIELD_LABELS[field]) };
  });
  const regex = h('input', { type: 'checkbox', id: `${id}-regex` });
  const caseSensitive = h('input', { type: 'checkbox', id: `${id}-case` });
  const summary = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const list = h('ul', { className: 'list', 'aria-label': 'Find and replace preview' });
  const apply = h('button', { type: 'button', className: 'btn primary', textContent: 'Write tags', disabled: true });
  let preview = { plans: [], rows: [], error: null };

  const options = () => ({
    find: find.value, replace: replace.value, regex: regex.checked, caseSensitive: caseSensitive.checked,
    fields: fieldBoxes.filter(f => f.box.checked).map(f => f.field),
  });

  function render() {
    preview = replacePreview(getRecords(), options());
    const files = preview.plans.length;
    summary.textContent = preview.error ?? (find.value ? `${preview.rows.length} change${preview.rows.length === 1 ? '' : 's'} in ${files} file${files === 1 ? '' : 's'}.` : 'Type the text to find.');
    summary.classList.toggle('err', Boolean(preview.error));
    list.replaceChildren(...preview.rows.slice(0, 300).map(row => previewPair(row.before, row.after || '(empty)', `${row.name}, ${row.field}`)));
    apply.disabled = !files;
    apply.textContent = files ? `Write tags to ${files} file${files === 1 ? '' : 's'}` : 'Write tags';
  }

  async function replaceDirect() {
    if (typeof ctx.editTags === 'function') return writeTagPatches(ctx, preview.plans.map(p => ({ ids: [p.id], patch: p.patch })), { title: 'Find and replace' });
    if (!(await confirmCommand({ label: 'Write tags', diff: replaceDiff(preview.rows) }))) return { written: 0, refused: 1, failed: [] };
    const out = { written: 0, refused: 0, failed: [] };
    for (const plan of preview.plans) {
      try {
        const track = ctx.library?.getTrack?.(plan.id);
        await saveTagsToHandle(await ctx.library.handleFor(track), plan.patch);
        await ctx.library?.updateTrack?.(plan.id, plan.patch);
        out.written += 1;
      } catch (error) { out.failed.push({ ids: [plan.id], error: plainError(error) }); }
    }
    return out;
  }

  apply.addEventListener('click', async () => {
    const opts = options();
    const input = { ids: preview.plans.map(p => String(p.id)), find: opts.find, replace: opts.replace, fields: opts.fields, regex: opts.regex, caseSensitive: opts.caseSensitive };
    try {
      const result = await runOr(ctx, 'tags.find_replace', input, replaceDirect);
      if (result && typeof result === 'object' && 'written' in result) ctx.toast?.(writeSummary(result));
    } catch (error) { ctx.toast?.(plainError(error)); }
    render();
  });
  for (const el of [find, replace]) el.addEventListener('input', render);
  for (const el of [regex, caseSensitive, ...fieldBoxes.map(f => f.box)]) el.addEventListener('change', render);

  const section = h('section', { 'aria-labelledby': `${id}-fr-h` },
    h('h3', { id: `${id}-fr-h`, textContent: 'Find and replace in tags' }),
    h('div', { className: 'row' },
      h('div', { className: 'f' }, h('label', { htmlFor: `${id}-find`, textContent: 'Find' }), find),
      h('div', { className: 'f' }, h('label', { htmlFor: `${id}-replace`, textContent: 'Replace with' }), replace)),
    h('fieldset', { className: 'row', style: 'border:0;margin:0;padding:0' }, h('legend', { className: 'hint', textContent: 'In these tags' }), fieldBoxes.map(f => f.label)),
    h('div', { className: 'row' },
      h('label', { className: 'switch', htmlFor: `${id}-regex` }, regex, 'Regular expression ($1 inserts a group)'),
      h('label', { className: 'switch', htmlFor: `${id}-case` }, caseSensitive, 'Match case')),
    summary, list, h('div', { className: 'row' }, apply));
  return { section, render };
}

export function mountRename(root, ctx) {
  injectBaseCss();
  const id = nextId('rename');
  let ids = [];
  const getRecords = () => ids.map(tid => ctx.library?.getTrack?.(tid)).filter(Boolean);
  const scope = h('p', { className: 'hint' });
  const rename = renameSection(ctx, id, getRecords);
  const replace = replaceSection(ctx, id, getRecords);
  const container = h('div', { className: 'nk-v1x nk-rename' }, scope, rename.section, replace.section);
  root.append(container);

  function setIds(next) {
    ids = (next?.length ? next : (ctx.selectedIds?.() ?? [])).map(String);
    scope.textContent = ids.length
      ? `Working on ${ids.length} selected track${ids.length === 1 ? '' : 's'}. Nothing changes until you approve.`
      : 'Select tracks in the library first.';
    rename.render();
    replace.render();
    rename.checkSupport();
  }

  setIds(null);
  return {
    update(state) { if (state && Array.isArray(state.ids)) setIds(state.ids); else { rename.render(); replace.render(); } },
    destroy() { container.remove(); },
  };
}

// --------------------------------------------------------- folders: pure ----

const GRANT_WORDS = { granted: '', prompt: 'Needs permission again', denied: 'Permission refused' };

/** Folder rows from ctx.folders.list() (or the `library.folders` result) and the tracks. */
export function folderRows(folders, tracks) {
  const list = Array.isArray(folders) ? folders : (folders?.folders ?? []);
  return list.map((folder, index) => {
    const primary = folder.primary ?? index === 0;
    const count = (tracks ?? []).filter(t => !t.hidden && t.path && inFolder(t.path, primary ? null : folder.id)).length;
    return { id: String(folder.id), name: folder.name || 'Unnamed folder', primary: Boolean(primary), count, grantText: GRANT_WORDS[folder.grant] ?? '' };
  });
}

// ----------------------------------------------------------- folders: UI ----

export function mountFolders(root, ctx) {
  injectBaseCss();
  const id = nextId('folders');
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const list = h('ul', { className: 'list', 'aria-label': 'Music folders' });
  const add = h('button', { type: 'button', className: 'btn primary', textContent: 'Add folder' });
  const rescanAll = h('button', { type: 'button', className: 'btn', textContent: 'Rescan all' });
  const container = h('div', { className: 'nk-v1x nk-folders' },
    h('section', { 'aria-labelledby': `${id}-h` },
      h('h3', { id: `${id}-h`, textContent: 'Music folders' }),
      h('p', { className: 'hint', textContent: 'The first folder is the main one; smart playlists are read from it. Removing a folder only removes it from the library; its files stay on disk.' }),
      list, h('div', { className: 'row' }, add, rescanAll), status));
  root.append(container);
  let busy = false;

  async function loadFolders() {
    if (typeof ctx.folders?.list === 'function') return ctx.folders.list();
    return ctx.run('library.folders', {});
  }

  async function task(text, fn) {
    if (busy) return;
    busy = true;
    status.textContent = text;
    try { status.textContent = (await fn()) ?? ''; } catch (error) { status.textContent = plainError(error); }
    busy = false;
    render();
  }

  const rescan = row => task(`Rescanning ${row.name}…`, async () => {
    await ctx.run('library.rescan_folder', { id: row.id });
    return `Rescanned ${row.name}.`;
  });

  // library.forget_folder is destructive: the runner shows what leaves the library first.
  const forget = row => task(`Removing ${row.name} from the library…`, async () => {
    try { await ctx.run('library.forget_folder', { id: row.id }); } catch (error) {
      if (isDeclined(error)) return 'Nothing removed.';
      throw error;
    }
    return `Removed ${row.name} from the library. Its files are still on disk.`;
  });

  function renderRow(row) {
    return h('li', { className: 'item' },
      h('div', {}, h('strong', { textContent: row.name }), ' ', row.primary ? h('span', { className: 'tag', textContent: 'Main' }) : null,
        ' ', row.grantText ? h('span', { className: 'tag warn', textContent: row.grantText }) : null,
        h('small', { textContent: `${row.count} track${row.count === 1 ? '' : 's'}` })),
      h('div', { className: 'row' },
        h('button', { type: 'button', className: 'btn', textContent: 'Rescan', 'aria-label': `Rescan ${row.name}`, onclick: () => rescan(row) }),
        h('button', { type: 'button', className: 'btn danger', textContent: 'Remove from library', 'aria-label': `Remove ${row.name} from the library`, onclick: () => forget(row) })));
  }

  async function render() {
    let rows = [];
    try { rows = folderRows(await loadFolders(), ctx.library?.tracks?.() ?? []); } catch (error) { status.textContent = plainError(error); }
    list.replaceChildren(...rows.map(renderRow));
    if (!rows.length && !busy) status.textContent = 'No folder yet. Add one to build the library.';
    rescanAll.disabled = !rows.length;
  }

  add.addEventListener('click', () => task('Choose a folder…', async () => {
    const result = await ctx.run('library.add_folder', {});
    if (!result) return 'No folder added.';
    return result.added === false || result.duplicate ? 'That folder is already in the library.' : 'Folder added.';
  }));
  rescanAll.addEventListener('click', () => task('Rescanning every folder…', async () => {
    await ctx.run('library.rescan_folder', {});
    return 'Rescanned every folder.';
  }));

  const offFolders = ctx.folders?.onChange?.(() => { if (!busy) render(); });
  const off = ctx.library?.onChange?.(() => { if (!busy) render(); });
  render();
  return {
    update() { render(); },
    destroy() {
      for (const fn of [off, offFolders]) if (typeof fn === 'function') fn();
      container.remove();
    },
  };
}
