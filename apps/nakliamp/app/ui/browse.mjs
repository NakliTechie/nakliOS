// browse.mjs: the library browser panel (L6, L7, L8, L9, L12, Y2, Y4).
//
// A view switcher (songs, albums as a cover grid, artists, album artists, genres,
// years, folders, recently added and played, most played, favourites, rated,
// playlists and smart playlists), drill-in to tracks, fuzzy search, sort, star
// ratings and a favourite toggle per row, multi-select, a context menu and an
// action bar. The list is virtualised with a fixed row height, so only the rows in
// view (plus overscan) are in the DOM and 50,000 tracks stay usable.
//
// The pure parts (`computeView`, `groupTracks`, `virtualWindow`, `gridLayout`,
// `uniqueKeys`) are exported for tests; `mountBrowse` is the only DOM code.
// The panel acts through `ctx.run` commands wherever one exists.

import { browse, sortTracks, GROUP_VIEWS, LIST_VIEWS, SORT_KEYS } from '../library/views.mjs';
import { searchTracks, fuzzyScore } from '../library/search.mjs';
import { evaluateSmart } from '../library/smart.mjs';
import { trackNumberLabel } from '../library/store.mjs';
import { createSelection } from './select.mjs';

// ------------------------------------------------------------------ pure ----

export const VIEWS = Object.freeze([
  { id: 'tracks', label: 'Songs' },
  { id: 'albums', label: 'Albums' },
  { id: 'artists', label: 'Artists' },
  { id: 'albumArtists', label: 'Album artists' },
  { id: 'genres', label: 'Genres' },
  { id: 'years', label: 'Years' },
  { id: 'folders', label: 'Folders' },
  { id: 'recentlyAdded', label: 'Recently added' },
  { id: 'recentlyPlayed', label: 'Recently played' },
  { id: 'mostPlayed', label: 'Most played' },
  { id: 'favourites', label: 'Favourites' },
  { id: 'rated', label: 'Rated' },
  { id: 'playlists', label: 'Playlists' },
]);
const VIEW_IDS = VIEWS.map(view => view.id);

export const SORT_LABELS = Object.freeze({
  title: 'Title', artist: 'Artist', album: 'Album', year: 'Year', addedAt: 'Date added',
  playCount: 'Play count', lastPlayedAt: 'Last played', rating: 'Rating', durationS: 'Duration',
});

const UNKNOWN_LABEL = Object.freeze({
  albums: 'Unknown album', artists: 'Unknown artist', albumArtists: 'Unknown artist',
  genres: 'No genre', years: 'No year', folders: 'Folder root', playlists: 'Untitled',
});

/** True for views whose top level is a list of groups. */
export const isGroupView = view => GROUP_VIEWS.includes(view) || view === 'playlists';

/**
 * Keys that are unique within a list, so the same track can sit in a playlist
 * twice and each row still has its own identity. The first occurrence keeps the
 * plain id; later ones get `id#n`.
 */
export function uniqueKeys(ids) {
  const seen = new Map();
  return ids.map(id => {
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    return count ? `${id}#${count}` : String(id);
  });
}

/** Playlist and smart playlist group rows, plus the lookup that resolves them. */
function playlistGroups(tracks, playlists, smartPlaylists, now) {
  const rows = [];
  for (const playlist of playlists ?? []) {
    rows.push({
      key: `p:${playlist.path}`, label: playlist.name || null, kind: 'playlist', path: playlist.path,
      format: playlist.format, trackCount: playlist.entries?.length ?? 0, artKey: null,
    });
  }
  for (const smart of smartPlaylists ?? []) {
    let count = 0;
    try { count = evaluateSmart(smart.rule, tracks, { now }).length; } catch { count = 0; }
    rows.push({ key: `s:${smart.path}`, label: smart.rule?.name || null, kind: 'smart', path: smart.path, rule: smart.rule, trackCount: count, artKey: null });
  }
  return rows.sort((left, right) => String(left.label ?? '').localeCompare(String(right.label ?? ''), undefined, { sensitivity: 'base', numeric: true }));
}

/**
 * The tracks behind one group row: an album, an artist, a playlist (entries in
 * playlist order, unresolved entries counted in `missing`) or a smart playlist.
 */
function smartGroupTracks(tracks, key, smartPlaylists, now) {
  const smart = smartPlaylists.find(row => `s:${row.path}` === key);
  if (!smart) return { tracks: [], missing: 0 };
  try { return { tracks: evaluateSmart(smart.rule, tracks, { now }), missing: 0 }; } catch { return { tracks: [], missing: 0 }; }
}

export function groupTracks(tracks, view, key, { playlists = [], smartPlaylists = [], now = Date.now() } = {}) {
  if (view !== 'playlists') return { tracks: browse(tracks, { by: view, key }), missing: 0 };
  if (key.startsWith('s:')) return smartGroupTracks(tracks, key, smartPlaylists, now);
  const playlist = playlists.find(row => `p:${row.path}` === key);
  if (!playlist) return { tracks: [], missing: 0 };
  const byPath = new Map(tracks.map(track => [track.path, track]));
  const found = [];
  let missing = 0;
  for (const entry of playlist.entries ?? []) {
    const track = entry.path ? byPath.get(entry.path) : null;
    if (track) found.push(track); else missing += 1;
  }
  return { tracks: found, missing };
}

function searchGroups(rows, text, view) {
  const scored = [];
  for (const row of rows) {
    const label = row.label ?? UNKNOWN_LABEL[view];
    const score = Math.max(fuzzyScore(text, label) ?? -1, fuzzyScore(text, row.albumArtist) ?? -1);
    if (score >= 0) scored.push({ row, score });
  }
  return scored.sort((left, right) => right.score - left.score).map(entry => entry.row);
}

function viewTracks(tracks, view, drill, options) {
  if (view === 'tracks') return { tracks: sortTracks(tracks, 'artist', 'asc'), missing: 0 };
  if (LIST_VIEWS.includes(view)) return { tracks: browse(tracks, { by: view }), missing: 0 };
  return groupTracks(tracks, view, drill.key, options);
}

/**
 * Everything the list shows for one state of the panel.
 *
 * Returns `{ kind: 'groups'|'tracks', rows, keys, missing, ordered }`:
 * - group level of a group view: group rows, filtered by the search text against
 *   the group label (and album artist for albums);
 * - otherwise tracks: the view's list, or the drilled group's tracks, ranked by
 *   the search text, then sorted when a sort key is set.
 * `ordered` is true when the order is deliberate (a playlist) and no sort or
 * search has replaced it.
 */
export function computeView(tracks, options) {
  const state = viewState(options);
  if (!VIEW_IDS.includes(state.view)) throw new RangeError(`Unknown view: ${String(state.view)}`);
  return isGroupView(state.view) && !state.drill ? groupLevelView(tracks, state) : trackLevelView(tracks, state);
}

