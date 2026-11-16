// v1x-network.mjs — the opt-in network features: per-origin switches (consent), the
// ListenBrainz token (I1), MusicBrainz lookup for an album (T8) and LRCLIB lyrics (T9).
//
// Every origin is off until the person turns it on here; each row says, before the
// switch, what that provider receives. Switches go through `network.grant` and
// `network.revoke`. Lookups use ctx.net (the shell's service objects) and refuse by
// name while their origin is off. Writing tags goes through `track.edit_tags`
// (destructive, so the change is shown and approved first); a cover goes with it as
// `coverFrom`. Saving lyrics goes through `lyrics.save_sidecar`, which writes a new
// `.lrc` file beside the track.
//
// The ListenBrainz token is stored only in this browser, sealed in the vault
// (app/net/vault.mjs), and goes only to api.listenbrainz.org. The panel never shows it,
// and no command reads or sets it. A switch here is the person's own consent, so it runs
// `network.grant` with `byPerson`; every other caller of that command gets a confirm
// dialog (N16). A grant written outside this panel shows as unconfirmed and stays off.

import { formatRemaining } from '../player/timers.mjs';
import { parseLrc } from '../library/lyrics.mjs';
import { h, injectCss, nextId } from './dialog.mjs';
import { injectBaseCss, plainError, runOr, writeTagPatches, writeSummary, FIELD_LABELS } from './v1x-library-tools.mjs';

// ---------------------------------------------------------------- pure ----

/** Rows for the switches, from consent.list() or the `network.list` result. */
export function networkRows(list) {
  const rows = Array.isArray(list) ? list : (list?.origins ?? list?.rows ?? []);
  return rows.map(r => ({
    origin: r.origin, label: r.label || r.origin, purpose: r.purpose || '', sends: r.sends || '',
    also: Array.isArray(r.alsoContacts) ? r.alsoContacts : [], granted: Boolean(r.granted),
    unconfirmed: Boolean(r.unconfirmed),
  }));
}

/** "Sends: ..." line, with the extra origins a provider redirects to. */
export function sendsText(row) {
  const also = row.also.length ? ` Also contacts ${row.also.join(' and ')}.` : '';
  return `Sends: ${row.sends}${also}`;
}

/**
 * Plain words for the scrobble queue: `{ tokenSet, queued, rejected, nextAttemptAt,
 * lastError, userName }`, with `now` in milliseconds.
 */
export function scrobbleStatusText(s, now = Date.now()) {
  const parts = [];
  parts.push(s.tokenSet ? `Token saved${s.userName ? ` for ${s.userName}` : ''}.` : 'No token saved.');
  parts.push(`${s.queued} listen${s.queued === 1 ? '' : 's'} waiting to send.`);
  if (s.rejected) parts.push(`${s.rejected} refused by ListenBrainz and set aside.`);
  if (s.nextAttemptAt && s.nextAttemptAt > now) parts.push(`Next try in ${formatRemaining((s.nextAttemptAt - now) / 1000)}.`);
  if (s.lastError) parts.push(`Last error: ${s.lastError}`);
  if (s.saveError) parts.push(`This browser refused to store the waiting listens (${s.saveError.message || s.saveError.name || 'storage error'}), so they last only until this page reloads.`);
  return parts.join(' ');
}

const FLUSH_WORDS = {
  idle: 'Nothing to send.', sent: 'Sent.', 'no-token': 'Save a token first.', 'bad-token': 'ListenBrainz refused the token. Paste it again from listenbrainz.org, Settings.',
  offline: 'Could not reach ListenBrainz. NakliAmp tries again later.',
};

/** Words for a flush result's status. */
export function flushText(result) {
  if (!result) return '';
  const status = String(result.status ?? '');
  if (status === 'waiting') return 'Waiting before the next try.';
  if (status.startsWith('http-')) return `ListenBrainz answered ${status.slice(5)}. NakliAmp tries again later.`;
  const sent = result.sent ? ` ${result.sent} sent.` : '';
  return `${FLUSH_WORDS[status] ?? status}${sent}`;
}

/** The album and artist to search for from the selected tracks: the most common values. */
function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = ''; let bestCount = 0;
  for (const [value, count] of counts) if (count > bestCount) { best = value; bestCount = count; }
  return best;
}

