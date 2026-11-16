// tag-editor.mjs — tag editing for one track or many (T4).
//
// The editor runs as the destructive `track.edit_tags` command: Save calls
// ctx.run('track.edit_tags', { ids, patch }, { context: { picture, onProgress } }), and
// the command's confirm step (dialog.mjs confirmCommand) shows the diff this module's
// handler builds: describeTagChange per file, the ID3v2.2/2.3 to 2.4 note, and the
// files that will be skipped by name. The shell binds the handler from
// createEditTagsHandler(ctx) under 'track.edit_tags'.
//
// Writing: saveTagsToHandle per file when the folder gives a writable handle
// (Chromium), then ctx.library.updateTrack. Each write keeps the original in the
// backup folder, so a written row offers Undo and the "Tag backups" list restores
// any kept original by its track path. Elsewhere the result offers "Download
// edited copy" (writeTags on the File). Cover art is not in the command's JSON input
// (agents send no image bytes), so it travels in the run context.

import { planTagWrite, inspectTagFormat, writeTags } from '../tags/write.mjs';
import { saveTagsToHandle, restoreTagBackup, listTagBackups, deleteTagBackup } from '../tags/save.mjs';
import { describeTagChange, summariseTagChanges } from '../tags/diff.mjs';
import { h, injectCss, nextId } from './dialog.mjs';

export const MAX_PICTURE_BYTES = 8 * 1024 * 1024;
export const MULTIPLE = 'Multiple values';

export const FIELDS = Object.freeze([
  { key: 'title', label: 'Title', kind: 'text' },
  { key: 'artist', label: 'Artist', kind: 'text' },
  { key: 'album', label: 'Album', kind: 'text' },
  { key: 'albumArtist', label: 'Album artist', kind: 'text' },
  { key: 'trackNo', label: 'Track', kind: 'number', max: 9999 },
  { key: 'trackTotal', label: 'of', kind: 'number', max: 9999, describe: 'Track total' },
  { key: 'discNo', label: 'Disc', kind: 'number', max: 9999 },
  { key: 'discTotal', label: 'of', kind: 'number', max: 9999, describe: 'Disc total' },
  { key: 'year', label: 'Year', kind: 'number', max: 9999 },
  { key: 'genre', label: 'Genre', kind: 'text' },
  { key: 'rating', label: 'Rating', kind: 'rating', max: 5 },
]);

const FIELD_LABELS = Object.fromEntries(FIELDS.map(f => [f.key, f.describe ?? f.label]));

// ---------------------------------------------------------------- pure ----

function norm(field, value) {
  if (value === undefined || value === null) return null;
  if (field.kind === 'rating') return Number(value) > 0 ? Number(value) : null;
  if (typeof value === 'string') { const t = value.trim(); return t.length ? t : null; }
  return value;
}

/**
 * For each field: { value, mixed }. `value` is the shared value (null when empty) or,
 * when the tracks differ, null with mixed true.
 */
export function mergeFields(tracks) {
  const out = {};
  for (const field of FIELDS) {
    const values = (tracks ?? []).map(track => norm(field, track?.[field.key]));
    const first = values.length ? values[0] : null;
    const mixed = values.some(value => value !== first);
    out[field.key] = { value: mixed ? null : first, mixed };
  }
  return out;
}

/** The text an input starts with. */
export function initialText(merged, key) {
  const entry = merged[key];
  if (!entry || entry.mixed || entry.value === null) return '';
  return String(entry.value);
}

/**
 * Build the tag patch from the touched fields. `edits` is { key: text } for every
 * field the person changed. A mixed field left empty stays unchanged; a shared field
 * emptied is removed (null). Edits equal to the shared value are dropped.
 * Returns { patch, errors: [{ key, message }] }.
 */
const SKIP = Object.freeze({ skip: true });

function emptyFieldChange(field, entry) {
  if (entry.mixed || entry.value === null) return SKIP;
  return { value: field.kind === 'rating' ? 0 : null };
}

function numberFieldChange(field, entry, text) {
  if (!/^\d+$/.test(text) || Number(text) > field.max) {
    return { error: `${FIELD_LABELS[field.key]} must be a whole number from 0 to ${field.max}.` };
  }
  const number = Number(text);
  if (field.kind === 'rating' && number === 0 && entry.value === null && !entry.mixed) return SKIP;
  if (!entry.mixed && entry.value === number) return SKIP;
  return { value: number };
}

