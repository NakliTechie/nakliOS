// Library browse views (L6 to L8) and track sorting (L7).
//
// Pure functions over arrays of index records, so the same code serves the
// UI, the agent commands and the tests. Every view is one pass to group plus
// one sort, O(n log n); nothing compares every track with every other.
//
// Headless by contract: no DOM, no network, no IndexedDB.

import { compareAlbumOrder, groupKey } from './store.mjs';
import { visibleTracks } from './cue.mjs';

/** Views that fold tracks into groups; pass `key` to drill into one group. */
export const GROUP_VIEWS = Object.freeze(['albums', 'artists', 'albumArtists', 'genres', 'years', 'folders']);
/** Views that are already track lists; `key` is ignored. */
export const LIST_VIEWS = Object.freeze(['recentlyAdded', 'recentlyPlayed', 'mostPlayed', 'favourites', 'rated']);
export const BROWSE_VIEWS = Object.freeze([...GROUP_VIEWS, ...LIST_VIEWS]);

export const SORT_KEYS = Object.freeze([
  'title', 'artist', 'album', 'year', 'addedAt', 'playCount', 'lastPlayedAt', 'rating', 'durationS',
]);
const TEXT_SORT_KEYS = new Set(['title', 'artist', 'album']);

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export class BrowseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BrowseError';
    this.code = 'ERR_NAKLIAMP_BROWSE_INVALID';
  }
}

/** The directory part of a folder-relative path; '' for the folder root. */
export function folderOf(path) {
  const text = String(path ?? '');
  const slash = text.lastIndexOf('/');
  return slash < 0 ? '' : text.slice(0, slash);
}

const UNKNOWN_YEAR = 'unknown';

/** How each group view keys and labels a track. */
const GROUPING = Object.freeze({
  albums: { key: track => track.albumKey, label: track => track.album },
  artists: { key: track => track.artistKey, label: track => track.artist || track.albumArtist },
  albumArtists: {
    key: track => groupKey(track.albumArtist || track.artist),
    label: track => track.albumArtist || track.artist,
  },
  genres: { key: track => groupKey(track.genre), label: track => track.genre },
  years: {
    key: track => (Number.isFinite(track.year) && track.year > 0 ? String(track.year) : UNKNOWN_YEAR),
    label: track => (Number.isFinite(track.year) && track.year > 0 ? String(track.year) : null),
  },
  folders: { key: track => folderOf(track.path), label: track => folderOf(track.path) || null },
});

/** Album-artist, year, album, then disc and track: the order a shelf reads in. */
function compareShelf(left, right) {
  return collator.compare(String(left.albumArtist || left.artist || ''), String(right.albumArtist || right.artist || ''))
    || (left.year ?? 0) - (right.year ?? 0)
    || collator.compare(String(left.album ?? ''), String(right.album ?? ''))
    || compareAlbumOrder(left, right);
}

function newGroup(key, track, by, labelOf) {
  const group = { key, label: labelOf(track) || null, trackCount: 0, durationS: 0, artKey: null, albumKeys: new Set() };
  if (by === 'albums') {
    group.albumArtist = track.albumArtist || track.artist || null;
    group.year = track.year ?? null;
  }
  return group;
}

function addToGroup(group, track, by, labelOf) {
  group.trackCount += 1;
  group.durationS += Number.isFinite(track.durationS) ? track.durationS : 0;
  group.artKey ??= track.artKey ?? track.dirArtKey ?? null;
  group.label ??= labelOf(track) || null;
  if (by === 'albums') group.year ??= track.year ?? null;
  group.albumKeys.add(track.albumKey);
}

function groupRows(tracks, by) {
  const { key: keyOf, label: labelOf } = GROUPING[by];
  const groups = new Map();
  for (const track of tracks) {
    const key = keyOf(track);
    let group = groups.get(key);
    if (!group) {
      group = newGroup(key, track, by, labelOf);
      groups.set(key, group);
    }
    addToGroup(group, track, by, labelOf);
  }
  const rows = [];
  for (const group of groups.values()) {
    const { albumKeys, ...row } = group;
    row.albumCount = albumKeys.size;
    rows.push(row);
  }
  return rows;
}

