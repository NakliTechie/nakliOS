// ai-dialog.mjs — playlist from a description (Q1).
//
// makePlaylist filters the library first and, when NakliOS offers a model
// (ctx.host.aiReady()), asks it to pick from those candidates by id. Without a
// model the same dialog matches by tags and search. The dialog says which path ran,
// previews the tracks, lets you remove rows, then saves (playlist.create) or plays.

import { makePlaylist, PATHS } from '../ai/playlist.mjs';
import { h, injectCss, nextId } from './dialog.mjs';

export const LENGTHS = Object.freeze([10, 25, 50, 100]);

const WIDENED = Object.freeze({
  'genre-neighbours': 'neighbouring genres',
  'most-played': 'your most-played tracks',
  'most-played-ignoring-filters': 'your most-played tracks outside the filters',
});

// ---------------------------------------------------------------- pure ----

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Split a filter-only result into the direct matches and the widened rest (M6).
 * makePlaylist lists the direct matches first and `matched` counts them, so the
 * tracks after them came from widening. A model result is the model's choice and
 * is not split. Returns `{ shown, extra }` as track ids.
 */
export function splitMatches(result) {
  const { trackIds = [], path, widened = [], matched } = result ?? {};
  const ids = [...trackIds];
  const count = Number(matched) || 0;
  const filterOnly = path === PATHS.filter || path === PATHS.failed;
  const splits = filterOnly && widened.length > 0 && count > 0 && count < ids.length;
  return splits ? { shown: ids.slice(0, count), extra: ids.slice(count) } : { shown: ids, extra: [] };
}

/**
 * Name where widened tracks come from, truthfully: "your most-played tracks" only
 * when some of them have been played. `getTrack(id)` reads a library record.
 */
export function widenedSource(extraIds, widened, getTrack) {
  const played = extraIds.some(id => (Number(getTrack(id)?.playCount) || 0) > 0);
  const names = (widened ?? []).map(step => {
    if (step === 'genre-neighbours') return 'neighbouring genres';
    return played ? 'your most-played tracks' : 'the rest of your library';
  });
  return [...new Set(names)].join(' and ') || 'the rest of your library';
}

/**
 * Preview titles that are unique: when two rows share a title (untagged files
 * named after their stem), each gets its file extension, then its folder (polish 5).
 */
export function disambiguate(rows, getTrack) {
  const count = new Map();
  for (const row of rows) count.set(row.title, (count.get(row.title) ?? 0) + 1);
  return rows.map(row => {
    if (count.get(row.title) < 2) return row;
    const path = String(getTrack(row.id)?.path ?? '');
    const file = path.split('/').pop() ?? '';
    const ext = file.includes('.') ? file.split('.').pop() : '';
    const folder = path.split('/').slice(0, -1).join('/');
    const detail = [ext && `.${ext}`, folder].filter(Boolean).join(' in ');
    return detail ? { ...row, title: `${row.title} (${detail})` } : row;
  });
}

/** `widenedText`, when given, names the source from the tracks themselves (see widenedSource). */
function widenedNames(result) {
  if (result.widenedText) return [result.widenedText];
  return (result.widened ?? []).map(w => WIDENED[w] ?? w);
}

/** Plain words for which path makePlaylist took. */
export function pathWording(result) {
  if (!result) return '';
  const pool = plural(result.candidateCount ?? 0, 'matching track');
  let text;
  switch (result.path) {
    case PATHS.model: text = `Picked by the NakliOS model from ${pool}.`; break;
    case PATHS.retry: text = `Picked by the NakliOS model from ${pool}, on its second try.`; break;
    case PATHS.failed: text = `The NakliOS model did not give a usable answer${result.error ? ` (${result.error.replace(/\.$/, '')})` : ''}, so these are matched by tags and search.`; break;
    default:
      text = result.candidateCount === 0
        ? 'Nothing in the library matched that description.'
        : result.hadModel
          ? 'Matched by tags and search.'
          : 'No model here: matched by tags and search.';
  }
  const widened = widenedNames(result);
  if (widened.length && result.candidateCount) text += ` Few tracks matched, so the search widened to ${widened.join(' and ')}.`;
  return text;
}

/** Rows to preview, in playlist order, skipping ids the library no longer has. */
export function previewRows(trackIds, getTrack) {
  const rows = [];
  for (const id of trackIds ?? []) {
    const track = getTrack(id);
    if (track) rows.push({ id, title: track.title || track.name || 'Untitled', artist: track.artist || track.albumArtist || '', album: track.album || '' });
  }
  return rows;
}