/** One field's change: { skip }, { value } or { error }. */
function fieldChange(field, entry, text) {
  if (!text) return emptyFieldChange(field, entry);
  if (field.kind !== 'text') return numberFieldChange(field, entry, text);
  return !entry.mixed && entry.value === text ? SKIP : { value: text };
}

export function buildPatch(merged, edits = {}) {
  const patch = {};
  const errors = [];
  for (const field of FIELDS.filter(f => f.key in edits)) {
    const entry = merged[field.key] ?? { value: null, mixed: false };
    const change = fieldChange(field, entry, String(edits[field.key] ?? '').trim());
    if (change.error) errors.push({ key: field.key, message: change.error });
    else if (!change.skip) patch[field.key] = change.value;
  }
  return { patch, errors };
}

/** The index fields to update after a successful write. */
export function recordPatchFrom(patch) {
  const out = {};
  for (const field of FIELDS) {
    if (!(field.key in patch)) continue;
    out[field.key] = field.kind === 'rating' ? (patch[field.key] ?? 0) : patch[field.key];
  }
  return out;
}

function shownPatchValue(field, value) {
  if (value === null || value === 0 && field.kind === 'rating') return 'removed';
  return field.kind === 'text' ? `"${value}"` : String(value);
}

/** Lines for a many-file diff: one per field, saying how many files change. */
export function manyFileLines(patch, summary, picture = null) {
  const lines = [];
  for (const field of FIELDS) {
    if (!(field.key in patch)) continue;
    const count = summary.fields[field.key] ?? 0;
    if (!count) continue;
    const shown = shownPatchValue(field, patch[field.key]);
    lines.push(`${FIELD_LABELS[field.key]}: set to ${shown} in ${count} file${count === 1 ? '' : 's'}`);
  }
  if (picture && summary.fields.picture) lines.push(`Cover art: replaced in ${summary.fields.picture} file${summary.fields.picture === 1 ? '' : 's'}`);
  return lines;
}

export function resultCounts(results) {
  const counts = { written: 0, failed: 0, skipped: 0, download: 0 };
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return counts;
}

export function resultSummary(results) {
  const c = resultCounts(results);
  const parts = [];
  if (c.written) parts.push(`${c.written} written`);
  if (c.download) parts.push(`${c.download} ready to download`);
  if (c.skipped) parts.push(`${c.skipped} skipped`);
  if (c.failed) parts.push(`${c.failed} failed`);
  return parts.length ? `${parts.join(', ')}.` : 'Nothing to write.';
}

const canWrite = handle => Boolean(handle && typeof handle.createWritable === 'function');

function writtenMessage(saved) {
  return saved.skipped?.length ? `Written; not stored in this format: ${saved.skipped.join(', ')}.` : 'Written and read back.';
}

/** One line per kept tag backup, for the "Restore tag backups" list. */
export function backupLine(item) {
  const when = Number.isFinite(item.savedAt) ? new Date(item.savedAt).toLocaleString() : 'an earlier session';
  const what = item.status === 'failed'
    ? 'the write did not read back; this is the only good copy'
    : item.status === 'written' ? 'original before a tag edit' : 'backup with no record';
  const size = Number.isFinite(item.size) ? `, ${Math.max(1, Math.round(item.size / 1024))} KB` : '';
  return `${item.path ?? item.name}: ${what}, saved ${when}${size}`;
}

/**
 * The kept tag backups with what restoring each needs. `ctx.library.handleForPath(path)`
 * (or getTrack by path) gives the file to restore into. Returns
 * `[{ ...backup, line, restore?, remove }]`, newest first.
 */
export async function tagBackupRows(ctx, saveOptions = {}) {
  const backups = await listTagBackups(saveOptions);
  return backups.map(item => {
    const row = { ...item, line: backupLine(item) };
    const handleFor = async () => {
      if (typeof ctx.library?.handleForPath === 'function') return ctx.library.handleForPath(item.path);
      const track = ctx.library?.findByPath?.(item.path);
      return track ? ctx.library.handleFor?.(track) : null;
    };
    if (item.path) {
      row.restore = async () => {
        const handle = await handleFor();
        if (!canWrite(handle)) throw new Error(`NakliAmp cannot open ${item.path} to restore it. Open its music folder, then try again.`);
        return restoreTagBackup(handle, item.backup, saveOptions);
      };
    }
    row.remove = () => deleteTagBackup(item.backup, saveOptions);
    return row;
  });
}