function viewState({
  view = 'albums', drill = null, query = '', sort = null,
  playlists = [], smartPlaylists = [], now = Date.now(),
} = {}) {
  return { view, drill, text: String(query ?? '').trim(), sort, playlists, smartPlaylists, now };
}

/** Views whose untagged group ("Unknown album", "No genre") sorts last, not first. */
const UNKNOWN_LAST = new Set(['albums', 'artists', 'albumArtists', 'genres']);

/** A stable copy with the groups that have no label moved to the end. */
export function unknownLast(rows) {
  return [...rows.filter(row => row.label != null), ...rows.filter(row => row.label == null)];
}

function groupLevelView(tracks, { view, text, playlists, smartPlaylists, now }) {
  let groups = view === 'playlists'
    ? playlistGroups(tracks, playlists, smartPlaylists, now)
    : browse(tracks, { by: view });
  if (UNKNOWN_LAST.has(view)) groups = unknownLast(groups);
  const rows = text ? searchGroups(groups, text, view) : groups;
  return { kind: 'groups', rows, keys: rows.map(row => `g:${row.key}`), missing: 0, ordered: false };
}

function trackLevelView(tracks, { view, drill, text, sort, playlists, smartPlaylists, now }) {
  let { tracks: rows, missing } = viewTracks(tracks, view, drill, { playlists, smartPlaylists, now });
  if (text) rows = searchTracks(rows, text);
  if (sort && SORT_KEYS.includes(sort.key)) rows = sortTracks(rows, sort.key, sort.direction === 'desc' ? 'desc' : 'asc');
  const ordered = view === 'playlists' && !text && !sort;
  return { kind: 'tracks', rows, keys: uniqueKeys(rows.map(row => row.id)), missing, ordered };
}

/**
 * The rows to render for a scroll position: `start` (inclusive) to `end`
 * (exclusive), the top offset of the first one, and the full scroll height.
 */
export function virtualWindow({ scrollTop = 0, viewportHeight = 0, rowHeight, count, overscan = 8 }) {
  if (!(rowHeight > 0) || count <= 0) return { start: 0, end: 0, offset: 0, total: 0 };
  const top = Math.max(0, scrollTop);
  const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((top + Math.max(0, viewportHeight)) / rowHeight) + overscan);
  const start = Math.min(first, count);
  return { start, end: Math.max(start, last), offset: start * rowHeight, total: count * rowHeight };
}

/** Columns for a cover grid: as many cells of at least `minCell` px as fit `width`. */
export function gridLayout({ width, minCell = 140, gap = 14, count = 0, captionHeight = 52 }) {
  const usable = Math.max(minCell, width);
  const columns = Math.max(1, Math.floor((usable + gap) / (minCell + gap)));
  const cellWidth = Math.floor((usable - gap * (columns - 1)) / columns);
  const rowHeight = cellWidth + captionHeight + gap;
  return { columns, cellWidth, rowHeight, rows: Math.ceil(count / columns) };
}

function arrowStep(key, columns, page) {
  const sideways = columns > 1 ? 1 : 0;
  return {
    ArrowDown: columns, ArrowUp: -columns, ArrowRight: sideways, ArrowLeft: -sideways,
    PageDown: page * columns, PageUp: -page * columns,
  }[key];
}

