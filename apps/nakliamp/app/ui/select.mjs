// select.mjs: the selection model for NakliAmp lists (Y4). Pure state, no DOM.
//
// A list is an ordered array of row keys (track ids, group keys, queue entry keys).
// The selection holds keys, so it survives a re-sort or a filter: a key that leaves
// the list leaves the selection. `cursor` is the focused row and `anchor` the row a
// Shift range starts from; both are indices into the current order, or -1.
//
// Gestures, matching desktop players and file managers:
//   click                selects only that row; anchor and cursor move to it
//   Cmd/Ctrl click       toggles that row; anchor and cursor move to it
//   Shift click          selects anchor..row, replacing the selection
//   Cmd/Ctrl Shift click adds anchor..row to the selection
//   arrows               move the cursor and select only it
//   Shift arrows         extend from the anchor to the cursor
//   Space                toggles the cursor row
//   select all, clear

export function createSelection(order = []) {
  let keys = [];
  let positions = new Map();
  let selected = new Set();
  let anchorKey = null;
  let cursorKey = null;

  const indexOf = key => (key === null ? -1 : positions.get(key) ?? -1);
  const clamp = index => Math.max(0, Math.min(keys.length - 1, index));

  function setOrder(nextOrder) {
    keys = Array.from(nextOrder ?? []);
    positions = new Map();
    keys.forEach((key, index) => { if (!positions.has(key)) positions.set(key, index); });
    selected = new Set([...selected].filter(key => positions.has(key)));
    if (!positions.has(anchorKey)) anchorKey = null;
    if (!positions.has(cursorKey)) cursorKey = null;
    return api;
  }

  function selectRange(from, to, { add = false } = {}) {
    if (!add) selected.clear();
    const [low, high] = from <= to ? [from, to] : [to, from];
    for (let index = low; index <= high; index++) selected.add(keys[index]);
  }

  /** A pointer click on row `index`. `range` = Shift held, `toggle` = Cmd or Ctrl held. */
  function click(index, { range = false, toggle = false } = {}) {
    if (!keys.length) return api;
    const at = clamp(index);
    const key = keys[at];
    if (range) {
      const from = indexOf(anchorKey) >= 0 ? indexOf(anchorKey) : at;
      selectRange(from, at, { add: toggle });
      if (anchorKey === null) anchorKey = key;
    } else if (toggle) {
      if (selected.has(key)) selected.delete(key); else selected.add(key);
      anchorKey = key;
    } else {
      selected = new Set([key]);
      anchorKey = key;
    }
    cursorKey = key;
    return api;
  }

  /** Put the cursor on `index`. `extend` (Shift) selects anchor..index; otherwise only it. */
  function moveTo(index, { extend = false } = {}) {
    if (!keys.length) return api;
    const at = clamp(index);
    if (extend) {
      if (anchorKey === null) anchorKey = cursorKey ?? keys[at];
      selectRange(indexOf(anchorKey), at);
    } else {
      selected = new Set([keys[at]]);
      anchorKey = keys[at];
    }
    cursorKey = keys[at];
    return api;
  }

  /** Move the cursor by `delta` rows (from -1 when nothing has the cursor yet). */
  function move(delta, options) {
    if (!keys.length) return api;
    const from = indexOf(cursorKey);
    const target = from < 0 ? (delta < 0 ? keys.length - 1 : 0) : from + delta;
    return moveTo(target, options);
  }

  /** Move the cursor without changing the selection (Cmd/Ctrl arrows). */
  function focus(index) {
    if (keys.length) cursorKey = keys[clamp(index)];
    return api;
  }

  /** Space: toggle the cursor row. */
  function toggleCursor() {
    if (cursorKey === null) return api;
    if (selected.has(cursorKey)) selected.delete(cursorKey); else selected.add(cursorKey);
    anchorKey = cursorKey;
    return api;
  }

  function selectAll() {
    selected = new Set(keys);
    if (cursorKey === null && keys.length) cursorKey = keys[0];
    if (anchorKey === null) anchorKey = cursorKey;
    return api;
  }

  function clear() {
    selected.clear();
    return api;
  }

  /** Selected keys in list order. */
  function selectedKeys() {
    if (!selected.size) return [];
    return keys.filter(key => selected.has(key));
  }

  /** Selected indices in list order. */
  function selectedIndices() {
    const out = [];
    keys.forEach((key, index) => { if (selected.has(key)) out.push(index); });
    return out;
  }

  const api = {
    setOrder, click, move, moveTo, focus, toggleCursor, selectAll, clear,
    selectedKeys, selectedIndices,
    has: key => selected.has(key),
    isSelected: index => index >= 0 && index < keys.length && selected.has(keys[index]),
    get size() { return selected.size; },
    get cursor() { return indexOf(cursorKey); },
    get anchor() { return indexOf(anchorKey); },
    get length() { return keys.length; },
  };
  setOrder(order);
  return api;
}