function sortGroups(rows, by) {
  if (by === 'albums') {
    return rows.sort((left, right) =>
      collator.compare(String(left.albumArtist ?? ''), String(right.albumArtist ?? ''))
      || (left.year ?? 0) - (right.year ?? 0)
      || collator.compare(String(left.label ?? ''), String(right.label ?? '')));
  }
  if (by === 'years') {
    // Newest first; undated last.
    return rows.sort((left, right) => {
      const leftUnknown = left.key === UNKNOWN_YEAR;
      const rightUnknown = right.key === UNKNOWN_YEAR;
      if (leftUnknown || rightUnknown) return Number(leftUnknown) - Number(rightUnknown);
      return Number(right.key) - Number(left.key);
    });
  }
  // Unlabelled groups (no genre, no artist) sort last.
  return rows.sort((left, right) => (left.label === null) - (right.label === null)
    || collator.compare(String(left.label ?? ''), String(right.label ?? '')));
}

/**
 * Browse the library.
 *
 * - A group view without `key` returns group rows:
 *   `{ key, label, trackCount, durationS, artKey, albumCount }`, plus
 *   `albumArtist` and `year` for albums. `label` is null for "Unknown".
 * - A group view with `key` returns that group's tracks in shelf order
 *   (folders in file-name order).
 * - A list view returns tracks: recentlyAdded (newest first), recentlyPlayed
 *   (played at least once, latest first), mostPlayed (played at least once,
 *   most first), favourites, rated (rated tracks, highest first).
 *
 * `limit` caps list views and drilled tracks; group rows are never capped.
 */
/** List views: which tracks each one keeps and how it orders them. */
const LIST_VIEW_RULES = {
  recentlyAdded: tracks => sortTracks(tracks.filter(track => track.addedAt > 0), 'addedAt', 'desc'),
  recentlyPlayed: tracks => sortTracks(tracks.filter(track => track.lastPlayedAt > 0), 'lastPlayedAt', 'desc'),
  mostPlayed: tracks => sortTracks(tracks.filter(track => track.playCount > 0), 'playCount', 'desc'),
  favourites: tracks => tracks.filter(track => track.bookmarked).sort(compareShelf),
};
const ratedView = tracks => sortTracks(tracks.filter(track => track.rating > 0), 'rating', 'desc');

/** One group's tracks: folders in file-name order, other groups in shelf order. */
function groupMembers(tracks, by, key) {
  const keyOf = GROUPING[by].key;
  const members = tracks.filter(track => keyOf(track) === key);
  if (by === 'folders') return members.sort((left, right) => collator.compare(String(left.path), String(right.path)));
  return members.sort(compareShelf);
}

export function browse(allTracks, { by, key = undefined, limit = undefined } = {}) {
  // Cue-sheet parents (`hidden`) are replaced by their virtual tracks (P12).
  const tracks = visibleTracks(allTracks);
  if (!BROWSE_VIEWS.includes(by)) throw new BrowseError(`Unknown browse view: ${String(by)}`);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new BrowseError('limit is not a positive whole number.');
  const cap = list => (limit ? list.slice(0, limit) : list);

  if (GROUP_VIEWS.includes(by)) {
    if (key === undefined || key === null) return sortGroups(groupRows(tracks, by), by);
    return cap(groupMembers(tracks, by, key));
  }
  return cap((Object.hasOwn(LIST_VIEW_RULES, by) ? LIST_VIEW_RULES[by] : ratedView)(tracks));
}

/**
 * A sorted copy of `tracks`. Missing values always sort last, in either
 * direction, so "sort by year" never opens on a wall of undated tracks.
 * Ties fall back to shelf order, which keeps albums together and the sort stable.
 */
export function sortTracks(tracks, key, direction = 'asc') {
  if (!SORT_KEYS.includes(key)) throw new BrowseError(`Unknown sort key: ${String(key)}`);
  if (direction !== 'asc' && direction !== 'desc') throw new BrowseError(`Unknown sort direction: ${String(direction)}`);
  const sign = direction === 'desc' ? -1 : 1;
  const text = TEXT_SORT_KEYS.has(key);

  // Decorate once so each comparison reads a prepared value.
  const decorated = tracks.map(track => {
    let value = key === 'title' ? (track.title ?? track.name) : track[key];
    if (text) value = value === null || value === undefined || value === '' ? null : String(value);
    else value = Number.isFinite(value) ? value : null;
    return { track, value };
  });
  decorated.sort((left, right) => {
    if (left.value === null || right.value === null) {
      if (left.value === right.value) return compareShelf(left.track, right.track);
      return left.value === null ? 1 : -1;
    }
    const order = text ? collator.compare(left.value, right.value) : left.value - right.value;
    return order * sign || compareShelf(left.track, right.track);
  });
  return decorated.map(entry => entry.track);
}