export function albumQuery(tracks) {
  const top = mostCommon;
  return { album: top((tracks ?? []).map(t => t.album)), artist: top((tracks ?? []).map(t => t.albumArtist || t.artist)) };
}

/** One line for a search result. */
export function releaseLabel(r) {
  const meta = [r.year, r.country, r.trackCount ? `${r.trackCount} track${r.trackCount === 1 ? '' : 's'}` : null].filter(Boolean).join(', ');
  return `${r.title}${r.artist ? ` by ${r.artist}` : ''}${meta ? ` (${meta})` : ''}`;
}

const FIELD_LABEL_EXTRA = { trackNo: 'Track', trackTotal: 'Tracks', discNo: 'Disc', discTotal: 'Discs', year: 'Year' };
const MATCH_WORDS = { number: 'matched by track number', title: 'matched by title', 'album-only': 'no matching track; album fields only' };
const fieldValue = v => (v === null || v === undefined || v === '' ? '(empty)' : String(v));

/**
 * The tag changes a set of MusicBrainz patches makes, for the preview:
 * `[{ trackId, name, matched, changes: [{ field, before, after }] }]`. Fields
 * that already hold the same value are left out.
 */
export function patchPreview(patches, getTrack) {
  return (patches ?? []).map(p => {
    const track = getTrack(p.trackId) ?? {};
    const changes = Object.entries(p.patch ?? {})
      .filter(([field, value]) => String(track[field] ?? '') !== String(value ?? ''))
      .map(([field, value]) => ({ field: FIELD_LABELS[field] ?? FIELD_LABEL_EXTRA[field] ?? field, before: fieldValue(track[field]), after: fieldValue(value) }));
    return { trackId: p.trackId, name: track.title || String(track.path ?? '').split('/').pop() || 'Untitled', matched: MATCH_WORDS[p.matched] ?? p.matched, changes };
  });
}


/** Tag-write items from MusicBrainz patches, with the cover when asked for. */
export function patchItems(patches, { coverFrom = null } = {}) {
  return (patches ?? []).map(p => ({ ids: [String(p.trackId)], patch: { ...p.patch }, ...(coverFrom ? { coverFrom } : {}) }));
}

/** Normalise a lyrics result (from `lyrics.fetch` or LRCLIB) to `{ synced, lines, instrumental }` or null. */
export function lyricsOf(result) {
  const r = result?.lyrics ?? result?.result ?? result;
  if (!r || typeof r !== 'object') return null;
  if (r.instrumental) return { synced: false, lines: [], instrumental: true };
  if (Array.isArray(r.lines)) return { synced: Boolean(r.synced), lines: r.lines, instrumental: false };
  if (typeof r.text === 'string' && r.text.trim()) { const parsed = parseLrc(r.text); return { synced: parsed.synced, lines: parsed.lines, instrumental: false }; }
  return null;
}

/**
 * Where `lyrics.save_sidecar` writes: `{ path, name, text }` for a library track path and an
 * LRCLIB result, or a `{ code: 'not-found', message }` refusal when there is nothing to save
 * (an instrumental track, empty lyrics) (N34). `plan` is lrclib.mjs's sidecarPlan.
 */
export function lyricsSidecar(trackPath, result, plan) {
  const parts = String(trackPath ?? '').split('/');
  const made = result ? plan(parts.at(-1), result) : null;
  if (!made) {
    const message = result?.instrumental ? 'LRCLIB lists this track as instrumental, so there are no lyrics to save.' : 'LRCLIB has no lyrics for this track.';
    return { refusal: { code: 'not-found', message } };
  }
  const directory = parts.slice(0, -1).join('/');
  return { path: directory ? `${directory}/${made.name}` : made.name, name: made.name, text: made.text };
}

