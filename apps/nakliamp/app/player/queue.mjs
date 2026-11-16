// queue.mjs — the play queue (P5, P6, Y5). Pure state, no DOM.
//
// The queue is its own list, separate from the rows the library shows. Each entry is
// `{ key, id }`: `id` is the track id, `key` is unique per entry, so the same track can
// sit in the queue twice and the playing entry is still unambiguous.
//
// Shuffle reorders the entries and keeps the unshuffled order beside them, so turning
// shuffle off puts the queue back the way the person built it. Album shuffle keeps the
// track order inside each album and shuffles the albums (it needs `albumOf(id)`).
// With repeat all, moving past the last entry reshuffles the whole queue for the next
// pass, entries added during the pass included, and never starts the pass on the entry
// that just played. `peekNext` names the same entry `next` then moves to.
//
// Transient entries (a file NakliOS hands over, which is not in the library) queue and
// play like any other entry, but `isTransient(id)` keeps them out of the stored copy:
// their File does not survive a reload, so a restored queue never points at one.
//
// Every edit (set, playNext, add, move, remove, clear, setShuffle) pushes one undo step.
// Moving through the queue (next, prev, jump) and the repeat mode are not edits.
//
// `revision` counts every change a listener hears about (edits, moves through the queue,
// repeat, undo), as cliamp's `playlist_revision` does. An agent sends it back as
// `if_revision`, and `revisionConflict` refuses the command when the queue moved since.

export const QUEUE_STORAGE_KEY = 'nakliamp:queue';
export const SHUFFLE_MODES = Object.freeze(['off', 'tracks', 'albums']);
export const REPEAT_MODES = Object.freeze(['off', 'all', 'one']);
export const UNDO_LIMIT = 100;