/** A playlist file name from the model's title or the description. */
export function playlistName(title, description) {
  const base = String(title || description || 'AI playlist').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return base.slice(0, 120) || 'AI playlist';
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-ai,.nk-ai *{box-sizing:border-box}
/* Only the preview list scrolls; the body scrolls only in a window too short for the controls. */
.nk-dlg-body:has(> .nk-ai){display:flex;flex-direction:column}
.nk-ai{--c-ink:var(--ink,var(--text));color:var(--c-ink);display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;flex:1 1 auto}
.nk-ai > *{flex:none}
.nk-ai label{font-size:12px;color:var(--muted)}
.nk-ai textarea,.nk-ai select,.nk-ai input[type=text]{width:100%;min-height:36px;padding:7px 9px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--c-ink);font:inherit;min-width:0}
.nk-ai textarea{min-height:70px;resize:vertical}
.nk-ai .row{display:flex;gap:10px;align-items:end;flex-wrap:wrap}
.nk-ai .row > .f{display:flex;flex-direction:column;gap:4px}
.nk-ai .row > .f.grow{flex:1;min-width:160px}
.nk-ai .status{margin:0;color:var(--muted);line-height:1.5}
.nk-ai .status.err{color:var(--refuse,#c0392b)}
.nk-ai > ol{margin:0;padding:0 2px 0 0;list-style:none;display:grid;align-content:start;gap:4px;flex:0 1 auto;min-height:72px;overflow:auto}
.nk-ai > ol:empty{display:none}
.nk-ai li{display:grid;grid-template-columns:auto 1fr auto;gap:8px;align-items:center;padding:5px 8px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);min-width:0}
.nk-ai li .n{font:10px var(--mono,monospace);color:var(--faint,var(--muted));min-width:22px;text-align:right}
.nk-ai li .t{min-width:0;overflow-wrap:anywhere}
.nk-ai li .t small{display:block;color:var(--muted)}
.nk-ai li button{min-width:34px;min-height:34px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:inherit;cursor:pointer}
.nk-ai li button:hover{border-color:var(--refuse,var(--accent))}
.nk-ai .actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.nk-ai > .nk-btn{align-self:flex-start}
`;

// ------------------------------------------------------------------- UI ----

export function mountAiDialog(root, ctx) {
  injectCss('ai-dialog', CSS);
  const id = nextId('ai');
  const description = h('textarea', { id: `${id}-desc`, maxlength: 500, placeholder: 'quiet piano for working', rows: 3 });
  const length = h('select', { id: `${id}-len` }, LENGTHS.map(n => h('option', { value: String(n), textContent: `${n} tracks` })));
  length.value = '25';
  const generate = h('button', { type: 'button', className: 'nk-btn primary', textContent: 'Generate' });
  const stop = h('button', { type: 'button', className: 'nk-btn', textContent: 'Stop', hidden: true });
  const status = h('p', { className: 'status', role: 'status', 'aria-live': 'polite' });
  const name = h('input', { type: 'text', id: `${id}-name`, maxlength: 120 });
  const nameField = h('div', { className: 'f grow', hidden: true }, h('label', { htmlFor: `${id}-name`, textContent: 'Playlist name' }), name);
  const list = h('ol', { 'aria-label': 'Playlist preview' });
  const save = h('button', { type: 'button', className: 'nk-btn', textContent: 'Save as playlist', disabled: true });
  const play = h('button', { type: 'button', className: 'nk-btn primary', textContent: 'Play now', disabled: true });

  const modelNote = ctx.host?.aiReady?.()
    ? 'NakliAmp filters your library, then the NakliOS model picks from the matches. Only track ids, titles, artists, albums, genres and years go to the model.'
    : 'No model here, so NakliAmp matches by tags and search. Inside NakliOS with a model chosen in Settings, the model picks from the matches.';

  const modelNoteEl = h('p', { className: 'status', textContent: modelNote });
  const widen = h('button', { type: 'button', className: 'nk-btn', hidden: true, textContent: 'Add more tracks' });
  const container = h('div', { className: 'nk-ai' },
    h('div', { className: 'f' }, h('label', { htmlFor: `${id}-desc`, textContent: 'Describe a playlist' }), description),
    h('div', { className: 'row' },
      h('div', { className: 'f' }, h('label', { htmlFor: `${id}-len`, textContent: 'Length' }), length),
      h('div', { className: 'f grow' }, modelNoteEl),
      generate, stop),
    status, widen, nameField, list, h('div', { className: 'actions' }, save, play));
  root.append(container);

  let rows = [];
  let extra = [];
  let extraSource = '';
  let controller = null;
  let lastDescription = '';
  let pathText = '';

  function renderRows() {
    list.replaceChildren(...rows.map((row, index) => h('li', {},
      h('span', { className: 'n', textContent: String(index + 1) }),
      h('span', { className: 't' }, row.title, h('small', { textContent: [row.artist, row.album].filter(Boolean).join(' · ') })),
      h('button', {
        type: 'button', textContent: '×', 'aria-label': `Remove ${row.title}`,
        onclick: () => {
          rows.splice(index, 1);
          renderRows();
          const next = list.querySelectorAll('button')[Math.min(index, rows.length - 1)];
          (next ?? description).focus();
        },
      }))));
    if (pathText) {
      const short = extra.length ? ` ${plural(rows.length, 'track')} ${rows.length === 1 ? 'matches' : 'match'}, fewer than the length you asked for.` : '';
      status.textContent = `${pathText}${short} ${rows.length ? `${plural(rows.length, 'track')} in the preview.` : 'The preview is empty.'}`;
    }
    widen.hidden = extra.length === 0;
    widen.textContent = `Add ${plural(extra.length, 'more track')} from ${extraSource}`;
    save.disabled = play.disabled = rows.length === 0;
    nameField.hidden = rows.length === 0;
  }

  async function run() {
    const text = description.value.trim();
    if (!text) { status.className = 'status err'; status.textContent = 'Describe the playlist first, for example "quiet piano for working".'; description.focus(); return; }
    controller?.abort();
    controller = new AbortController();
    pathText = '';
    const hadModel = Boolean(ctx.host?.aiReady?.());
    status.className = 'status';
    status.textContent = hadModel ? 'Filtering the library and asking the NakliOS model...' : 'Matching by tags and search...';
    generate.disabled = true;
    stop.hidden = !hadModel;
    try {
      const result = await makePlaylist({
        description: text,
        tracks: ctx.library.tracks(),
        chat: hadModel ? ctx.host.aiChat : null,
        length: Number(length.value),
        signal: controller.signal,
      });
      showResult(result, text, hadModel);
    } catch (error) {
      if (controller.signal.aborted) status.textContent = 'Stopped.';
      else { status.className = 'status err'; status.textContent = String(error?.message ?? error); }
    } finally {
      generate.disabled = false;
      stop.hidden = true;
    }
  }

  /** Without a model, only the tracks that match are shown; the widened rest waits behind a button that names its source (M6). */
  function showResult(result, text, hadModel) {
    lastDescription = text;
    const getTrack = i => ctx.library.getTrack(i);
    const { shown, extra: more } = splitMatches(result);
    const widenedSteps = result.widened ?? [];
    extra = more;
    extraSource = widenedSource(more, widenedSteps, getTrack);
    rows = disambiguate(previewRows(shown, getTrack), getTrack);
    name.value = playlistName(result.title, text);
    const sayWidened = !more.length && widenedSteps.length > 0;
    pathText = pathWording({
      ...result, hadModel,
      widened: sayWidened ? widenedSteps : [],
      widenedText: sayWidened ? widenedSource(result.trackIds ?? [], widenedSteps, getTrack) : null,
    });
    // The status now says which path ran, so the note above it would repeat it.
    modelNoteEl.hidden = true;
    renderRows();
  }

  widen.addEventListener('click', () => {
    const getTrack = i => ctx.library.getTrack(i);
    const have = new Set(rows.map(row => row.id));
    rows = disambiguate([...rows, ...previewRows(extra.filter(i => !have.has(i)), getTrack)], getTrack);
    pathText = `${pathText} Widened to ${extraSource}.`;
    extra = [];
    renderRows();
    list.querySelector('li:last-child button')?.focus();
  });
  generate.addEventListener('click', run);
  description.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); run(); }
  });
  stop.addEventListener('click', () => controller?.abort());
  save.addEventListener('click', async () => {
    const playlist = playlistName(name.value, lastDescription);
    save.disabled = true;
    try {
      await ctx.run('playlist.create', { name: playlist, ids: rows.map(r => r.id) });
      ctx.toast?.(`Saved the playlist ${playlist}.`);
      pathText = '';
      status.textContent = `Saved as ${playlist}.`;
    } catch (error) {
      status.className = 'status err';
      status.textContent = String(error?.message ?? error);
    } finally {
      save.disabled = rows.length === 0;
    }
  });
  play.addEventListener('click', () => {
    if (!rows.length) return;
    ctx.playTracks(rows.map(r => r.id), 0);
    ctx.close?.();
  });

  return {
    update(state) {
      if (state?.description && !description.value) description.value = String(state.description);
    },
    destroy() {
      controller?.abort();
      container.remove();
    },
  };
}
