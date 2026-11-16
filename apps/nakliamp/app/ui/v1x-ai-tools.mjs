// v1x-ai-tools.mjs — "More like this" (Q2) and genre fill (Q3).
//
// More like this: moreLikeThis() picks candidates from the playing track's tags and,
// when NakliOS offers a model, lets it rerank them. The panel lists them; Add to queue
// runs `queue.add`. Genre fill: suggestGenres() asks the model about albums with no
// genre, picking from a fixed list. The panel lists each album with a checkbox and an
// editable genre; only the approved rows are written, through `track.edit_tags`
// (destructive, so the change is shown and approved before any file changes).

import { moreLikeThis, SIMILAR_PATHS, DEFAULT_LENGTH } from '../ai/similar.mjs';
import { suggestGenres, toEditRequests, GENRE_VOCABULARY, albumsMissingGenre } from '../ai/genres.mjs';
import { h, injectCss, nextId } from './dialog.mjs';
import { injectBaseCss, plainError, writeTagPatches, writeSummary } from './v1x-library-tools.mjs';

export const SIMILAR_LENGTHS = Object.freeze([5, 10, 20, 30]);

// ---------------------------------------------------------------- pure ----

/** True when a model is offered: ctx.ai (v1.x shell), else the host. */
export function modelReady(ctx) {
  try { return ctx.ai ? Boolean(ctx.ai.ready?.()) : Boolean(ctx.host?.aiReady?.()); } catch { return false; }
}

/** The chat function to inject, or null without a model. */
export function chatOf(ctx) {
  if (!modelReady(ctx)) return null;
  if (typeof ctx.ai?.chat === 'function') return body => ctx.ai.chat(body);
  return typeof ctx.host?.aiChat === 'function' ? body => ctx.host.aiChat(body) : null;
}

/** Plain words for which path moreLikeThis took. */
export function similarPathText(result) {
  if (!result) return '';
  const pool = `${result.candidateCount} candidate${result.candidateCount === 1 ? '' : 's'}`;
  if (result.path === SIMILAR_PATHS.model) return `Picked by the NakliOS model from ${pool} that share artist, genre or decade.`;
  if (result.path === SIMILAR_PATHS.failed) return `The NakliOS model did not give a usable answer${result.error ? ` (${String(result.error).replace(/\.$/, '')})` : ''}, so these come from matching tags.`;
  if (!result.candidateCount) return 'Nothing else in the library shares this track\'s artist, genre or decade.';
  return 'Matched by tags: same artist, then album artist, genre and decade, at most two from one album.';
}

/** The playing track's id from the shell state or the queue. */
export function playingIdOf(ctx) {
  try { const id = ctx.state?.()?.playingId; if (id != null) return id; } catch { /* no shell state */ }
  try { return ctx.queue?.current?.() ?? null; } catch { return null; }
}

const libraryTracks = ctx => ctx.library?.tracks?.() ?? [];

/** Ids already in the queue, so More like this does not offer them again. */
export function queuedIdsOf(ctx) {
  try { return ctx.queue?.snapshot?.().ids ?? []; } catch { return []; }
}

/** Approved rows as `track.edit_tags` items: `[{ ids, patch: { genre } }]`. */
export function approvedEdits(rows) {
  const chosen = (rows ?? []).filter(r => r.approved).map(r => ({ ...r.suggestion, genre: r.genre }));
  return toEditRequests(chosen).map(request => ({ ids: request.input.ids, patch: request.input.patch, label: request.label }));
}