function defaultStorage() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function shuffleInPlace(list, random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function cleanIds(ids) {
  if (!Array.isArray(ids)) throw new TypeError('ids must be an array');
  return ids.filter(id => (typeof id === 'string' && id) || Number.isInteger(id));
}

/**
 * @param {{ storage?: Storage|null, albumOf?: (id) => string, random?: () => number,
 *           storageKey?: string }} [options]
 */
const isTrackId = id => (typeof id === 'string' && id !== '') || Number.isInteger(id);

/** Stored queue entries with an integer key (first use wins) and a track id. */
function validEntries(stored) {
  const seen = new Set();
  const list = [];
  for (const e of stored) {
    if (!e || !Number.isInteger(e.key) || seen.has(e.key)) continue;
    if (!isTrackId(e.id)) continue;
    seen.add(e.key);
    list.push({ key: e.key, id: e.id });
  }
  return list;
}

/**
 * The stored person's order, as a permutation of the restored entries: each known key
 * once, in stored order, then any entry the stored order left out, in play order.
 */
function restoredUnshuffled(stored, list) {
  const keys = new Set(list.map(e => e.key));
  const seen = new Set();
  const order = [];
  for (const k of Array.isArray(stored) ? stored : []) {
    if (!keys.has(k) || seen.has(k)) continue;
    seen.add(k);
    order.push(k);
  }
  for (const e of list) if (!seen.has(e.key)) order.push(e.key);
  return order;
}

function restoredIndex(stored, length) {
  if (Number.isInteger(stored) && stored >= -1 && stored < length) return stored;
  return length ? 0 : -1;
}

/** The stored form of a queue state without its transient entries. */
export function persistableState(s, isTransient = () => false) {
  const keep = s.entries.filter(e => { try { return !isTransient(e.id); } catch { return true; } });
  if (keep.length === s.entries.length) return s;
  const keys = new Set(keep.map(e => e.key));
  const currentKey = s.index >= 0 ? s.entries[s.index]?.key : null;
  let index = keep.findIndex(e => e.key === currentKey);
  if (index < 0) index = keep.length ? Math.min(Math.max(0, s.index), keep.length - 1) : -1;
  return { ...s, entries: keep, unshuffled: s.unshuffled.filter(k => keys.has(k)), index };
}

/**
 * The `[conflict]` check for a queue-editing command: null when `expected` is absent or
 * equals `current`, else the refusal message. Kept pure so the runner and tests share it.
 */
export function revisionConflict(expected, current) {
  if (expected === undefined || expected === null) return null;
  if (expected === current) return null;
  return `The queue changed since revision ${expected}; it is now at revision ${current}. Read it again and resend.`;
}

export function createQueue({ storage = defaultStorage(), albumOf = () => '', random = Math.random, storageKey = QUEUE_STORAGE_KEY, isTransient = () => false } = {}) {
  let entries = [];          // [{ key, id }] in play order
  let unshuffled = [];       // keys in the order the person built, used while shuffle is on
  let index = -1;            // position in `entries` of the current entry, -1 when nothing is current
  let shuffle = 'off';
  let repeat = 'off';
  let nextKey = 1;
  let revision = 0;          // moves on every change a listener hears about; not persisted
  const undoStack = [];
  const listeners = new Set();
  let wrapOrder = null;      // the reshuffled next pass, fixed once peekNext or next asks for it

  const make = id => ({ key: nextKey++, id });
  const currentKey = () => (index >= 0 && index < entries.length ? entries[index].key : null);

  function state() {
    return { entries: entries.map(e => ({ ...e })), unshuffled: unshuffled.slice(), index, shuffle, repeat, nextKey };
  }

  function restore(s) {
    entries = s.entries.map(e => ({ key: e.key, id: e.id }));
    unshuffled = s.unshuffled.slice();
    index = s.index;
    shuffle = s.shuffle;
    repeat = s.repeat;
    nextKey = Math.max(nextKey, s.nextKey);
  }

  function load() {
    if (!storage) return;
    let raw = null;
    try { raw = storage.getItem(storageKey); } catch { return; }
    if (!raw) return;
    try {
      const s = JSON.parse(raw);
      if (!s || !Array.isArray(s.entries)) return;
      const list = validEntries(s.entries);
      entries = list;
      index = restoredIndex(s.index, list.length);
      shuffle = SHUFFLE_MODES.includes(s.shuffle) ? s.shuffle : 'off';
      repeat = REPEAT_MODES.includes(s.repeat) ? s.repeat : 'off';
      unshuffled = shuffle === 'off' ? [] : restoredUnshuffled(s.unshuffled, list);
      nextKey = Math.max(1, ...list.map(e => e.key + 1), Number.isInteger(s.nextKey) ? s.nextKey : 1);
    } catch { /* a damaged record starts an empty queue */ }
  }

  function persist() {
    if (!storage) return;
    try { storage.setItem(storageKey, JSON.stringify(persistableState(state(), isTransient))); } catch { /* quota or blocked storage */ }
  }

  function emit(reason, before) {
    revision += 1;
    if (reason !== 'repeat') wrapOrder = null;
    persist();
    const snap = snapshot();
    const info = { reason, currentChanged: before !== currentKey() };
    for (const fn of listeners) {
      try { fn(snap, info); } catch (error) { console.warn('[nakliamp] queue listener failed', error); }
    }
  }

  function pushUndo() {
    undoStack.push(state());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  }

  // Wrap an edit: record undo, run, keep `index` on the same entry where it survives, notify.
  function edit(reason, fn) {
    const before = currentKey();
    pushUndo();
    fn(before);
    emit(reason, before);
    return snapshot();
  }

  function indexOfKey(key) {
    return key === null ? -1 : entries.findIndex(e => e.key === key);
  }

  // Reorder `entries` for the active shuffle mode. The current entry goes first, so
  // shuffle never changes what is playing and every other entry is still ahead of it.
  function applyShuffle(mode) {
    const curKey = currentKey();
    const current = curKey === null ? null : entries[index];
    if (mode === 'tracks') {
      const rest = shuffleInPlace(entries.filter(e => e.key !== curKey), random);
      entries = current ? [current, ...rest] : rest;
      index = current ? 0 : -1;
    } else if (mode === 'albums') {
      const groups = new Map();
      for (const e of entries) {
        let album = '';
        try { album = String(albumOf(e.id) ?? ''); } catch { album = ''; }
        if (!groups.has(album)) groups.set(album, []);
        groups.get(album).push(e);
      }
      let list = [...groups.values()];
      let first = [];
      if (current) {
        const at = list.findIndex(g => g.includes(current));
        first = list.splice(at, 1)[0];
      }
      list = shuffleInPlace(list, random);
      entries = [first, ...list].flat();
      index = current ? entries.indexOf(current) : -1;
    }
  }

  function snapshot() {
    return {
      ids: entries.map(e => e.id),
      keys: entries.map(e => e.key),
      index,
      current: index >= 0 ? entries[index].id : null,
      length: entries.length,
      shuffle,
      repeat,
      canUndo: undoStack.length > 0,
      revision,
    };
  }

  // The order of the next pass under repeat all with shuffle on: every entry reshuffled,
  // and the entry that just played moved off the front when the queue has another.
  function shuffledPass() {
    const curKey = currentKey();
    if (shuffle === 'tracks') {
      const list = shuffleInPlace(entries.slice(), random);
      if (list.length > 1 && list[0].key === curKey) list.push(list.shift());
      return list;
    }
    const groups = new Map();
    for (const e of entries) {
      let album = '';
      try { album = String(albumOf(e.id) ?? ''); } catch { album = ''; }
      if (!groups.has(album)) groups.set(album, []);
      groups.get(album).push(e);
    }
    const list = shuffleInPlace([...groups.values()], random);
    if (list.length > 1 && list[0].some(e => e.key === curKey)) list.push(list.shift());
    return list.flat();
  }

  // True when the next move goes past the last entry into a reshuffled pass.
  function wrapsIntoNewPass(auto) {
    if (repeat !== 'all' || shuffle === 'off' || entries.length < 2) return false;
    if (index < 0 || index + 1 < entries.length) return false;
    return !(auto && repeat === 'one');
  }

  // The position `next` would move to, or -1. `auto` means the track ended by itself:
  // repeat-one then plays the same entry again; a person pressing Next still moves on.
  function nextIndex({ auto = false } = {}) {
    if (!entries.length) return -1;
    if (index < 0) return 0;
    if (auto && repeat === 'one') return index;
    if (index + 1 < entries.length) return index + 1;
    return repeat === 'all' || repeat === 'one' ? 0 : -1;
  }

  // The entry `next` would make current, without moving: from the reshuffled pass at a wrap.
  function nextEntry(options = {}) {
    if (wrapsIntoNewPass(options.auto)) {
      wrapOrder ??= shuffledPass();
      return wrapOrder[0];
    }
    const i = nextIndex(options);
    return i < 0 ? null : entries[i];
  }

  load();

  return {
    set(ids, startIndex = 0) {
      const list = cleanIds(ids);
      return edit('set', () => {
        entries = list.map(make);
        unshuffled = [];
        index = list.length ? Math.min(Math.max(0, Number.isInteger(startIndex) ? startIndex : 0), list.length - 1) : -1;
        if (shuffle !== 'off') { unshuffled = entries.map(e => e.key); applyShuffle(shuffle); }
      });
    },

    // Insert right after the current entry, in the given order.
    playNext(ids) {
      const added = cleanIds(ids).map(make);
      return edit('playNext', () => {
        const at = index + 1;
        entries.splice(at, 0, ...added);
        if (shuffle !== 'off') {
          const cur = currentKey();
          const u = cur === null ? 0 : unshuffled.indexOf(cur) + 1;
          unshuffled.splice(u, 0, ...added.map(e => e.key));
        }
      });
    },

    add(ids) {
      const added = cleanIds(ids).map(make);
      return edit('add', () => {
        entries.push(...added);
        if (shuffle !== 'off') unshuffled.push(...added.map(e => e.key));
      });
    },

    move(from, to) {
      if (!Number.isInteger(from) || !Number.isInteger(to)) throw new TypeError('from and to must be integers');
      if (from < 0 || from >= entries.length || to < 0 || to >= entries.length) throw new RangeError('index out of range');
      return edit('move', before => {
        const [e] = entries.splice(from, 1);
        entries.splice(to, 0, e);
        index = indexOfKey(before);
      });
    },

    // Remove entries by position. When the current entry goes, the entry that took
    // its place becomes current (or the new last one), and onChange says currentChanged.
    remove(indices) {
      const drop = new Set((Array.isArray(indices) ? indices : [indices]).filter(i => Number.isInteger(i) && i >= 0 && i < entries.length));
      return edit('remove', before => {
        const removedBefore = [...drop].filter(i => i < index).length;
        const currentGone = drop.has(index);
        const goneKeys = new Set([...drop].map(i => entries[i].key));
        entries = entries.filter((_, i) => !drop.has(i));
        unshuffled = unshuffled.filter(k => !goneKeys.has(k));
        if (!entries.length) index = -1;
        else if (currentGone) index = Math.min(index - removedBefore, entries.length - 1);
        else index = indexOfKey(before);
      });
    },

    clear() {
      return edit('clear', () => { entries = []; unshuffled = []; index = -1; });
    },

    current() { return index >= 0 && index < entries.length ? entries[index].id : null; },
    peekNext(options) { return nextEntry(options)?.id ?? null; },

    next(options) {
      const target = nextEntry(options);
      if (!target) return null;
      const before = currentKey();
      if (wrapsIntoNewPass(options?.auto)) { entries = wrapOrder; index = 0; }
      else index = nextIndex(options);
      emit('next', before);
      return target.id;
    },

    prev() {
      if (!entries.length) return null;
      let i = index - 1;
      if (index < 0) i = 0;
      else if (i < 0) { if (repeat === 'off') return null; i = entries.length - 1; }
      const before = currentKey();
      index = i;
      emit('prev', before);
      return entries[i].id;
    },

    jump(i) {
      if (!Number.isInteger(i) || i < 0 || i >= entries.length) throw new RangeError('index out of range');
      const before = currentKey();
      index = i;
      emit('jump', before);
      return entries[i].id;
    },

    setShuffle(mode) {
      if (!SHUFFLE_MODES.includes(mode)) throw new RangeError(`shuffle must be one of ${SHUFFLE_MODES.join(', ')}`);
      if (mode === shuffle) return snapshot();
      return edit('shuffle', before => {
        if (shuffle === 'off') unshuffled = entries.map(e => e.key);
        // Return to the person's order first, so tracks to albums starts from it too.
        const byKey = new Map(entries.map(e => [e.key, e]));
        entries = unshuffled.map(k => byKey.get(k)).filter(Boolean);
        index = indexOfKey(before);
        shuffle = mode;
        if (mode === 'off') unshuffled = [];
        else applyShuffle(mode);
      });
    },

    setRepeat(mode) {
      if (!REPEAT_MODES.includes(mode)) throw new RangeError(`repeat must be one of ${REPEAT_MODES.join(', ')}`);
      if (mode === repeat) return snapshot();
      const before = currentKey();
      repeat = mode;
      emit('repeat', before);
      return snapshot();
    },

    // Undo one edit. The playing entry stays current when the restored queue still holds it.
    undo() {
      if (!undoStack.length) return false;
      const before = currentKey();
      const keepRepeat = repeat;
      restore(undoStack.pop());
      repeat = keepRepeat;
      const at = indexOfKey(before);
      if (at >= 0) index = at;
      emit('undo', before);
      return true;
    },

    snapshot,
    revision: () => revision,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