// ---------------------------------------------------------- the command ----

/**
 * The `track.edit_tags` handler: { diff, run }. Bind it with
 * bindCommands({ 'track.edit_tags': createEditTagsHandler(ctx), ... }, { confirm }).
 * run returns { results: [{ id, name, status, message, backup? }], summary }.
 * `saveOptions` passes through to saveTagsToHandle (tests inject an OPFS fake).
 */
export function createEditTagsHandler(ctx, { saveOptions = {} } = {}) {
  const prepared = new WeakMap();

  async function handleOf(track) {
    try { return track ? await ctx.library.handleFor?.(track) : null; } catch { return null; }
  }

  async function prepareItem(id, patch) {
    const track = ctx.library.getTrack(id);
    if (!track) return { id, track: null, name: String(id), file: null, plan: { writable: false, reason: 'This track is no longer in the library.', notes: [] } };
    const name = track.name ?? track.path?.split('/').pop() ?? String(id);
    let file = null;
    let plan;
    try {
      file = await ctx.library.fileFor(track);
      plan = await planTagWrite(file, patch);
    } catch (error) {
      plan = { writable: false, reason: `NakliAmp could not read ${name}: ${error?.message ?? error}`, notes: [] };
    }
    return { id, track, name, file, plan, diff: plan.writable ? describeTagChange(track, patch, plan) : null };
  }

  async function prepare(input, context = {}) {
    if (prepared.has(input)) return prepared.get(input);
    const ids = input.ids?.length ? input.ids : [ctx.queue?.current?.()].filter(Boolean);
    if (!ids.length) throw Object.assign(new Error('[not-found] No track to edit: select tracks or play one.'), { code: 'not-found' });
    const picture = context.picture ?? null;
    const patch = picture ? { ...input.patch, picture } : { ...input.patch };
    const items = [];
    for (const id of ids) items.push(await prepareItem(id, patch));
    const handle = await handleOf(items.find(item => item.track)?.track);
    const value = { ids, patch, picture, items, writable: canWrite(handle) };
    prepared.set(input, value);
    return value;
  }

  async function diff(input, context) {
    const { patch, picture, items, writable } = await prepare(input, context);
    const ok = items.filter(item => item.diff);
    const diffs = ok.map(item => item.diff);
    const summary = summariseTagChanges(diffs);
    const notes = [...summary.notes];
    if (!writable) notes.push('This browser cannot write to your files. After you approve, NakliAmp makes edited copies for you to download.');
    const skipped = items.filter(item => !item.diff).map(item => ({ name: item.name, skipped: true, reason: item.plan.reason }));
    const single = items.length === 1;
    return {
      title: single ? `Edit tags of ${items[0].name}?` : `Edit tags of ${items.length} files?`,
      summary: single ? null : `${summary.filesChanged} of ${items.length} files change.`,
      lines: single ? (diffs[0]?.lines ?? []).filter(line => !(diffs[0]?.notes ?? []).includes(line)) : manyFileLines(patch, summary, picture),
      notes,
      files: [...(single || ok.length > 20 ? [] : ok.map(item => ({ name: item.name, lines: item.diff.lines.filter(l => !item.diff.notes.includes(l)) }))), ...skipped],
      unchanged: summary.filesChanged === 0,
      approveLabel: writable ? 'Write tags' : 'Make edited copies',
    };
  }

  async function updateIndex(item, patch, saved) {
    try {
      await ctx.library.updateTrack(item.id, { ...recordPatchFrom(patch), lastModified: saved.lastModified, size: saved.size });
    } catch (error) {
      console.warn('[nakliamp] index update after tag write failed', error);
    }
  }

  async function writeItem(item, handle, patch) {
    try {
      const saved = await saveTagsToHandle(handle, patch, saveOptionsFor(item));
      await updateIndex(item, patch, saved);
      // The original stays in the backup folder, so a good write can be undone.
      return withRestore({ id: item.id, name: item.name, status: 'written', backup: saved.backup ?? null, message: writtenMessage(saved) }, handle);
    } catch (error) {
      return withRestore({ id: item.id, name: item.name, status: 'failed', code: error?.code ?? null, message: String(error?.message ?? error), backup: error?.backup ?? null }, handle);
    }
  }

  function saveOptionsFor(item) {
    return { ...saveOptions, path: item.track.path ?? null, expectedLastModified: item.track.lastModified || undefined };
  }

  function withRestore(result, handle) {
    if (result.backup) Object.defineProperty(result, 'restore', { enumerable: false, value: () => restoreTagBackup(handle, result.backup, saveOptions) });
    return result;
  }

  function downloadResult(item, patch) {
    const result = { id: item.id, name: item.name, status: 'download', message: 'This browser cannot write the file. Download an edited copy instead.' };
    const file = item.file;
    Object.defineProperty(result, 'make', { enumerable: false, value: () => writeTags(file, patch) });
    return result;
  }

  async function runItem(item, patch) {
    if (!item.plan.writable) return { id: item.id, name: item.name, status: 'skipped', message: item.plan.reason };
    if (item.diff?.unchanged) return { id: item.id, name: item.name, status: 'skipped', message: 'Already has these tags.' };
    const handle = await handleOf(item.track);
    return canWrite(handle) ? writeItem(item, handle, patch) : downloadResult(item, patch);
  }

  async function run(input, context = {}) {
    const { patch, items } = await prepare(input, context);
    prepared.delete(input);
    const results = [];
    const total = items.length;
    for (const item of items) {
      const result = await runItem(item, patch);
      results.push(result);
      try { context.onProgress?.(results.length, total, result); } catch { /* progress display only */ }
    }
    return { results, summary: resultSummary(results) };
  }

  return { diff, run };
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-tags,.nk-tags *{box-sizing:border-box}
.nk-tags{--c-ink:var(--ink,var(--text));color:var(--c-ink);display:grid;gap:12px;min-width:0}
.nk-tags .lead{margin:0;color:var(--muted);overflow-wrap:anywhere}
.nk-tags .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px 12px}
.nk-tags .f{display:flex;flex-direction:column;gap:4px;min-width:0}
.nk-tags .f.span2{grid-column:span 2}.nk-tags .f.span4{grid-column:1/-1}
.nk-tags label{font-size:12px;color:var(--muted)}
.nk-tags input[type=text],.nk-tags input[type=number],.nk-tags select{min-height:36px;width:100%;padding:5px 9px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--c-ink);font:inherit;min-width:0}
.nk-tags input::placeholder{color:var(--faint,var(--muted));font-style:italic}
.nk-tags .f.touched input,.nk-tags .f.touched select{border-color:var(--accent)}
/* te-art, not art: the shell's .art class painted the Now playing record over this box (M3). */
.nk-tags .te-art{display:flex;align-items:center;gap:10px;flex-wrap:wrap;max-width:100%}
.nk-tags .te-art img{width:64px;height:64px;max-width:120px;max-height:120px;object-fit:cover;border-radius:8px;border:1px solid var(--line)}
.nk-tags .note{font-size:12px;line-height:1.5;color:var(--warn,var(--muted));margin:0}
.nk-tags .err{color:var(--refuse,#c0392b);font-size:12px;margin:0}
.nk-tags ul.res{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.nk-tags ul.res li{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border:1px solid var(--line);border-radius:8px;padding:6px 9px;background:var(--panel-2);overflow-wrap:anywhere}
.nk-tags .st{font:10px var(--mono,monospace);text-transform:uppercase;letter-spacing:.06em}
.nk-tags .st.written{color:var(--good,var(--accent))}.nk-tags .st.failed{color:var(--refuse,#c0392b)}.nk-tags .st.skipped,.nk-tags .st.download{color:var(--warn,var(--muted))}
.nk-tags .actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.nk-tags progress{width:100%;accent-color:var(--accent)}
@media(max-width:520px){.nk-tags .grid{grid-template-columns:repeat(2,minmax(0,1fr))}.nk-tags .f.span2{grid-column:1/-1}}
`;

// ------------------------------------------------------------------- UI ----

const submitErrorText = error => (error?.code === 'declined' ? 'Nothing was written.' : String(error?.message ?? error));

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function mountTagEditor(root, ctx) {
  injectCss('tag-editor', CSS);
  const id = nextId('tags');
  const container = h('div', { className: 'nk-tags' });
  root.append(container);
  let ids = [];
  let merged = {};
  let edits = {};
  let picture = null;
  let pictureUrl = null;
  let token = 0;
  let busy = false;

  function setPicture(next) {
    if (pictureUrl) URL.revokeObjectURL(pictureUrl);
    picture = next;
    pictureUrl = next ? URL.createObjectURL(new Blob([next.bytes], { type: next.mime })) : null;
  }

  async function load(nextIds) {
    const mine = ++token;
    ids = (nextIds?.length ? nextIds : [ctx.queue?.current?.()]).filter(Boolean);
    edits = {};
    setPicture(null);
    const tracks = ids.map(i => ctx.library.getTrack(i)).filter(Boolean);
    ids = tracks.map(t => t.id);
    merged = mergeFields(tracks);
    if (!tracks.length) {
      container.replaceChildren(h('p', { className: 'lead', textContent: 'Select tracks or play one to edit its tags.' }));
      return;
    }
    renderForm(tracks, mine);
  }

  function ratingControl(f, entry, inputId) {
    const control = h('select', { id: inputId },
      entry.mixed ? h('option', { value: '', textContent: MULTIPLE }) : null,
      [0, 1, 2, 3, 4, 5].map(n => h('option', { value: String(n), textContent: n ? `${n} star${n === 1 ? '' : 's'}` : 'No rating' })));
    control.value = entry.mixed ? '' : String(entry.value ?? 0);
    return control;
  }

  function textControl(f, entry, inputId) {
    const numeric = f.kind === 'number';
    const control = h('input', {
      id: inputId, type: numeric ? 'number' : 'text', inputmode: numeric ? 'numeric' : null,
      min: numeric ? 0 : null, max: f.max ?? null, value: initialText(merged, f.key),
      placeholder: entry.mixed ? MULTIPLE : '', autocomplete: 'off', spellcheck: f.kind === 'text' ? 'true' : 'false',
    });
    if (f.describe) control.setAttribute('aria-label', f.describe);
    return control;
  }

  function field(f) {
    const entry = merged[f.key];
    const inputId = `${id}-${f.key}`;
    const wrap = h('div', { className: `f${['title', 'artist', 'album', 'albumArtist'].includes(f.key) ? ' span2' : ''}` });
    const control = f.kind === 'rating' ? ratingControl(f, entry, inputId) : textControl(f, entry, inputId);
    control.addEventListener(f.kind === 'rating' ? 'change' : 'input', () => { edits[f.key] = control.value; wrap.classList.add('touched'); });
    wrap.append(h('label', { htmlFor: inputId, textContent: f.label }), control);
    return wrap;
  }

  function renderForm(tracks, mine) {
    const single = tracks.length === 1;
    const lead = h('p', { className: 'lead', textContent: single
      ? `Editing ${tracks[0].title || tracks[0].name || 'this track'}.`
      : `Editing ${tracks.length} tracks. Fields that differ show "${MULTIPLE}" and stay as they are unless you type in them.` });
    const grid = h('div', { className: 'grid' }, FIELDS.map(field));

    const artInput = h('input', { type: 'file', id: `${id}-art`, accept: 'image/jpeg,image/png,image/webp,image/gif' });
    const artPreview = h('img', { alt: '', hidden: true });
    const artText = h('span', { className: 'lead', textContent: single ? 'Current cover art is kept.' : 'Each file keeps its cover art.' });
    const artClear = h('button', { type: 'button', className: 'nk-btn', textContent: 'Keep current art', hidden: true });
    const artPick = h('button', { type: 'button', className: 'nk-btn', textContent: 'Choose image...', onclick: () => artInput.click() });
    const artErr = h('p', { className: 'err', role: 'alert' });
    artInput.style.display = 'none';
    artInput.setAttribute('aria-label', 'Cover art image file');
    artInput.addEventListener('change', async () => {
      artErr.textContent = '';
      const file = artInput.files?.[0];
      artInput.value = '';
      if (!file) return;
      if (file.size > MAX_PICTURE_BYTES) { artErr.textContent = `${file.name} is larger than 8 MB; pick a smaller image.`; return; }
      const mime = file.type || (/\.png$/i.test(file.name) ? 'image/png' : /\.webp$/i.test(file.name) ? 'image/webp' : 'image/jpeg');
      setPicture({ mime, bytes: new Uint8Array(await file.arrayBuffer()) });
      artPreview.src = pictureUrl;
      artPreview.alt = `New cover art: ${file.name}`;
      artPreview.hidden = false;
      artText.textContent = `New art: ${file.name}`;
      artClear.hidden = false;
    });
    artClear.addEventListener('click', () => {
      setPicture(null);
      artPreview.hidden = true;
      artPreview.removeAttribute('src');
      artText.textContent = single ? 'Current cover art is kept.' : 'Each file keeps its cover art.';
      artClear.hidden = true;
    });
    if (single && typeof ctx.artUrl === 'function') {
      ctx.artUrl(tracks[0]).then(url => {
        if (url && mine === token && !picture) { artPreview.src = url; artPreview.alt = 'Current cover art'; artPreview.hidden = false; }
      }).catch(() => {});
    }
    const art = h('div', { className: 'f span4' }, h('label', { htmlFor: `${id}-art`, textContent: 'Cover art' }),
      h('div', { className: 'te-art' }, artPreview, artText, artPick, artClear, artInput), artErr);

    const formatNote = h('p', { className: 'note', role: 'status' });
    const errors = h('p', { className: 'err', role: 'alert' });
    const progress = h('progress', { max: tracks.length, value: 0, hidden: true, 'aria-label': 'Tag writing progress' });
    const results = h('ul', { className: 'res', 'aria-label': 'Results per file' });
    const save = h('button', { type: 'button', className: 'nk-btn primary', textContent: 'Review and save' });
    const cancel = h('button', { type: 'button', className: 'nk-btn', textContent: 'Close', onclick: () => (ctx.close ?? (() => {}))() });
    save.addEventListener('click', () => submit({ save, errors, progress, results }));

    container.replaceChildren(lead, grid, art, formatNote, errors, progress, results, h('div', { className: 'actions' }, cancel, save), backupsSection());
    checkFormats(tracks, formatNote, mine);
  }

  async function noteFormat(track, lines, unwritable) {
    try {
      const info = await inspectTagFormat(await ctx.library.fileFor(track));
      const olderId3 = info.format === 'mp3' && (info.id3Version === 2 || info.id3Version === 3);
      if (!info.writable) unwritable.push(`${track.name ?? track.path} (${info.label})`);
      else if (olderId3 && !lines.some(l => l.startsWith('Older ID3'))) lines.push('Older ID3 tags (version 2.2 or 2.3) become ID3v2.4 when written; the review lists the details.');
    } catch { /* the review step reports unreadable files by name */ }
  }

  async function checkFormats(tracks, note, mine) {
    const lines = [];
    let handle = null;
    try { handle = await ctx.library.handleFor?.(tracks[0]); } catch { handle = null; }
    if (!canWrite(handle)) lines.push('This browser cannot write to your files, so saving makes edited copies to download.');
    const unwritable = [];
    for (const track of tracks.slice(0, 200)) {
      await noteFormat(track, lines, unwritable);
      if (mine !== token) return;
    }
    if (unwritable.length) lines.push(`Skipped, because tag editing does not support their format: ${unwritable.join(', ')}.`);
    note.textContent = lines.join(' ');
  }

  function checkedPatch() {
    const { patch, errors: problems } = buildPatch(merged, edits);
    if (problems.length) return { patch, problem: problems.map(p => p.message).join(' ') };
    if (!Object.keys(patch).length && !picture) return { patch, problem: 'Change a field or choose cover art first.' };
    return { patch, problem: null };
  }

  async function submit({ save, errors, progress, results }) {
    if (busy) return;
    errors.textContent = '';
    const { patch, problem } = checkedPatch();
    if (problem) { errors.textContent = problem; return; }
    busy = true;
    save.disabled = true;
    results.replaceChildren();
    progress.value = 0;
    try {
      const outcome = await ctx.run('track.edit_tags', { ids, patch }, {
        context: {
          picture,
          onProgress: (done, total) => { progress.hidden = false; progress.max = total; progress.value = done; },
        },
      });
      renderResults(outcome?.results ?? [], results);
      ctx.toast?.(outcome?.summary ?? 'Tags saved.');
    } catch (error) {
      errors.textContent = submitErrorText(error);
    } finally {
      busy = false;
      save.disabled = false;
      progress.hidden = true;
    }
  }

  /** "Restore tag backups": every original kept in private storage, with Restore and Delete. */
  function backupsSection() {
    const list = h('ul', { className: 'res', 'aria-label': 'Tag backups' });
    const status = h('p', { className: 'lead', role: 'status' });
    const show = h('button', { type: 'button', className: 'nk-btn', textContent: 'Restore tag backups...' });
    const section = h('details', { className: 'f span4' }, h('summary', { textContent: 'Tag backups' }), status, show, list);
    async function refresh() {
      status.textContent = 'Reading backups...';
      let rows;
      try { rows = await tagBackupRows(ctx, ctx.tagSaveOptions ?? {}); } catch (error) { status.textContent = String(error?.message ?? error); return; }
      status.textContent = rows.length ? `${rows.length} backup${rows.length === 1 ? '' : 's'}. Restoring puts that file back as it was before the edit.` : 'No tag backups are kept.';
      list.replaceChildren(...rows.map(row => {
        const li = h('li', {}, h('span', { className: `st ${row.status === 'failed' ? 'failed' : 'written'}`, textContent: row.status }), h('span', { textContent: row.line }));
        if (row.restore) {
          li.append(h('button', { type: 'button', className: 'nk-btn danger', textContent: 'Restore', 'aria-label': `Restore ${row.path} from its backup`, onclick: async () => {
            try {
              const restored = await row.restore();
              const track = ctx.library?.findByPath?.(row.path);
              if (track) await ctx.library.updateTrack?.(track.id, { lastModified: restored.lastModified, size: restored.size });
              ctx.toast?.(`Restored ${row.path}.`);
              await refresh();
            } catch (error) { ctx.toast?.(String(error?.message ?? error)); }
          } }));
        }
        // A failed write's backup may be the only good copy, so only a good write's backup offers Delete.
        if (row.status === 'written') {
          li.append(h('button', { type: 'button', className: 'nk-btn', textContent: 'Delete', 'aria-label': `Delete the backup of ${row.path ?? row.name}`, onclick: async () => {
            try { await row.remove(); await refresh(); } catch (error) { ctx.toast?.(String(error?.message ?? error)); }
          } }));
        }
        return li;
      }));
    }
    show.addEventListener('click', refresh);
    return section;
  }

  function renderResults(list, target) {
    target.replaceChildren(...list.map(result => {
      const li = h('li', {}, h('span', { className: `st ${result.status}`, textContent: result.status === 'download' ? 'copy' : result.status }),
        h('strong', { textContent: result.name }), h('span', { textContent: result.message }));
      if (typeof result.make === 'function') {
        li.append(h('button', {
          type: 'button', className: 'nk-btn', textContent: 'Download edited copy', 'aria-label': `Download edited copy of ${result.name}`,
          onclick: async () => {
            try { downloadBlob(await result.make(), result.name); } catch (error) { ctx.toast?.(String(error?.message ?? error)); }
          },
        }));
      }
      if (typeof result.restore === 'function') {
        const undo = result.status === 'written';
        const restore = h('button', { type: 'button', className: `nk-btn${undo ? '' : ' danger'}`, textContent: undo ? 'Undo' : 'Restore original', 'aria-label': undo ? `Undo the tag edit of ${result.name}` : `Restore the original ${result.name}` });
        restore.addEventListener('click', async () => {
          restore.disabled = true;
          try {
            const restored = await result.restore();
            await ctx.library.updateTrack?.(result.id, { lastModified: restored.lastModified, size: restored.size });
            li.querySelector('.st').textContent = 'restored';
            restore.remove();
          } catch (error) {
            restore.disabled = false;
            ctx.toast?.(String(error?.message ?? error));
          }
        });
        li.append(restore);
      }
      return li;
    }));
  }

  load([]);

  return {
    update(state) {
      if (state && Array.isArray(state.ids)) load(state.ids);
    },
    destroy() {
      token += 1;
      setPicture(null);
      container.remove();
    },
  };
}