/** Rows the genre panel shows: one per suggestion, approved by default. */
export function genreRows(suggestions) {
  return (suggestions ?? []).map(s => ({ suggestion: s, genre: s.genre, approved: true }));
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-ai-tools .cand{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.nk-ai-tools .genre{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(120px,180px);gap:8px;align-items:center}
@media(max-width:480px){.nk-ai-tools .genre{grid-template-columns:auto minmax(0,1fr)}.nk-ai-tools .genre select{grid-column:2}}
`;

// ------------------------------------------------------- More like this ----

export function mountSimilar(root, ctx) {
  injectBaseCss();
  injectCss('v1x-ai-tools', CSS);
  const id = nextId('similar');
  const length = h('select', { id: `${id}-len` }, SIMILAR_LENGTHS.map(n => h('option', { value: n, textContent: `${n} tracks`, selected: n === DEFAULT_LENGTH })));
  const find = h('button', { type: 'button', className: 'btn primary', textContent: 'Find similar tracks' });
  const seedLine = h('p', { className: 'hint' });
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const list = h('ul', { className: 'list', 'aria-label': 'Similar tracks' });
  const addAll = h('button', { type: 'button', className: 'btn primary', textContent: 'Add all to queue', disabled: true });
  const container = h('div', { className: 'nk-v1x nk-ai-tools' },
    h('section', {}, seedLine,
      h('div', { className: 'row' }, h('div', { className: 'f' }, h('label', { htmlFor: `${id}-len`, textContent: 'How many' }), length), find),
      status, list, h('div', { className: 'row' }, addAll)));
  root.append(container);

  let ids = [];
  let controller = null;
  let seedId = null;
  const seed = () => { const pid = seedId ?? playingIdOf(ctx); return pid == null ? null : ctx.library?.getTrack?.(pid) ?? null; };

  function renderSeed() {
    const s = seed();
    seedLine.textContent = s ? `Starting from ${s.title || 'the playing track'}${s.artist ? ` by ${s.artist}` : ''}.` : 'Play a track first: more like this starts from the playing track.';
    find.disabled = !s;
  }

  async function add(trackIds) {
    try {
      await ctx.run('queue.add', { ids: trackIds.map(String) });
      ids = ids.filter(x => !trackIds.includes(x));
      ctx.toast?.(`Added ${trackIds.length} track${trackIds.length === 1 ? '' : 's'} to the queue.`);
    } catch (error) { ctx.toast?.(plainError(error)); }
    renderList();
  }

  function renderList() {
    list.replaceChildren(...ids.map(tid => {
      const t = ctx.library?.getTrack?.(tid);
      if (!t) return null;
      const name = t.title || 'Untitled';
      return h('li', { className: 'item cand' },
        h('div', {}, name, h('small', { textContent: [t.artist, t.album].filter(Boolean).join(', ') })),
        h('button', { type: 'button', className: 'btn', textContent: 'Add to queue', 'aria-label': `Add ${name} to the queue`, onclick: () => add([tid]) }));
    }).filter(Boolean));
    addAll.disabled = !ids.length;
  }

  find.addEventListener('click', async () => {
    const s = seed();
    if (!s) return;
    controller?.abort();
    controller = new AbortController();
    find.disabled = true;
    status.textContent = modelReady(ctx) ? 'Asking the NakliOS model…' : 'Matching by tags…';
    try {
      const result = await moreLikeThis({ seed: s, tracks: libraryTracks(ctx), queuedIds: queuedIdsOf(ctx), chat: chatOf(ctx), length: Number(length.value), signal: controller.signal });
      ids = result.trackIds;
      status.textContent = `${similarPathText(result)}${ids.length ? '' : ' Nothing to add.'}`;
    } catch (error) {
      if (error?.name !== 'AbortError') status.textContent = plainError(error);
    }
    find.disabled = false;
    renderList();
  });
  addAll.addEventListener('click', () => add(ids.slice()));

  renderSeed();
  return {
    update(state) { if (state?.trackId != null) seedId = state.trackId; renderSeed(); },
    destroy() { controller?.abort(); container.remove(); },
  };
}

// ------------------------------------------------------------ Genre fill ----

export function mountGenreFill(root, ctx) {
  injectBaseCss();
  injectCss('v1x-ai-tools', CSS);
  const id = nextId('genres');
  const ask = h('button', { type: 'button', className: 'btn primary', textContent: 'Suggest genres' });
  const scope = h('p', { className: 'hint' });
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const list = h('ul', { className: 'list', 'aria-label': 'Suggested genres' });
  const write = h('button', { type: 'button', className: 'btn primary', textContent: 'Write genres', disabled: true });
  const container = h('div', { className: 'nk-v1x nk-ai-tools' },
    h('section', {}, scope,
      h('p', { className: 'hint', textContent: 'The model sees only artist and album names, and picks from a fixed list of genres. Nothing is written until you approve.' }),
      h('div', { className: 'row' }, ask), status, list, h('div', { className: 'row' }, write)));
  root.append(container);

  let rows = [];
  let controller = null;

  function renderScope() {
    const missing = albumsMissingGenre(ctx.library?.tracks?.() ?? []).length;
    const model = modelReady(ctx);
    scope.textContent = `${missing} album${missing === 1 ? ' has' : 's have'} no genre.${model ? '' : ' Genre suggestions need a model; in NakliOS, pick one in Settings.'}`;
    ask.disabled = !missing || !model;
  }

  function renderRow(row, index) {
    const s = row.suggestion;
    const box = h('input', { type: 'checkbox', checked: row.approved, id: `${id}-a${index}`, 'aria-label': `Write ${row.genre} to ${s.album}` });
    const select = h('select', { 'aria-label': `Genre for ${s.album}` }, GENRE_VOCABULARY.map(g => h('option', { value: g, textContent: g, selected: g === row.genre })));
    box.addEventListener('change', () => { row.approved = box.checked; renderCount(); });
    select.addEventListener('change', () => { row.genre = select.value; box.setAttribute('aria-label', `Write ${row.genre} to ${s.album}`); });
    return h('li', { className: 'item genre' }, box,
      h('label', { htmlFor: `${id}-a${index}`, style: 'color:inherit;font-size:inherit' }, s.album, h('small', { textContent: `${s.artist ?? 'Unknown artist'}, ${s.trackIds.length} track${s.trackIds.length === 1 ? '' : 's'}` })),
      select);
  }

  function renderCount() {
    const n = rows.filter(r => r.approved).length;
    write.disabled = !n;
    write.textContent = n ? `Write genres to ${n} album${n === 1 ? '' : 's'}` : 'Write genres';
  }

  function renderList() {
    list.replaceChildren(...rows.map(renderRow));
    renderCount();
  }

  ask.addEventListener('click', async () => {
    controller?.abort();
    controller = new AbortController();
    ask.disabled = true;
    status.textContent = 'Asking the NakliOS model…';
    try {
      const result = await suggestGenres({ tracks: ctx.library?.tracks?.() ?? [], chat: chatOf(ctx), signal: controller.signal });
      rows = genreRows(result.suggestions);
      const notes = [`${rows.length} of ${result.albumsAsked} album${result.albumsAsked === 1 ? '' : 's'} have a suggestion.`];
      if (result.dropped.length) notes.push(`${result.dropped.length} answer${result.dropped.length === 1 ? ' was' : 's were'} left out (not in the list, or an unknown album).`);
      notes.push(...result.errors);
      status.textContent = notes.join(' ');
    } catch (error) {
      if (error?.name !== 'AbortError') status.textContent = plainError(error);
    }
    renderScope();
    renderList();
  });

  write.addEventListener('click', async () => {
    const items = approvedEdits(rows);
    if (!items.length) return;
    write.disabled = true;
    try {
      const result = await writeTagPatches(ctx, items, { title: 'Write genres' });
      status.textContent = writeSummary(result, 'album');
      if (result.written) rows = rows.filter(r => !r.approved);
    } catch (error) { status.textContent = plainError(error); }
    renderScope();
    renderList();
  });

  const off = ctx.library?.onChange?.(() => renderScope());
  renderScope();
  return {
    update() { renderScope(); },
    destroy() { controller?.abort(); if (typeof off === 'function') off(); container.remove(); },
  };
}