/** "Song.lrc" for a track path. */
export function sidecarName(path) {
  const base = String(path ?? '').split('/').pop() || 'track';
  return `${base.replace(/\.[^./]+$/, '')}.lrc`;
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-net .origin{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 10px;align-items:start}
.nk-net .origin p{grid-column:2}
.nk-net .cover{max-width:160px;width:100%;border-radius:8px;border:1px solid var(--line)}
.nk-net .lyrics{max-height:220px;overflow:auto;white-space:pre-wrap;font-size:13px;line-height:1.5;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.nk-net .changes{margin:4px 0 0;padding-left:18px;font-size:12px}
`;

// --------------------------------------------------------------- origins ----

function originsSection(ctx, id) {
  const list = h('ul', { className: 'list', 'aria-label': 'Network origins' });
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const consent = ctx.net?.consent ?? null;

  async function rows() {
    if (consent) return networkRows(consent.list());
    return networkRows(await ctx.run('network.list', {}));
  }

  async function toggle(row, on) {
    const name = on ? 'network.grant' : 'network.revoke';
    const direct = () => (on ? consent.grant(row.origin) : consent.revoke(row.origin));
    try {
      // The switch is the person's click, so the grant needs no second confirm (byPerson).
      if (typeof ctx.run === 'function') await ctx.run(name, { origin: row.origin }, { byPerson: true, context: { from: 'panel' } });
      else await runOr(ctx, name, { origin: row.origin }, direct);
      status.textContent = on ? `${row.label} is on.` : `${row.label} is off. Nothing more goes to ${row.origin}.`;
    } catch (error) { status.textContent = plainError(error); }
    render();
  }

  function renderRow(row) {
    const box = h('input', { type: 'checkbox', role: 'switch', checked: row.granted, id: `${id}-o-${row.label.replace(/\W+/g, '')}`, 'aria-describedby': `${id}-o-${row.label.replace(/\W+/g, '')}-d` });
    box.addEventListener('change', () => toggle(row, box.checked));
    const doubt = row.unconfirmed ? ' This switch was turned on outside this panel, so it stays off until you turn it on here.' : '';
    return h('li', { className: 'item origin' }, box,
      h('label', { htmlFor: box.id, style: 'color:inherit;font-size:inherit' }, h('strong', { textContent: row.label }), h('small', { className: 'mono', textContent: row.origin })),
      h('p', { id: `${box.id}-d`, className: 'hint' }, row.purpose, ' ', sendsText(row), doubt));
  }

  let rendered = false;
  async function render() {
    try { list.replaceChildren(...(await rows()).map(renderRow)); } catch (error) { status.textContent = plainError(error); }
    // The switches arrive after the dialog focused its first field; the first
    // switch, not the token field, is where the panel starts (minor 12).
    if (!rendered) {
      rendered = true;
      const active = list.ownerDocument?.activeElement;
      if (active?.type === 'password' && active.closest('.nk-net')) list.querySelector('input')?.focus();
    }
  }

  const off = consent?.onChange?.(() => render());
  const section = h('section', { 'aria-labelledby': `${id}-or-h` },
    // The dialog title already says Network (minor 2).
    h('h3', { id: `${id}-or-h`, textContent: 'Providers' }),
    h('p', { className: 'hint', textContent: 'NakliAmp sends nothing until you turn a provider on. No audio ever leaves this device.' }),
    list, status);
  return { section, render, destroy: () => { if (typeof off === 'function') off(); } };
}

// ----------------------------------------------------------- ListenBrainz ----

function listenBrainzSection(ctx, id) {
  const lb = ctx.net?.listenbrainz ?? null;
  const token = h('input', { type: 'password', id: `${id}-token`, autocomplete: 'off', spellcheck: 'false', placeholder: 'Paste your user token' });
  const save = h('button', { type: 'button', className: 'btn primary', textContent: 'Save token' });
  const validate = h('button', { type: 'button', className: 'btn', textContent: 'Validate' });
  const forget = h('button', { type: 'button', className: 'btn', textContent: 'Forget token' });
  const flush = h('button', { type: 'button', className: 'btn', textContent: 'Send waiting listens' });
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  let lastError = '';
  let userName = '';

  function render() {
    if (!lb) { status.textContent = 'Scrobbling is not available in this build.'; for (const b of [save, validate, forget, flush]) b.disabled = true; return; }
    const tokenSet = Boolean(lb.token());
    // Nothing to save until a token is typed (minor 12).
    save.disabled = !token.value.trim();
    validate.disabled = !tokenSet && !token.value.trim();
    forget.disabled = !tokenSet;
    flush.disabled = !tokenSet || !lb.queued().length;
    status.textContent = scrobbleStatusText({ tokenSet, queued: lb.queued().length, rejected: lb.rejected().length, nextAttemptAt: lb.nextAttemptAt(), lastError, userName, saveError: lb.saveError?.() ?? null });
  }

  async function guard(fn) {
    try { await fn(); } catch (error) { lastError = plainError(error); }
    render();
  }

  save.addEventListener('click', () => guard(async () => {
    lb.setToken(token.value);
    token.value = '';
    lastError = '';
    userName = '';
  }));
  validate.addEventListener('click', () => guard(async () => {
    if (token.value.trim()) { lb.setToken(token.value); token.value = ''; }
    const result = await lb.validateToken();
    userName = result.valid ? (result.userName ?? '') : '';
    lastError = result.valid ? '' : 'ListenBrainz does not accept this token.';
  }));
  forget.addEventListener('click', () => guard(async () => { lb.clearToken(); userName = ''; lastError = ''; }));
  flush.addEventListener('click', () => guard(async () => {
    const result = await runOr(ctx, 'scrobble.flush', {}, () => lb.flush({ force: true }));
    const text = flushText(result);
    lastError = /refused|answered|Could not/.test(text) ? text : '';
    if (!lastError && text) ctx.toast?.(text);
  }));
  token.addEventListener('input', render);
  token.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); save.click(); } });

  const section = h('section', { 'aria-labelledby': `${id}-lb-h` },
    h('h3', { id: `${id}-lb-h`, textContent: 'ListenBrainz scrobbling' }),
    h('p', { className: 'hint', textContent: 'Copy your user token from listenbrainz.org, Settings. It stays in this browser and goes only to ListenBrainz. Turn ListenBrainz on above before validating.' }),
    h('div', { className: 'row' }, h('div', { className: 'f' }, h('label', { htmlFor: `${id}-token`, textContent: 'User token' }), token)),
    h('div', { className: 'row' }, save, validate, forget, flush), status);
  return { section, render };
}

// ------------------------------------------------------------ MusicBrainz ----

function musicBrainzSection(ctx, id, getIds) {
  const mb = ctx.net?.musicbrainz ?? null;
  const album = h('input', { type: 'text', id: `${id}-album`, autocomplete: 'off' });
  const artist = h('input', { type: 'text', id: `${id}-artist`, autocomplete: 'off' });
  const search = h('button', { type: 'button', className: 'btn primary', textContent: 'Look up on MusicBrainz' });
  const scope = h('p', { className: 'hint' });
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { role: 'radiogroup', 'aria-label': 'MusicBrainz releases', className: 'list' });
  const cover = h('img', { className: 'cover', alt: 'Front cover from the Cover Art Archive', hidden: true });
  const withCover = h('input', { type: 'checkbox', id: `${id}-withcover` });
  const coverRow = h('label', { className: 'switch', htmlFor: `${id}-withcover`, hidden: true }, withCover, 'Write this cover into the files too');
  const preview = h('ul', { className: 'list', 'aria-label': 'Tag changes from MusicBrainz' });
  const write = h('button', { type: 'button', className: 'btn primary', textContent: 'Write tags', hidden: true });
  let tracks = [];
  let patches = [];
  let mbid = null;
  let coverUrl = null;

  const selected = () => getIds().map(tid => ctx.library?.getTrack?.(tid)).filter(t => t && !t.virtual && t.path);

  function refreshScope() {
    tracks = selected();
    const q = albumQuery(tracks);
    if (!album.value) album.value = q.album;
    if (!artist.value) artist.value = q.artist;
    scope.textContent = tracks.length ? `For the ${tracks.length} selected track${tracks.length === 1 ? '' : 's'}.` : 'Select an album\'s tracks in the library first.';
    search.disabled = !tracks.length || !mb;
  }

  function clearCover() {
    if (coverUrl?.startsWith('blob:')) URL.revokeObjectURL(coverUrl);
    coverUrl = null;
    cover.hidden = true;
    coverRow.hidden = true;
    withCover.checked = false;
  }

  async function showCover() {
    clearCover();
    try {
      const result = await runOr(ctx, 'tags.fetch_cover', { mbid }, async () => {
        const art = await mb.fetchFrontCover(mbid);
        return art ? { dataUrl: URL.createObjectURL(new Blob([art.bytes], { type: art.mime })) } : null;
      });
      if (!result?.dataUrl) return;
      coverUrl = result.dataUrl;
      cover.src = coverUrl;
      cover.hidden = false;
      coverRow.hidden = false;
    } catch (error) { status.textContent = `${status.textContent} Cover: ${plainError(error)}`; }
  }

  function renderPreview() {
    const rows = patchPreview(patches, tid => ctx.library?.getTrack?.(tid));
    preview.replaceChildren(...rows.map(row => h('li', { className: 'item' },
      h('div', {}, h('strong', { textContent: row.name }), h('small', { textContent: row.matched })),
      row.changes.length
        ? h('ul', { className: 'changes' }, row.changes.map(c => h('li', { textContent: `${c.field}: ${c.before} to ${c.after}` })))
        : h('small', { textContent: 'Already matches.' }))));
    const changing = rows.filter(r => r.changes.length).length;
    write.hidden = !patches.length;
    write.disabled = !changing && !withCover.checked;
    write.textContent = `Write tags to ${changing || patches.length} file${(changing || patches.length) === 1 ? '' : 's'}`;
  }

  async function pick(release) {
    mbid = release.mbid;
    status.textContent = `Reading ${release.title} from MusicBrainz…`;
    try {
      patches = await mb.patchesFor(mbid, tracks);
      status.textContent = `${releaseLabel(release)}. Check the changes below, then write them.`;
    } catch (error) { patches = []; status.textContent = plainError(error); }
    renderPreview();
    await showCover();
  }

  function renderResults(list) {
    const name = `${id}-rel`;
    results.replaceChildren(...list.map(r => {
      const radio = h('input', { type: 'radio', name, value: r.mbid, id: `${id}-r-${r.mbid}` });
      radio.addEventListener('change', () => { if (radio.checked) pick(r); });
      return h('div', { className: 'item origin' }, radio, h('label', { htmlFor: radio.id, style: 'color:inherit;font-size:inherit', textContent: releaseLabel(r) }));
    }));
  }

  search.addEventListener('click', async () => {
    refreshScope();
    patches = []; mbid = null; clearCover(); renderPreview();
    status.textContent = 'Searching MusicBrainz…';
    try {
      const list = await mb.searchRelease({ album: album.value, artist: artist.value });
      status.textContent = list.length ? `${list.length} release${list.length === 1 ? '' : 's'} found. Pick one to see the changes.` : 'MusicBrainz found no release by that name.';
      renderResults(list);
    } catch (error) { status.textContent = plainError(error); renderResults([]); }
  });
  withCover.addEventListener('change', renderPreview);
  write.addEventListener('click', async () => {
    const items = patchItems(patches, { coverFrom: withCover.checked ? mbid : null });
    write.disabled = true;
    try {
      const result = await writeTagPatches(ctx, items, { title: 'Write tags from MusicBrainz' });
      status.textContent = writeSummary(result);
    } catch (error) { status.textContent = plainError(error); }
    renderPreview();
  });

  const section = h('section', { 'aria-labelledby': `${id}-mb-h` },
    h('h3', { id: `${id}-mb-h`, textContent: 'Tags from MusicBrainz' }), scope,
    h('div', { className: 'row' },
      h('div', { className: 'f' }, h('label', { htmlFor: `${id}-album`, textContent: 'Album' }), album),
      h('div', { className: 'f' }, h('label', { htmlFor: `${id}-artist`, textContent: 'Artist' }), artist)),
    h('div', { className: 'row' }, search), status, results, cover, coverRow, preview, h('div', { className: 'row' }, write));
  return { section, refreshScope, reset: () => { album.value = ''; artist.value = ''; refreshScope(); }, destroy: clearCover };
}

// ----------------------------------------------------------------- LRCLIB ----

function lyricsSection(ctx, id, getPlayingId) {
  const lrclib = ctx.net?.lrclib ?? null;
  const fetchButton = h('button', { type: 'button', className: 'btn primary', textContent: 'Fetch lyrics from LRCLIB' });
  const saveButton = h('button', { type: 'button', className: 'btn', textContent: 'Save as .lrc beside the track', hidden: true });
  const scope = h('p', { className: 'hint' });
  const status = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const text = h('div', { className: 'lyrics', hidden: true, tabindex: '0', 'aria-label': 'Fetched lyrics' });
  let fetchedFor = null;

  const playing = () => { const pid = getPlayingId(); return pid == null ? null : ctx.library?.getTrack?.(pid) ?? null; };

  function refreshScope() {
    const t = playing();
    scope.textContent = t ? `For ${t.title || 'the playing track'}${t.artist ? ` by ${t.artist}` : ''}.` : 'Play a track first.';
    fetchButton.disabled = !t;
    if (t?.id !== fetchedFor) { text.hidden = true; saveButton.hidden = true; }
  }

  fetchButton.addEventListener('click', async () => {
    const t = playing();
    if (!t) return;
    status.textContent = 'Asking LRCLIB…';
    try {
      const raw = await runOr(ctx, 'lyrics.fetch', { id: String(t.id) }, () => lrclib.getLyrics(t));
      const lyrics = lyricsOf(raw);
      fetchedFor = t.id;
      if (!lyrics) { status.textContent = 'LRCLIB has no lyrics for this track.'; text.hidden = true; saveButton.hidden = true; return; }
      if (lyrics.instrumental) { status.textContent = 'LRCLIB lists this track as instrumental.'; text.hidden = true; saveButton.hidden = true; return; }
      text.textContent = lyrics.lines.map(l => l.text).join('\n');
      text.hidden = false;
      saveButton.hidden = !t.path;
      saveButton.textContent = `Save as ${sidecarName(t.path)}`;
      status.textContent = `${lyrics.synced ? 'Synced' : 'Plain'} lyrics from LRCLIB. Saving writes a new file beside the track; the audio file is not changed.`;
    } catch (error) { status.textContent = plainError(error); }
  });

  saveButton.addEventListener('click', async () => {
    const t = playing();
    if (!t || t.id !== fetchedFor) return;
    try {
      await ctx.run('lyrics.save_sidecar', { id: String(t.id) });
      status.textContent = `Saved ${sidecarName(t.path)}.`;
      saveButton.hidden = true;
    } catch (error) { status.textContent = plainError(error); }
  });

  const section = h('section', { 'aria-labelledby': `${id}-ly-h` },
    h('h3', { id: `${id}-ly-h`, textContent: 'Lyrics from LRCLIB' }), scope,
    h('div', { className: 'row' }, fetchButton, saveButton), status, text);
  return { section, refreshScope };
}

// ---------------------------------------------------------------- mount ----

export function mountNetworkPanel(root, ctx) {
  injectBaseCss();
  injectCss('v1x-network', CSS);
  const id = nextId('net');
  let ids = null;
  const getIds = () => (ids?.length ? ids : (ctx.selectedIds?.() ?? []));
  const getPlayingId = () => {
    try { const pid = ctx.state?.()?.playingId; if (pid != null) return pid; } catch { /* no shell state */ }
    try { return ctx.queue?.current?.() ?? null; } catch { return null; }
  };

  const origins = originsSection(ctx, id);
  const lb = listenBrainzSection(ctx, id);
  const mb = musicBrainzSection(ctx, id, getIds);
  const ly = lyricsSection(ctx, id, getPlayingId);
  const container = h('div', { className: 'nk-v1x nk-net' }, origins.section, lb.section, mb.section, ly.section);
  root.append(container);

  const offConsent = ctx.net?.consent?.onChange?.(() => lb.render());
  origins.render();
  lb.render();
  mb.refreshScope();
  ly.refreshScope();

  return {
    update(state) {
      if (state && Array.isArray(state.ids)) { ids = state.ids.map(String); mb.reset(); } else mb.refreshScope();
      origins.render();
      lb.render();
      ly.refreshScope();
    },
    destroy() {
      origins.destroy();
      mb.destroy();
      if (typeof offConsent === 'function') offConsent();
      container.remove();
    },
  };
}
