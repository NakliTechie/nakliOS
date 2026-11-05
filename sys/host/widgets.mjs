// Desktop widgets (common rail step 3b, docs/app-contract.md): an app publishes one small snapshot per widget it
// declares in commands.json, and the desktop draws it from a fixed template. Apps inject no markup, every field is
// text, and a card shows with the app closed because the desktop keeps the last snapshot. No window opens at boot.
// A snapshot marked `persist: false` (Crate data) lives in memory only and goes when Crate locks.

export const DISPLAYS = Object.freeze(['list', 'agenda', 'value']);
export const MAX_WIDGETS_PER_APP = 4;
export const MAX_ITEMS = 8;
const MAX_TEXT = 120;
const ID = /^[a-z][a-z0-9_-]*$/;

const text = value => String(value ?? '').trim().slice(0, MAX_TEXT);

export function parseWidgets(defs) {
  if (defs === undefined) return { widgets: [] };
  if (!Array.isArray(defs) || defs.length > MAX_WIDGETS_PER_APP) return { error: `widgets must be a list of at most ${MAX_WIDGETS_PER_APP}` };
  const widgets = [];
  for (const raw of defs) {
    if (!raw || !ID.test(String(raw.id))) return { error: `invalid widget id: ${String(raw?.id)}` };
    if (!DISPLAYS.includes(raw.display)) return { error: `${raw.id}: display must be ${DISPLAYS.join(', ')}` };
    if (!text(raw.title)) return { error: `${raw.id}: title is required` };
    if (widgets.some(w => w.id === raw.id)) return { error: `duplicate widget: ${raw.id}` };
    widgets.push({ id: raw.id, title: text(raw.title), display: raw.display });
  }
  return { widgets };
}

// Keeps only what the template draws, so nothing else an app sends is stored or shown.
export function cleanSnapshot(display, data) {
  if (!data || typeof data !== 'object') return null;
  const expires = Number.isFinite(data.expires) ? data.expires : null;
  const heading = text(data.heading);
  const empty = text(data.empty);
  if (display === 'value') return { value: text(data.value), label: text(data.label), expires };
  const rows = Array.isArray(data.items) ? data.items : [];
  const items = rows.slice(0, MAX_ITEMS).map(row => display === 'agenda'
    ? { time: text(row?.time).slice(0, 12), title: text(row?.title) }
    : text(row));
  return { heading, items, more: Math.max(0, rows.length - items.length), empty, expires };
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.root            the element the cards go in
 * @param {() => Promise<object|null>} opts.load   every saved snapshot, by key
 * @param {(key: string, value: object|null) => Promise<void>} opts.save  one key at a time, so two tabs never overwrite
 *   each other's widgets; null removes it
 * @param {(appId: string) => void} opts.open
 * @param {() => number} [opts.now]
 */
export function createWidgetBoard({ root, load, save, open, now = Date.now }) {
  const declared = new Map(); // `${appId}/${id}` -> { appId, appName, id, title, display }
  const snapshots = new Map(); // same key -> { data, persist, at }
  let enabled = true;
  let saving = Promise.resolve();
  let expiry = null;

  function persist(key) {
    const s = snapshots.get(key);
    saving = saving.catch(() => {}).then(() => save(key, s?.persist ? { data: s.data, at: s.at } : null));
    return saving;
  }

  function card(widget, snapshot) {
    const doc = root.ownerDocument;
    const el = doc.createElement('button');
    el.type = 'button';
    el.className = 'nw-widget';
    el.dataset.widget = `${widget.appId}/${widget.id}`;
    el.addEventListener('click', () => open(widget.appId));
    const add = (parent, tag, className, value) => {
      const child = doc.createElement(tag);
      child.className = className;
      child.textContent = value;
      parent.append(child);
      return child;
    };
    add(el, 'span', 'nw-widget-title', widget.title);
    const data = snapshot.data;
    if (data.expires != null && now() >= data.expires) {
      add(el, 'span', 'nw-widget-empty', `Open ${widget.appName} to update`);
      return el;
    }
    if (widget.display === 'value') {
      add(el, 'span', 'nw-widget-value', data.value);
      if (data.label) add(el, 'span', 'nw-widget-empty', data.label);
      return el;
    }
    if (data.heading) add(el, 'span', 'nw-widget-heading', data.heading);
    if (!data.items.length) add(el, 'span', 'nw-widget-empty', data.empty || 'Nothing here');
    for (const item of data.items) {
      const row = add(el, 'span', 'nw-widget-row', '');
      if (widget.display === 'agenda') { add(row, 'span', 'nw-widget-time', item.time); add(row, 'span', 'nw-widget-text', item.title); }
      else add(row, 'span', 'nw-widget-text', item);
    }
    if (data.more) add(el, 'span', 'nw-widget-empty', `and ${data.more} more`);
    return el;
  }

  function render() {
    const cards = enabled ? [...declared].filter(([key]) => snapshots.has(key)).map(([key, widget]) => card(widget, snapshots.get(key))) : [];
    root.replaceChildren(...cards);
    root.hidden = !cards.length;
    // A card must not go on showing yesterday in a tab left open overnight.
    clearTimeout(expiry);
    const next = Math.min(...[...snapshots.values()].map(s => s.data.expires).filter(at => at != null && at > now()));
    if (enabled && Number.isFinite(next)) { expiry = setTimeout(render, Math.min(next - now(), 2 ** 31 - 1)); expiry.unref?.(); }
  }

  return {
    declare(appId, appName, defs) {
      const parsed = parseWidgets(defs);
      if (parsed.error) return { ok: false, error: parsed.error };
      for (const widget of parsed.widgets) declared.set(`${appId}/${widget.id}`, { ...widget, appId, appName });
      render();
      return { ok: true };
    },
    // `data: null` removes the card. Only a declared widget of the sending app is accepted.
    update(appId, id, data, { persist: keep = true } = {}) {
      const key = `${appId}/${id}`;
      const widget = declared.get(key);
      if (!widget) return { ok: false, error: `${key} is not declared` };
      if (data === null) snapshots.delete(key);
      else {
        const clean = cleanSnapshot(widget.display, data);
        if (!clean) return { ok: false, error: 'a snapshot must be an object' };
        snapshots.set(key, { data: clean, persist: keep === true, at: now() });
      }
      render();
      void persist(key);
      return { ok: true };
    },
    async restore() {
      const all = await load().catch(() => null);
      for (const [key, saved] of Object.entries(all || {})) {
        const widget = declared.get(key);
        if (!widget || snapshots.has(key) || !saved?.data) continue;
        const clean = cleanSnapshot(widget.display, saved.data);
        if (clean) snapshots.set(key, { data: clean, persist: true, at: saved.at });
      }
      render();
    },
    // Crate locked: what was shown only from memory goes with it.
    dropMemoryOnly() {
      for (const [key, snapshot] of snapshots) if (!snapshot.persist) snapshots.delete(key);
      render();
    },
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) { snapshots.clear(); for (const key of declared.keys()) void persist(key); }
      render();
    },
    flush: () => saving,
  };
}