/** The cursor index after an arrow key in a list (columns = 1) or a grid. */
export function arrowTarget(key, cursor, { count, columns = 1, page = 10 }) {
  if (count <= 0) return -1;
  const from = cursor < 0 ? -1 : cursor;
  const step = arrowStep(key, columns, page);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (step === undefined || step === 0) return from;
  if (from < 0) return step > 0 ? 0 : count - 1;
  return Math.max(0, Math.min(count - 1, from + step));
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const whole = Math.round(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = String(whole % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

// ------------------------------------------------------------------- DOM ----

const CSS = `
.nb{display:flex;flex-direction:column;gap:10px;width:100%;max-width:1080px;margin:auto;min-width:0;flex:1 1 auto;color:var(--ink,var(--text))}
.nb-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.nb-head label{display:flex;align-items:center;gap:6px;font:12px var(--body);color:var(--muted)}
.nb select,.nb input[type=search],.nb input[type=text]{min-height:36px;padding:6px 10px;border:1px solid var(--line);border-radius:9px;background:var(--panel);color:var(--ink,var(--text));font:12px var(--body);max-width:100%}
.nb input[type=search]{flex:1 1 180px;min-width:0}
.nb button{font:inherit;color:inherit}
.nb-btn{min-height:34px;padding:5px 11px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);cursor:pointer;font:500 13px var(--body)!important;white-space:nowrap}
.nb-btn:hover{border-color:var(--accent)}
.nb-btn[disabled]{opacity:.45;cursor:default}
.nb-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,var(--bg))}
.nb-crumb{display:flex;align-items:center;gap:8px;min-width:0}
.nb-crumb[hidden]{display:none}
.nb-crumb h3{margin:0;font:600 15px var(--body);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.nb-count{font:12px var(--body);color:var(--faint,var(--muted))}
.nb-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;min-height:48px;padding:6px 8px;border:1px solid var(--line);border-radius:10px;background:var(--panel-2)}
.nb-bar[hidden]{display:none}
.nb-bar.idle{background:transparent;border-style:dashed}
.nb-bar.idle [data-act]{display:none}
.nb-hint{font-size:12px;color:var(--faint,var(--muted))}
.nb-hint[hidden]{display:none}
.nb-album{display:grid;grid-template-columns:auto minmax(0,1fr);gap:16px;align-items:end}
.nb-album[hidden]{display:none}
.nb-album .nb-album-art{width:132px;height:132px;border-radius:12px;object-fit:cover;border:1px solid var(--line);background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 55%,var(--panel-2)),var(--panel-2))}
.nb-album h3{margin:0 0 4px;font:700 22px/1.15 var(--display,var(--body));letter-spacing:-.02em;overflow-wrap:anywhere}
.nb-album .nb-album-meta{margin:0 0 12px;color:var(--muted);font-size:13px}
.nb-album .nb-album-actions{display:flex;gap:8px;flex-wrap:wrap}
.nb-album .nb-album-actions .nb-btn{min-height:38px;padding:7px 16px;font:600 13px var(--body)!important}
.nb-no{width:24px;flex:none;text-align:right;font:11px var(--mono);color:var(--faint,var(--muted))}
.nb-bar .nb-count{margin-right:auto}
.nb-scroll{position:relative;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:var(--nakliamp-list-min,0px);height:var(--nakliamp-list-height,max(320px,calc(100dvh - 330px)));border:1px solid var(--line);border-radius:var(--radius,14px);background:var(--panel);outline:none}
.nb-scroll:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.nb-spacer{position:relative;width:100%}
.nb-window{position:absolute;left:0;right:0;top:0}
.nb-row{display:flex;align-items:center;gap:10px;height:52px;padding:0 12px;border-bottom:1px solid var(--line);cursor:default;user-select:none;min-width:0}
.nb-row:hover{background:var(--panel-2)}
.nb-row[aria-selected=true]{background:color-mix(in srgb,var(--accent) 16%,transparent)}
.nb-row.cursor{box-shadow:inset 3px 0 0 var(--accent)}
.nb-row.playing .nb-title{color:var(--accent)}
.nb-cover{width:34px;height:34px;border-radius:7px;flex:none;object-fit:cover;background:var(--panel-2);border:1px solid var(--line)}
.nb-who{flex:1;min-width:0}
.nb-title{display:block;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-sub{display:block;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nb-dur{font:11px var(--mono);color:var(--faint,var(--muted));flex:none;width:44px;text-align:right}
.nb-stars{display:flex;flex:none}
.nb-star,.nb-fav,.nb-more{width:22px;height:26px;border:0;background:none;padding:0;cursor:pointer;color:var(--faint,var(--muted));font-size:14px;line-height:1}
.nb-star.on,.nb-fav.on{color:var(--accent)}
.nb-star:hover,.nb-fav:hover,.nb-more:hover{color:var(--ink,var(--text))}
.nb-grid{display:grid;gap:14px;padding:14px}
.nb-card{display:flex;flex-direction:column;gap:5px;min-width:0;padding:6px;border-radius:12px;cursor:pointer;user-select:none}
.nb-card:hover{background:var(--panel-2)}
.nb-card[aria-selected=true]{background:color-mix(in srgb,var(--accent) 16%,transparent)}
.nb-card.cursor{box-shadow:0 0 0 2px var(--accent)}
.nb-card .nb-art{width:100%;aspect-ratio:1;border-radius:9px;object-fit:cover;background:linear-gradient(145deg,color-mix(in srgb,var(--accent) 55%,var(--panel-2)),var(--panel-2));border:1px solid var(--line)}
.nb-empty{padding:28px 16px;text-align:center;color:var(--muted)}
.nb-note{font-size:12px;color:var(--faint,var(--muted));margin:0}
.nb-note:empty{display:none}
.nb-menu{position:fixed;z-index:60;min-width:200px;max-width:min(300px,calc(100vw - 16px));max-height:min(420px,calc(100vh - 16px));overflow-y:auto;padding:5px;border:1px solid var(--line);border-radius:10px;background:var(--panel);box-shadow:0 18px 50px rgba(0,0,0,.35)}
.nb-menu[hidden]{display:none}
.nb-menu [role=menuitem]{display:block;width:100%;text-align:left;padding:7px 10px;border:0;border-radius:7px;background:none;cursor:pointer;font:13px var(--body);color:var(--ink,var(--text))}
.nb-menu [role=menuitem]:hover,.nb-menu [role=menuitem]:focus-visible{background:var(--panel-2);outline:none}
.nb-menu [role=menuitem][aria-disabled=true]{opacity:.45;cursor:default}
.nb-menu hr{border:0;border-top:1px solid var(--line);margin:4px 0}
.nb-menu form{display:flex;gap:6px;padding:6px}
.nb-menu form input{flex:1;min-width:0}
.nb-menu .nb-menu-title{padding:5px 10px;font:12px var(--body);color:var(--faint,var(--muted))}
@media(max-width:560px){.nb-stars,.nb-dur{display:none}.nb-row{gap:8px;padding:0 8px}.nb-bar.idle{display:none}.nb-album .nb-album-art{width:88px;height:88px}.nb-album h3{font-size:18px}}
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

const BROWSE_NAV_KEYS = ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'PageDown', 'PageUp', 'Home', 'End'];
const isModKey = event => event.metaKey || event.ctrlKey;
const stopKey = event => { event.preventDefault(); event.stopPropagation(); };
/** Keys that do nothing in the list while Alt is held. */
const altBlocked = key => key === ' ' || key === 'a' || key === 'A' || BROWSE_NAV_KEYS.includes(key);

function injectCss(id, css) {
  if (typeof document === 'undefined' || document.getElementById(id)) return;
  document.head.append(el('style', { id, text: css }));
}

const errorText = error => String(error?.message ?? error ?? 'Something went wrong.');

/**
 * Mount the library browser.
 * Returns `{ update(state), destroy(), selectedIds(), setView(view), focusSearch(), focusList() }`.
 * `update` accepts `{ view?, query?, playingId? }` and always re-reads the library.
 */
export function mountBrowse(root, ctx) {
  injectCss('nakliamp-css-browse', CSS);
  const uid = `nb${++instance}`;
  const ROW_HEIGHT = 52;
  const state = { view: 'albums', drill: null, query: '', sort: null, playingId: null };
  const selection = createSelection();
  const art = new Map(); // art key -> url string | null | Promise
  let data = { kind: 'groups', rows: [], keys: [], missing: 0, ordered: false };
  let tracksCache = [];
  let layout = { columns: 1, cellWidth: 0, rowHeight: ROW_HEIGHT, rows: 0 };
  let frame = 0;
  let searchTimer = 0;
  let menuReturnFocus = null;
  const cleanups = [];

  // ---- skeleton ----
  const viewSelect = el('select', { 'aria-label': 'Library view' },
    VIEWS.map(view => el('option', { value: view.id, text: view.label })));
  const search = el('input', { type: 'search', placeholder: 'Search this view', 'aria-label': 'Search this view', autocomplete: 'off', spellcheck: 'false' });
  const sortSelect = el('select', { 'aria-label': 'Sort by' },
    el('option', { value: '', text: 'Default order' }),
    SORT_KEYS.map(key => el('option', { value: key, text: SORT_LABELS[key] })));
  const directionButton = el('button', { type: 'button', class: 'nb-btn', 'aria-label': 'Sort direction: ascending', title: 'Sort direction' }, 'A to Z');
  const newSmartButton = el('button', { type: 'button', class: 'nb-btn', hidden: true }, 'New smart playlist');
  const head = el('div', { class: 'nb-head' },
    el('label', {}, 'View', viewSelect), search,
    el('label', {}, 'Sort', sortSelect), directionButton, newSmartButton);

  const backButton = el('button', { type: 'button', class: 'nb-btn', 'aria-label': 'Back to the list of groups' }, 'Back');
  const crumbTitle = el('h3', { id: `${uid}-title` });
  const editSmartButton = el('button', { type: 'button', class: 'nb-btn', hidden: true }, 'Edit rules');
  const crumb = el('div', { class: 'nb-crumb', hidden: true }, backButton, crumbTitle, editSmartButton);

  // The album page header (M4): cover, title, artist, year, count, length, Play and Shuffle.
  const albumArt = el('img', { class: 'nb-album-art', alt: '' });
  const albumTitle = el('h3', {});
  const albumMeta = el('p', { class: 'nb-album-meta' });
  const albumPlay = el('button', { type: 'button', class: 'nb-btn primary' }, 'Play');
  const albumShuffle = el('button', { type: 'button', class: 'nb-btn' }, 'Shuffle');
  const albumHead = el('div', { class: 'nb-album', hidden: true }, albumArt,
    el('div', {}, albumTitle, albumMeta, el('div', { class: 'nb-album-actions' }, albumPlay, albumShuffle)));

  const selectedCount = el('span', { class: 'nb-count', 'aria-live': 'polite' });
  // The bar keeps its place when nothing is selected, so selecting a row does
  // not push the list down (M4); it then says how the list works.
  const hint = el('span', { class: 'nb-hint' }, 'Click to select, double-click or Enter to play, right-click for more.');
  const bar = el('div', { class: 'nb-bar idle', role: 'toolbar', 'aria-label': 'Selection actions' }, hint, selectedCount,
    el('button', { type: 'button', class: 'nb-btn primary', 'data-act': 'play' }, 'Play'),
    el('button', { type: 'button', class: 'nb-btn', 'data-act': 'next' }, 'Play next'),
    el('button', { type: 'button', class: 'nb-btn', 'data-act': 'queue' }, 'Add to queue'),
    el('button', { type: 'button', class: 'nb-btn', 'data-act': 'playlist', 'aria-haspopup': 'menu' }, 'Add to playlist'),
    el('button', { type: 'button', class: 'nb-btn', 'data-act': 'tags' }, 'Edit tags'),
    el('button', { type: 'button', class: 'nb-btn', 'data-act': 'inspector' }, 'Inspector'),
    el('button', { type: 'button', class: 'nb-btn', 'data-act': 'menu', 'aria-haspopup': 'menu', 'aria-label': 'More actions' }, 'More'));

  const summary = el('p', { class: 'nb-note', 'aria-live': 'polite' });
  const windowEl = el('div', { class: 'nb-window', role: 'presentation' });
  const spacer = el('div', { class: 'nb-spacer', role: 'presentation' }, windowEl);
  const scroller = el('div', {
    class: 'nb-scroll', tabindex: '0', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Library',
  }, spacer);
  const menu = el('div', { class: 'nb-menu', role: 'menu', hidden: true, 'aria-label': 'Track actions' });
  const panel = el('section', { class: 'nb', 'aria-label': 'Library browser' }, head, crumb, albumHead, bar, summary, scroller, menu);
  root.replaceChildren(panel);

  // ---- data ----
  function libraryTracks() {
    try { return ctx.library?.tracks?.() ?? []; } catch { return []; }
  }
  function playlists() {
    try { return ctx.library?.playlists?.() ?? []; } catch { return []; }
  }
  function smartPlaylists() {
    try { return ctx.library?.smartPlaylists?.() ?? []; } catch { return []; }
  }

  function recompute() {
    tracksCache = libraryTracks();
    try {
      data = computeView(tracksCache, {
        view: state.view, drill: state.drill, query: state.query, sort: state.sort,
        playlists: playlists(), smartPlaylists: smartPlaylists(),
      });
    } catch (error) {
      data = { kind: 'tracks', rows: [], keys: [], missing: 0, ordered: false };
      summary.textContent = errorText(error);
    }
    selection.setOrder(data.keys);
    paintChrome();
    measure();
    render();
  }

  function isGrid() {
    return data.kind === 'groups' && state.view === 'albums';
  }

  function measure() {
    const width = Math.max(0, (scroller.clientWidth || 600) - 28);
    layout = isGrid()
      ? gridLayout({ width, count: data.rows.length })
      : { columns: 1, cellWidth: 0, rowHeight: ROW_HEIGHT, rows: data.rows.length };
  }

  // ---- chrome ----
  function paintSortControls(groups) {
    sortSelect.disabled = groups;
    directionButton.disabled = groups || !state.sort;
    sortSelect.value = state.sort?.key ?? '';
    const descending = state.sort?.direction === 'desc';
    directionButton.textContent = descending ? 'Z to A' : 'A to Z';
    directionButton.setAttribute('aria-label', `Sort direction: ${descending ? 'descending' : 'ascending'}`);
  }

  function paintCrumb() {
    newSmartButton.hidden = !(state.view === 'playlists' && !state.drill);
    crumb.hidden = !state.drill;
    if (state.drill) crumbTitle.textContent = state.drill.label;
    editSmartButton.hidden = !(state.drill?.kind === 'smart');
    const label = VIEWS.find(view => view.id === state.view)?.label ?? 'Library';
    scroller.setAttribute('aria-label', state.drill ? `${label}: ${state.drill.label}` : label);
    paintAlbumHead();
  }

  function isAlbumPage() {
    return state.view === 'albums' && Boolean(state.drill) && data.kind === 'tracks';
  }

  function albumMetaText(row) {
    const total = data.rows.reduce((sum, track) => sum + (Number.isFinite(track.durationS) ? track.durationS : 0), 0);
    const count = data.rows.length;
    return [row.albumArtist, row.year ? String(row.year) : null, `${count} track${count === 1 ? '' : 's'}`, total ? formatDuration(total) : null]
      .filter(Boolean).join(' · ');
  }

  function paintAlbumArt(row) {
    const key = artKeyOf(row) ?? '';
    if (albumArt.dataset.art !== key) albumArt.removeAttribute('src');
    albumArt.dataset.art = key;
    if (!key) return;
    const lookup = row.id ? row : { artKey: row.artKey ?? null, dirArtKey: row.dirArtKey ?? null };
    Promise.resolve(ctx.artUrl?.(lookup) ?? null)
      .catch(() => null)
      .then(url => { if (url && albumArt.dataset.art === key) albumArt.src = url; });
  }

  function paintAlbumHead() {
    const album = isAlbumPage();
    albumHead.hidden = !album;
    if (!album) return;
    const row = state.drill.row ?? {};
    albumTitle.textContent = state.drill.label;
    albumMeta.textContent = albumMetaText(row);
    paintAlbumArt(row);
    albumPlay.setAttribute('aria-label', `Play ${state.drill.label}`);
    albumShuffle.setAttribute('aria-label', `Shuffle ${state.drill.label}`);
  }

  function summaryText(groups) {
    const count = data.rows.length;
    const noun = groups ? (state.view === 'playlists' ? 'playlist' : 'group') : 'track';
    let text = `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
    if (data.missing) text += `; ${data.missing} playlist entr${data.missing === 1 ? 'y is' : 'ies are'} not in this folder`;
    return text;
  }

  function paintChrome() {
    viewSelect.value = state.view;
    const groups = data.kind === 'groups';
    paintSortControls(groups);
    paintCrumb();
    summary.textContent = summaryText(groups);
    paintBar();
  }

  function paintBar() {
    const size = selection.size;
    bar.classList.toggle('idle', size === 0);
    hint.hidden = size !== 0;
    selectedCount.textContent = size ? `${size.toLocaleString()} selected` : '';
    const trackLevel = data.kind === 'tracks';
    for (const button of bar.querySelectorAll('[data-act=inspector]')) button.disabled = !(trackLevel && size === 1);
  }

  // ---- rendering ----
  function displayLabel(row) {
    return row.label ?? UNKNOWN_LABEL[state.view] ?? 'Unknown';
  }

  function groupSubtitle(row) {
    const parts = [];
    if (state.view === 'albums') {
      if (row.albumArtist) parts.push(row.albumArtist);
      if (row.year) parts.push(String(row.year));
    } else if (row.kind === 'smart') parts.push('Smart playlist');
    else if (row.kind === 'playlist') parts.push(`${String(row.format ?? 'm3u').toUpperCase()} playlist`);
    else if (row.albumCount > 1) parts.push(`${row.albumCount} albums`);
    parts.push(`${row.trackCount} track${row.trackCount === 1 ? '' : 's'}`);
    if (row.durationS) parts.push(formatDuration(row.durationS));
    return parts.join(' · ');
  }

  function artKeyOf(row) {
    return row.artKey ?? row.dirArtKey ?? null;
  }

  function coverImage(row, className, alt) {
    const image = el('img', { class: className, alt, loading: 'lazy', decoding: 'async' });
    // A cover URL that no longer loads shows the plain tile, never a broken-image icon (minor 10).
    image.addEventListener('error', () => { image.removeAttribute('src'); art.delete(image.dataset.art); }, { once: true });
    const key = artKeyOf(row);
    if (!key) return image;
    const known = art.get(key);
    if (typeof known === 'string') image.src = known;
    else if (known === undefined || known instanceof Promise) {
      image.dataset.art = key;
      // Without IntersectionObserver every rendered row is already near view.
      if (observer) observer.observe(image); else queueMicrotask(() => loadArt(image));
    }
    return image;
  }

  function loadArt(image) {
    const key = image.dataset.art;
    if (!key) return;
    let pending = art.get(key);
    if (pending === undefined) {
      const row = data.rows.find(candidate => artKeyOf(candidate) === key) ?? { artKey: key };
      pending = Promise.resolve()
        .then(() => ctx.artUrl?.(row.id ? row : { artKey: key, dirArtKey: null }) ?? null)
        .catch(() => null)
        .then(url => { art.set(key, url ?? null); return url ?? null; });
      art.set(key, pending);
    }
    Promise.resolve(pending).then(url => {
      if (url && image.isConnected && image.dataset.art === key) image.src = url;
    });
  }

  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        loadArt(entry.target);
      }
    }, { root: scroller, rootMargin: '200px' })
    : null;

  /** A track number on an album page (M4), the cover everywhere else. */
  function leadCell(track, albumPage) {
    if (!albumPage) return coverImage(track, 'nb-cover', '');
    return el('span', { class: 'nb-no', 'aria-hidden': 'true', text: trackNumberLabel(track.trackNo) });
  }

  function trackRow(track, index) {
    const key = data.keys[index];
    const selected = selection.has(key);
    const rating = track.rating ?? 0;
    const title = track.title ?? track.name ?? 'Untitled';
    const sub = [track.artist || track.albumArtist, track.album].filter(Boolean).join(' · ');
    const stars = el('span', { class: 'nb-stars', role: 'group', 'aria-label': `Rating: ${rating} of 5` },
      [1, 2, 3, 4, 5].map(stars => el('button', {
        type: 'button', tabindex: '-1', class: `nb-star${stars <= rating ? ' on' : ''}`,
        'data-rate': String(stars), 'aria-label': stars === rating ? `Clear the ${stars} star rating` : `Rate ${stars} star${stars === 1 ? '' : 's'}`,
        title: `${stars} star${stars === 1 ? '' : 's'}`,
      }, stars <= rating ? '★' : '☆')));
    const favourite = Boolean(track.bookmarked);
    const albumPage = isAlbumPage();
    const row = el('div', {
      class: `nb-row${index === selection.cursor ? ' cursor' : ''}${track.id === state.playingId ? ' playing' : ''}`,
      role: 'option', id: `${uid}-r${index}`, 'aria-selected': String(selected), 'data-index': String(index),
      'aria-posinset': String(index + 1), 'aria-setsize': String(data.rows.length),
      'aria-current': track.id === state.playingId ? 'true' : null,
    },
    leadCell(track, albumPage),
    el('span', { class: 'nb-who' }, el('span', { class: 'nb-title', text: title }), el('span', { class: 'nb-sub', text: sub })),
    stars,
    el('button', {
      type: 'button', tabindex: '-1', class: `nb-fav${favourite ? ' on' : ''}`, 'data-fav': '1',
      'aria-pressed': String(favourite), 'aria-label': favourite ? `Remove ${title} from favourites` : `Add ${title} to favourites`,
    }, favourite ? '♥' : '♡'),
    el('span', { class: 'nb-dur', text: formatDuration(track.durationS) }),
    el('button', { type: 'button', tabindex: '-1', class: 'nb-more', 'data-more': '1', 'aria-label': `Actions for ${title}`, 'aria-haspopup': 'menu' }, '⋮'));
    return row;
  }

  function groupRow(group, index) {
    const label = displayLabel(group);
    return el('div', {
      class: `nb-row${index === selection.cursor ? ' cursor' : ''}`, role: 'option', id: `${uid}-r${index}`,
      'aria-selected': String(selection.has(data.keys[index])), 'data-index': String(index),
      'aria-posinset': String(index + 1), 'aria-setsize': String(data.rows.length),
    },
    state.view === 'playlists' ? null : coverImage(group, 'nb-cover', ''),
    el('span', { class: 'nb-who' }, el('span', { class: 'nb-title', text: label }), el('span', { class: 'nb-sub', text: groupSubtitle(group) })),
    el('button', { type: 'button', tabindex: '-1', class: 'nb-more', 'data-more': '1', 'aria-label': `Actions for ${label}`, 'aria-haspopup': 'menu' }, '⋮'));
  }

  function albumCard(group, index) {
    const label = displayLabel(group);
    return el('div', {
      class: `nb-card${index === selection.cursor ? ' cursor' : ''}`, role: 'option', id: `${uid}-r${index}`,
      'aria-selected': String(selection.has(data.keys[index])), 'data-index': String(index),
      'aria-posinset': String(index + 1), 'aria-setsize': String(data.rows.length),
      'aria-label': `${label}${group.albumArtist ? `, ${group.albumArtist}` : ''}`,
    },
    coverImage(group, 'nb-art', ''),
    el('span', { class: 'nb-title', text: label }),
    el('span', { class: 'nb-sub', text: [group.albumArtist, group.year].filter(Boolean).join(' · ') }));
  }

  function emptyText() {
    if (!tracksCache.length) return 'No music indexed yet. Choose a music folder to start.';
    return state.query ? 'Nothing in this view matches your search.' : 'Nothing in this view yet.';
  }

  function renderEmpty() {
    spacer.style.height = 'auto';
    windowEl.style.transform = '';
    windowEl.style.position = 'static';
    windowEl.replaceChildren(el('div', { class: 'nb-empty', role: 'presentation', text: emptyText() }));
    scroller.removeAttribute('aria-activedescendant');
  }

  function gridNodes(span, count) {
    const gridEl = el('div', { class: 'nb-grid', role: 'presentation' });
    gridEl.style.gridTemplateColumns = `repeat(${layout.columns}, minmax(0, 1fr))`;
    const from = span.start * layout.columns;
    const to = Math.min(count, span.end * layout.columns);
    for (let index = from; index < to; index++) gridEl.append(albumCard(data.rows[index], index));
    return [gridEl];
  }

  function listNodes(span) {
    const nodes = [];
    for (let index = span.start; index < span.end; index++) {
      nodes.push(data.kind === 'tracks' ? trackRow(data.rows[index], index) : groupRow(data.rows[index], index));
    }
    return nodes;
  }

  function paintActiveDescendant() {
    const cursor = selection.cursor;
    if (cursor >= 0 && windowEl.querySelector(`#${uid}-r${cursor}`)) scroller.setAttribute('aria-activedescendant', `${uid}-r${cursor}`);
    else scroller.removeAttribute('aria-activedescendant');
  }

  function render() {
    frame = 0;
    const count = data.rows.length;
    if (!count) {
      renderEmpty();
      return;
    }
    windowEl.style.position = '';
    const grid = isGrid();
    const lineCount = grid ? layout.rows : count;
    const span = virtualWindow({
      scrollTop: scroller.scrollTop - (grid ? 14 : 0), viewportHeight: scroller.clientHeight || 600,
      rowHeight: layout.rowHeight, count: lineCount, overscan: grid ? 2 : 8,
    });
    spacer.style.height = `${span.total + (grid ? 28 : 0)}px`;
    windowEl.style.transform = `translateY(${span.offset}px)`;
    windowEl.replaceChildren(...(grid ? gridNodes(span, count) : listNodes(span)));
    paintActiveDescendant();
  }

  function scheduleRender() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  /** Scroll so row `index` is fully in view. */
  function reveal(index) {
    if (index < 0) return;
    const grid = isGrid();
    const line = grid ? Math.floor(index / layout.columns) : index;
    const top = line * layout.rowHeight + (grid ? 14 : 0);
    const bottom = top + layout.rowHeight;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  }

  // ---- what a selection means ----
  function rowTracks(index) {
    const row = data.rows[index];
    if (!row) return [];
    if (data.kind === 'tracks') return [row];
    return groupTracks(tracksCache, state.view, row.key, { playlists: playlists(), smartPlaylists: smartPlaylists() }).tracks;
  }

  /** Track ids behind the selection (groups expand to their tracks), in list order. */
  function selectedIds() {
    const ids = [];
    for (const index of selection.selectedIndices()) for (const track of rowTracks(index)) ids.push(track.id);
    return ids;
  }

  function idsForAction() {
    if (selection.size) return selectedIds();
    const cursor = selection.cursor;
    return cursor >= 0 ? rowTracks(cursor).map(track => track.id) : [];
  }

  async function act(name, input, done) {
    try {
      const result = await ctx.run(name, input);
      if (done) ctx.toast?.(typeof done === 'function' ? done(result) : done);
      return result;
    } catch (error) {
      ctx.toast?.(errorText(error));
      return undefined;
    } finally {
      recompute();
    }
  }

  // The saved playlist a play starts from, so the snapshot can name it (smart playlists too).
  function sourcePlaylist(index) {
    if (state.view !== 'playlists') return {};
    if (state.drill) return { playlist: state.drill.label };
    const row = data.rows[index];
    return row ? { playlist: displayLabel(row) } : {};
  }

  function playFrom(index) {
    if (data.kind === 'tracks') {
      const ids = data.rows.map(track => track.id);
      ctx.playTracks?.(ids, Math.max(0, index), sourcePlaylist(index));
    } else {
      const ids = rowTracks(index).map(track => track.id);
      if (ids.length) ctx.playTracks?.(ids, 0, sourcePlaylist(index));
    }
  }

  function playSelection() {
    if (data.kind === 'tracks' && selection.size <= 1) return playFrom(selection.cursor >= 0 ? selection.cursor : 0);
    const ids = idsForAction();
    if (ids.length) ctx.playTracks?.(ids, 0);
  }

  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

  const ACTIONS = new Map([
    ['play', () => playSelection()],
    ['next', ids => act('queue.play_next', { ids }, `${plural(ids.length, 'track')} will play next`)],
    ['queue', ids => act('queue.add', { ids }, `Added ${plural(ids.length, 'track')} to the queue`)],
    ['tags', ids => ctx.open?.('tags', ids)],
    ['inspector', ids => ctx.open?.('inspector', ids[0])],
    ['rate', (ids, extra) => act('track.rate', { ids, rating: extra.rating })],
    ['favourite', (ids, extra) => act('track.favourite', { ids, favourite: extra.favourite })],
    ['add-playlist', (ids, extra) => act('playlist.add', { name: extra.name, ids }, `Added ${plural(ids.length, 'track')} to ${extra.name}`)],
    ['new-playlist', (ids, extra) => act('playlist.create', { name: extra.name, ids }, `Created ${extra.name}`)],
  ]);

  function runAction(action, extra = {}) {
    const ids = extra.ids ?? idsForAction();
    if (!ids.length && action !== 'smart-new') return undefined;
    return ACTIONS.get(action)?.(ids, extra);
  }

  // ---- context menu ----
  function closeMenu({ restore = true } = {}) {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
    if (restore && menuReturnFocus?.isConnected) menuReturnFocus.focus();
    menuReturnFocus = null;
  }

  function item(label, onSelect, { disabled = false } = {}) {
    return el('button', {
      type: 'button', role: 'menuitem', tabindex: '-1', 'aria-disabled': disabled ? 'true' : null,
      onclick: event => {
        event.stopPropagation();
        if (disabled) return;
        onSelect();
      },
    }, label);
  }

  function fillMenu(children, label) {
    menu.replaceChildren(...children);
    menu.setAttribute('aria-label', label);
    const first = menu.querySelector('[role=menuitem]:not([aria-disabled=true]), input');
    first?.focus();
  }

  function mainMenuItems(ids) {
    const trackLevel = data.kind === 'tracks';
    const one = trackLevel && ids.length === 1 ? tracksCache.find(track => track.id === ids[0]) : null;
    const allFavourite = ids.length > 0 && ids.every(id => tracksCache.find(track => track.id === id)?.bookmarked);
    const finish = fn => () => { closeMenu(); fn(); };
    return [
      item('Play', finish(() => runAction('play', { ids }))),
      item('Play next', finish(() => runAction('next', { ids }))),
      item('Add to queue', finish(() => runAction('queue', { ids }))),
      item('Add to playlist…', () => fillMenu(playlistMenuItems(ids), 'Add to playlist')),
      el('hr', { role: 'separator' }),
      item('Rate…', () => fillMenu(rateMenuItems(ids, one?.rating ?? null), 'Rate')),
      item(allFavourite ? 'Remove from favourites' : 'Add to favourites', finish(() => runAction('favourite', { ids, favourite: !allFavourite }))),
      el('hr', { role: 'separator' }),
      item('Edit tags…', finish(() => runAction('tags', { ids }))),
      item('Inspector', finish(() => runAction('inspector', { ids })), { disabled: !one }),
    ];
  }

  function rateMenuItems(ids, current) {
    const finish = rating => () => { closeMenu(); runAction('rate', { ids, rating }); };
    return [
      el('div', { class: 'nb-menu-title', role: 'presentation', text: `Rate ${plural(ids.length, 'track')}` }),
      ...[5, 4, 3, 2, 1].map(stars => item(`${'★'.repeat(stars)}${'☆'.repeat(5 - stars)}  ${plural(stars, 'star')}${current === stars ? ' (current)' : ''}`, finish(stars))),
      item('Clear rating', finish(0)),
      el('hr', { role: 'separator' }),
      item('Back', () => fillMenu(mainMenuItems(ids), 'Track actions')),
    ];
  }

  function playlistMenuItems(ids) {
    const writable = playlists().filter(playlist => ['m3u', 'm3u8'].includes(String(playlist.format ?? 'm3u').toLowerCase()));
    const nameInput = el('input', { type: 'text', 'aria-label': 'New playlist name', placeholder: 'New playlist name', maxlength: '120', required: true });
    const form = el('form', {
      onsubmit: event => {
        event.preventDefault();
        const name = nameInput.value.trim();
        if (!name) return;
        closeMenu();
        runAction('new-playlist', { ids, name });
      },
    }, nameInput, el('button', { type: 'submit', class: 'nb-btn' }, 'Create'));
    return [
      el('div', { class: 'nb-menu-title', role: 'presentation', text: `Add ${plural(ids.length, 'track')} to` }),
      ...writable.map(playlist => item(playlist.name, () => { closeMenu(); runAction('add-playlist', { ids, name: playlist.name }); })),
      writable.length ? el('hr', { role: 'separator' }) : null,
      form,
      item('Back', () => fillMenu(mainMenuItems(ids), 'Track actions')),
    ].filter(Boolean);
  }

  function openMenu({ x, y, ids, items = null, label = 'Track actions' }) {
    if (!ids.length) return;
    menuReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : scroller;
    menu.hidden = false;
    fillMenu(items ?? mainMenuItems(ids), label);
    const width = menu.offsetWidth || 220;
    const height = menu.offsetHeight || 300;
    // x and y are viewport coordinates. A transformed or filtered ancestor becomes the
    // containing block of a fixed element, so measure where (0, 0) lands and subtract it.
    menu.style.left = '0px';
    menu.style.top = '0px';
    const origin = menu.getBoundingClientRect();
    const left = Math.max(8, Math.min(x, innerWidth - width - 8));
    const top = Math.max(8, Math.min(y, innerHeight - height - 8));
    menu.style.left = `${left - origin.left}px`;
    menu.style.top = `${top - origin.top}px`;
  }

  function openMenuAtCursor(items, label) {
    const index = selection.cursor;
    const node = index >= 0 ? windowEl.querySelector(`#${uid}-r${index}`) : null;
    const box = (node ?? scroller).getBoundingClientRect();
    openMenu({ x: box.left + 24, y: box.top + Math.min(box.height, 40), ids: idsForAction(), items, label });
  }

  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('[role=menuitem]:not([aria-disabled=true]), input, form button')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[(at + step + items.length) % items.length]?.focus();
    } else if (event.key === 'Tab') {
      closeMenu({ restore: false });
    } else {
      // Keep letter keys typed into the name field away from the global shortcuts.
      event.stopPropagation();
    }
  });
  const outside = event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu({ restore: false }); };
  document.addEventListener('pointerdown', outside, true);
  cleanups.push(() => document.removeEventListener('pointerdown', outside, true));

  // ---- navigation ----
  function setView(view) {
    if (!VIEW_IDS.includes(view)) return;
    state.view = view;
    state.drill = null;
    state.sort = null;
    selection.clear();
    scroller.scrollTop = 0;
    recompute();
  }

  function drillInto(index) {
    const row = data.rows[index];
    if (!row || data.kind !== 'groups') return;
    state.drill = { key: row.key, label: displayLabel(row), kind: row.kind ?? 'group', rule: row.rule ?? null, row, returnIndex: index, returnScroll: scroller.scrollTop };
    state.query = '';
    search.value = '';
    selection.clear();
    scroller.scrollTop = 0;
    recompute();
    selection.focus(0);
    render();
    scroller.focus();
  }

  function back() {
    if (!state.drill) return;
    const { returnIndex, returnScroll } = state.drill;
    state.drill = null;
    state.sort = null;
    selection.clear();
    recompute();
    scroller.scrollTop = returnScroll ?? 0;
    if (returnIndex >= 0 && returnIndex < data.rows.length) selection.focus(returnIndex);
    render();
    scroller.focus();
  }

  // ---- events ----
  viewSelect.addEventListener('change', () => setView(viewSelect.value));
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = search.value;
      scroller.scrollTop = 0;
      recompute();
    }, 90);
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      scroller.focus();
      if (selection.cursor < 0) { selection.moveTo(0); paintBar(); render(); }
    }
  });
  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value ? { key: sortSelect.value, direction: state.sort?.direction ?? 'asc' } : null;
    recompute();
  });
  directionButton.addEventListener('click', () => {
    if (!state.sort) return;
    state.sort = { ...state.sort, direction: state.sort.direction === 'desc' ? 'asc' : 'desc' };
    recompute();
  });
  newSmartButton.addEventListener('click', () => ctx.open?.('smart', null));
  editSmartButton.addEventListener('click', () => ctx.open?.('smart', state.drill?.rule ?? null));
  backButton.addEventListener('click', back);
  albumPlay.addEventListener('click', () => {
    const ids = data.rows.map(track => track.id);
    if (ids.length) ctx.playTracks?.(ids, 0);
  });
  albumShuffle.addEventListener('click', () => {
    const ids = data.rows.map(track => track.id);
    for (let index = ids.length - 1; index > 0; index--) {
      const other = Math.floor(Math.random() * (index + 1));
      [ids[index], ids[other]] = [ids[other], ids[index]];
    }
    if (ids.length) ctx.playTracks?.(ids, 0);
  });
  bar.addEventListener('click', event => {
    const button = event.target.closest('button[data-act]');
    if (!button || button.disabled) return;
    const action = button.dataset.act;
    const box = button.getBoundingClientRect();
    if (action === 'menu') openMenu({ x: box.left, y: box.bottom + 4, ids: idsForAction() });
    else if (action === 'playlist') openMenu({ x: box.left, y: box.bottom + 4, ids: idsForAction(), items: playlistMenuItems(idsForAction()), label: 'Add to playlist' });
    else runAction(action);
  });

  scroller.addEventListener('scroll', () => { closeMenu({ restore: false }); scheduleRender(); }, { passive: true });

  /** A click on a row's own button (stars, favourite, more). True when handled. */
  function rowButtonClick(event, index, track) {
    const rate = event.target.closest('[data-rate]');
    if (rate && track) {
      const stars = Number(rate.dataset.rate);
      runAction('rate', { ids: [track.id], rating: stars === (track.rating ?? 0) ? 0 : stars });
      return true;
    }
    if (event.target.closest('[data-fav]') && track) {
      runAction('favourite', { ids: [track.id], favourite: !track.bookmarked });
      return true;
    }
    const more = event.target.closest('[data-more]');
    if (!more) return false;
    // Measure the button before render(): render replaces the rows, which detaches it
    // and would give a zero rectangle (the menu then opened at the window's top-left).
    const box = more.getBoundingClientRect();
    if (!selection.has(data.keys[index])) selection.click(index);
    paintBar();
    render();
    const width = menu.offsetWidth || 220;
    openMenu({ x: box.right - Math.max(width, 200), y: box.bottom + 2, ids: idsForAction() });
    return true;
  }

  scroller.addEventListener('click', event => {
    const node = event.target.closest('[data-index]');
    if (!node) return;
    const index = Number(node.dataset.index);
    const track = data.kind === 'tracks' ? data.rows[index] : null;
    if (rowButtonClick(event, index, track)) return;
    const range = event.shiftKey;
    const toggle = event.metaKey || event.ctrlKey;
    if (data.kind === 'groups' && !range && !toggle) {
      drillInto(index);
      return;
    }
    selection.click(index, { range, toggle });
    scroller.focus({ preventScroll: true });
    paintBar();
    render();
  });

  scroller.addEventListener('dblclick', event => {
    const node = event.target.closest('[data-index]');
    if (!node || event.target.closest('button')) return;
    if (data.kind === 'tracks') playFrom(Number(node.dataset.index));
  });

  scroller.addEventListener('contextmenu', event => {
    const node = event.target.closest('[data-index]');
    if (!node) return;
    event.preventDefault();
    const index = Number(node.dataset.index);
    if (!selection.has(data.keys[index])) selection.click(index);
    paintBar();
    render();
    openMenu({ x: event.clientX, y: event.clientY, ids: idsForAction() });
  });

  function repaintList() {
    paintBar();
    render();
  }

  function onNavKey(event, count) {
    if (!count) return;
    const page = Math.max(1, Math.floor((scroller.clientHeight || 520) / layout.rowHeight) - 1);
    const target = arrowTarget(event.key, selection.cursor, { count, columns: layout.columns, page });
    stopKey(event);
    if (isModKey(event) && !event.shiftKey) selection.focus(target);
    else selection.moveTo(target, { extend: event.shiftKey });
    reveal(target);
    repaintList();
  }

  function onSpaceKey(event, count) {
    stopKey(event);
    if (selection.cursor < 0 && count) selection.focus(0);
    selection.toggleCursor();
    repaintList();
  }

  function onEnterKey(event) {
    stopKey(event);
    const cursor = selection.cursor;
    if (cursor < 0) return;
    if (data.kind === 'groups' && !event.shiftKey) drillInto(cursor);
    else playSelection();
  }

  function onSelectAllKey(event) {
    if (!isModKey(event)) return;
    stopKey(event);
    selection.selectAll();
    repaintList();
  }

  function onBackKey(event) {
    if (!state.drill) return;
    stopKey(event);
    back();
  }

  function onEscapeKey(event) {
    if (!selection.size) return;
    stopKey(event);
    selection.clear();
    repaintList();
  }

  function onMenuKey(event) {
    if (event.key === 'F10' && !event.shiftKey) return;
    stopKey(event);
    openMenuAtCursor();
  }

  const BROWSE_KEYS = new Map([
    [' ', onSpaceKey], ['Enter', onEnterKey], ['a', onSelectAllKey], ['A', onSelectAllKey],
    ['Backspace', onBackKey], ['Escape', onEscapeKey], ['ContextMenu', onMenuKey], ['F10', onMenuKey],
  ]);

  function browseKeyHandler(event) {
    if (event.altKey && event.key === 'ArrowLeft') return onBackKey;
    if (event.altKey && altBlocked(event.key)) return null;
    if (BROWSE_NAV_KEYS.includes(event.key)) return onNavKey;
    return BROWSE_KEYS.get(event.key) ?? null;
  }

  scroller.addEventListener('keydown', event => {
    const handler = browseKeyHandler(event);
    if (handler) handler(event, data.rows.length);
  });

  function observeResize() {
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { measure(); scheduleRender(); }) : null;
    resizeObserver?.observe(scroller);
    return resizeObserver;
  }

  function subscribe() {
    const offLibrary = ctx.library?.onChange?.(() => recompute());
    if (typeof offLibrary === 'function') cleanups.push(offLibrary);
    const offQueue = ctx.queue?.onChange?.(snapshot => {
      const playing = snapshot?.current ?? null;
      if (playing !== state.playingId) { state.playingId = playing; scheduleRender(); }
    });
    if (typeof offQueue === 'function') cleanups.push(offQueue);
    try { state.playingId = ctx.queue?.current?.() ?? null; } catch { state.playingId = null; }
  }

  const resize = observeResize();
  subscribe();
  recompute();

  return {
    update(next = {}) {
      if (next.view && next.view !== state.view && VIEW_IDS.includes(next.view)) {
        state.view = next.view;
        state.drill = null;
        state.sort = null;
      }
      if (typeof next.query === 'string') { state.query = next.query; search.value = next.query; }
      if (next.playingId !== undefined) state.playingId = next.playingId;
      recompute();
    },
    destroy() {
      clearTimeout(searchTimer);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      resize?.disconnect();
      for (const fn of cleanups) { try { fn(); } catch { /* listener already gone */ } }
      root.replaceChildren();
    },
    selectedIds,
    setView,
    focusSearch() { search.focus(); search.select(); },
    focusList() { scroller.focus(); },
    get view() { return state.view; },
  };
}

