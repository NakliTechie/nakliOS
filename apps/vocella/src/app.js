// The page: wires the buttons, keys and file drop to the command manifest, draws what the reader says, and
// keeps the viewer's saved progress (NakliOS storage when hosted, the browser's local storage standalone).

import { Reader } from './reader.js';
import { run, tools } from './commands.js';
import { cardDocument } from './render.js';
import { mediaType } from './media.js';
import { createStore } from './store.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const status = $('status');
const shelf = $('shelf');
const viewer = $('viewer');
const deckList = $('decks');
const library = $('library');
const yours = $('yours');
const frame = /** @type {HTMLIFrameElement} */ ($('card'));
const fileInput = /** @type {HTMLInputElement} */ ($('file'));
const progressInput = /** @type {HTMLInputElement} */ ($('progress-file'));
/** The NakliOS SDK, inlined in index.html; a no-op when Vocella runs standalone. */
const naklios = /** @type {any} */ (window).naklios;

/** sql.js: a classic script that defines initSqlJs. It starts loading with the page, so the first card is not kept waiting. @type {Promise<any> | null} */
let sql = null;
const loadSql = () =>
  (sql ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/sql-wasm.js';
    s.onload = () => resolve(/** @type {any} */ (window).initSqlJs({ locateFile: (/** @type {string} */ f) => `vendor/${f}` }));
    s.onerror = () => reject(new Error('Could not load vendor/sql-wasm.js.'));
    document.head.append(s);
  }));

/** @param {string} path */
async function fetchBytes(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Could not load ${path} (HTTP ${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** @param {string} msg @param {boolean} [error] */
function say(msg, error = false) {
  status.textContent = msg;
  status.classList.toggle('error', error);
}

// Every failure reaches the status line, so nothing fails silently.
addEventListener('error', (e) => say(e.message, true));
addEventListener('unhandledrejection', (e) => say(String(e.reason?.message ?? e.reason), true));

// ── Saved progress ────────────────────────────────────────────────────────────────────────────────────
// One JSON document: progress.json in NakliOS storage when the host offers it, else localStorage. The SDK's
// autosave decides when to write (soon after a change, at once when the page hides or the window closes).

const LOCAL_KEY = 'vocella:progress';
let useHostFs = false;

async function persist() {
  const text = store.toJSON();
  if (useHostFs) await naklios.fs.write('progress.json', text);
  else {
    try {
      localStorage.setItem(LOCAL_KEY, text);
    } catch (e) {
      throw new Error(`Progress could not be saved in this browser (${/** @type {Error} */ (e).message}). Export it to keep it.`);
    }
  }
}

/** @type {{ markDirty: () => void }} */
let saver = { markDirty: () => {} };
const store = createStore({ changed: () => saver.markDirty() });
try {
  store.load(localStorage.getItem(LOCAL_KEY));
} catch {
  // storage blocked, or an unreadable copy: start empty; the next save replaces it
}
if (typeof naklios?.fs?.autosave === 'function') {
  saver = naklios.fs.autosave({ save: persist, delay: 1000, onError: (/** @type {Error} */ e) => say(`Saving progress failed: ${e.message}`, true) });
} else {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  saver = { markDirty: () => (clearTimeout(timer), (timer = setTimeout(() => persist().catch((e) => say(e.message, true)), 1000))) };
}

/** Switch to NakliOS storage once the host says it is there; its copy wins over the browser's. */
async function adoptHostFs() {
  if (useHostFs || !naklios?.capabilities?.fs) return;
  useHostFs = true;
  try {
    if (await naklios.fs.exists('progress.json')) store.load(await naklios.fs.read('progress.json'));
    else await persist();
    draw();
  } catch (e) {
    say(`Could not read saved progress from NakliOS: ${/** @type {Error} */ (e).message}`, true);
  }
}

// ── Reader ───────────────────────────────────────────────────────────────────────────────────────────

// Package media becomes blob: URLs the card frame may load (its CSP allows blob:); freed when another opens.
/** @type {string[]} */
let blobUrls = [];
const reader = new Reader(loadSql, fetchBytes, {
  store,
  mediaUrl: (name, bytes) => {
    const url = URL.createObjectURL(new Blob([/** @type {BlobPart} */ (bytes)], { type: mediaType(name) }));
    blobUrls.push(url);
    return url;
  },
  releaseMedia: () => {
    blobUrls.forEach((u) => URL.revokeObjectURL(u));
    blobUrls = [];
  },
});

// ── Drawing ──────────────────────────────────────────────────────────────────────────────────────────

/** @param {HTMLElement} el @param {boolean} show */
const show = (el, show) => (el.hidden = !show);

function draw() {
  drawTheme();
  const inDeck = reader.cards.length > 0;
  setTitle();
  show(viewer, inDeck);
  show(shelf, !inDeck);
  if (inDeck) drawCard();
  else drawShelf();
}

function drawCard() {
  const c = reader.current();
  const study = c.mode === 'study';
  const answer = c.side === 'answer';
  $('deck-name').textContent = c.deck;
  $('position').textContent = c.done
    ? 'Done for now'
    : study
      ? `Study · ${c.total} left · ${c.side}${c.flag ? ` · flag ${c.flag}` : ''}`
      : `${c.position} / ${c.total}${c.shuffled ? ' · shuffled' : ''} · ${c.side}`;
  show($('shuffle-btn'), !study);
  $('shuffle-btn').setAttribute('aria-pressed', String(c.shuffled));
  show($('speak-btn'), c.speech.length > 0);
  show($('download-btn'), Boolean(reader.built));
  show($('study-btn'), !study);
  show($('browse-btn'), study);
  $('browse-btn').dataset.deckId = reader.deckId;
  show($('prev-btn'), !study);
  show($('next-btn'), !study);
  show($('flip-btn'), !c.done && !(study && answer));
  show($('rate-bar'), study && answer && !c.done);
  show($('study-tools'), study && !c.done);
  $('flag-btn').dataset.flag = String((c.flag + 1) % 5);
  $('flag-btn').textContent = c.flag ? `Flag ${c.flag}` : 'Flag';
  if (c.intervals) for (const n of ['1', '2', '3', '4']) $(`iv-${n}`).textContent = c.intervals[n];
  frame.srcdoc = cardDocument(c.html, c.css, c.ord, reader.theme === 'dark');
  frame.title = c.done ? c.text : `Card ${c.position} of ${c.total}, ${c.side}: ${c.text}`;
}

// The card frame runs no scripts; the page wires its Speak buttons, type-in box and keys after each load.
frame.addEventListener('load', () => {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.querySelectorAll('.vc-speak').forEach((b) =>
    b.addEventListener('click', () => speak([{ lang: /** @type {HTMLElement} */ (b).dataset.lang ?? '', text: /** @type {HTMLElement} */ (b).dataset.text ?? '' }])),
  );
  const box = /** @type {HTMLInputElement | null} */ (doc.querySelector('.vc-typeans'));
  if (box) {
    box.focus();
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        dispatch('flip');
      }
    });
  }
  doc.addEventListener('keydown', onKey);
});

/** @param {{ lang: string, text: string }[]} parts */
function speak(parts) {
  if (!('speechSynthesis' in window)) return say('This browser cannot read text aloud.', true);
  speechSynthesis.cancel();
  for (const p of parts) {
    const u = new SpeechSynthesisUtterance(p.text);
    if (p.lang) u.lang = p.lang.replace('_', '-');
    speechSynthesis.speak(u);
  }
}

function drawTheme() {
  const dark = reader.theme === 'dark';
  document.documentElement.dataset.theme = reader.theme;
  $('theme-btn').textContent = dark ? 'Light' : 'Dark';
  $('theme-btn').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  applyHostTheme(hostTheme);
}

function drawShelf() {
  if (reader.catalog && !library.childElementCount) {
    library.replaceChildren(
      ...reader.shelf().map((d) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.dataset.command = 'open-shelf-deck';
        b.dataset.id = d.id;
        b.append(span('native', d.native), span('title', d.title), span('meta', `${d.level} · ${d.notes} words · for ${d.know} speakers`));
        li.append(b);
        return li;
      }),
    );
  }
  const st = reader.stats();
  $('stats').textContent = st.cardsStudied
    ? `Today: ${st.reviewsToday} reviews, ${st.newToday} new. Streak: ${st.streak} ${st.streak === 1 ? 'day' : 'days'}. ${st.cardsStudied} cards studied.`
    : 'No reviews yet. Open a deck and press Study.';
  /** @type {HTMLInputElement} */ ($('new-limit')).value = String(st.newPerDay);
  if (reader.col) {
    $('yours-title').textContent = reader.shelfId ? 'Open deck' : reader.built ? 'Built deck' : 'Your deck';
    $('shelf-empty').textContent = `${reader.fileName} · ${reader.col.format}`;
    deckList.replaceChildren(
      ...reader.decks().map((d) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.dataset.command = 'open-deck';
        b.dataset.deckId = d.id;
        b.style.paddingLeft = `${0.9 + d.depth * 1.25}rem`;
        b.append(span('', d.name.split('::').at(-1) ?? d.name), span('count', `${d.cards} cards`));
        const s = document.createElement('button');
        s.dataset.command = 'study-deck';
        s.dataset.deckId = d.id;
        s.textContent = 'Study';
        li.append(b, s);
        return li;
      }),
    );
  }
}

/** @param {string} cls @param {string} text */
function span(cls, text) {
  const el = document.createElement('span');
  if (cls) el.className = cls;
  el.textContent = text;
  return el;
}

// ── Deck picker ──────────────────────────────────────────────────────────────────────────────────────

/** Fill the deck picker from AnkiGen's languages and topics. Defaults: Spanish, for English speakers, Core I. */
async function drawPicker() {
  const { languages, modules } = await reader.deckOptions();
  const option = (/** @type {string} */ value, /** @type {string} */ label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  };
  const learn = /** @type {HTMLSelectElement} */ ($('pick-learn'));
  const know = /** @type {HTMLSelectElement} */ ($('pick-know'));
  learn.replaceChildren(...languages.map((l) => option(l.code, `${l.name} · ${l.native}`)));
  know.replaceChildren(...languages.map((l) => option(l.code, l.name)), option('=', 'Same language (definitions)'));
  learn.value = 'es';
  know.value = 'en';
  const box = $('pick-modules');
  box.replaceChildren();
  let category = '';
  for (const m of modules) {
    if (m.category !== category) {
      category = m.category;
      const h = document.createElement('h3');
      h.textContent = category;
      box.append(h);
    }
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = m.id;
    input.checked = m.id === 'core-1';
    input.dataset.name = m.name;
    label.append(input, `${m.name}${m.adult ? ' (18+)' : ''}`);
    box.append(label);
  }
  box.addEventListener('change', countTopics);
  countTopics();
}

function pickedTopics() {
  return /** @type {HTMLInputElement[]} */ ([...$('pick-modules').querySelectorAll('input:checked')]);
}

function countTopics() {
  const picked = pickedTopics();
  $('pick-count').textContent = picked.length === 0 ? 'none' : picked.length <= 2 ? picked.map((i) => i.dataset.name).join(', ') : `${picked.length} selected`;
}

function pickerArgs() {
  return {
    learn: /** @type {HTMLSelectElement} */ ($('pick-learn')).value,
    know: /** @type {HTMLSelectElement} */ ($('pick-know')).value,
    modules: pickedTopics().map((i) => i.value),
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────────

/** Save bytes or text as a file the person downloads. @param {BlobPart} data @param {string} name @param {string} type */
function saveFile(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Dispatch a UI command through the manifest. @param {string} name @param {any} [args] */
async function dispatch(name, args = {}) {
  if (name === 'import-deck') return fileInput.click();
  if (name === 'import-progress' && args.json === undefined) return progressInput.click();
  if (name === 'build-deck') args = pickerArgs();
  if (name === 'flip' && reader.side === 'question') {
    const box = /** @type {HTMLInputElement | null | undefined} */ (frame.contentDocument?.querySelector('.vc-typeans'));
    if (box) args = { typed: box.value };
  }
  const slow = { 'open-shelf-deck': 'Opening deck…', 'build-deck': 'Building deck…' }[name];
  try {
    if (slow) say(slow);
    const out = await run(reader, name, args, { person: true });
    if (slow) say('');
    if (name === 'download-deck') saveFile(out.bytes, out.fileName, 'application/octet-stream');
    if (name === 'export-progress') saveFile(out, `vocella-progress-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    if (name === 'import-progress') say('Progress imported.');
    if (name === 'speak-card') speak(out);
    draw();
  } catch (e) {
    say(/** @type {Error} */ (e).message, true);
  }
}

/** @param {File} file */
async function openFile(file) {
  say(`Opening ${file.name}…`);
  try {
    const info = await reader.load(new Uint8Array(await file.arrayBuffer()), file.name);
    say(`${info.file}: ${info.decks.length} decks, ${info.notes} notes, ${info.cards} cards.`);
    draw();
  } catch (e) {
    say(`${file.name}: ${/** @type {Error} */ (e).message}`, true);
  }
}

document.addEventListener('click', (e) => {
  const b = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-command]'));
  if (!b) return;
  const d = b.dataset;
  dispatch(/** @type {string} */ (d.command), { deckId: d.deckId, id: d.id, rating: d.rating, flag: d.flag });
});

$('new-limit').addEventListener('change', (e) => dispatch('set-new-limit', { limit: /** @type {HTMLInputElement} */ (e.target).value }));

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) openFile(f);
  fileInput.value = '';
});

progressInput.addEventListener('change', async () => {
  const f = progressInput.files?.[0];
  progressInput.value = '';
  if (f) dispatch('import-progress', { json: await f.text() });
});

for (const ev of ['dragenter', 'dragover']) {
  document.addEventListener(ev, (e) => {
    e.preventDefault();
    yours.classList.add('drag');
  });
}
document.addEventListener('dragleave', () => yours.classList.remove('drag'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  yours.classList.remove('drag');
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

/** Keys: Space/Enter flip; arrows step when browsing; 1–4 rate after flipping in study mode. @param {KeyboardEvent} e */
function onKey(e) {
  if (!reader.cards.length || e.metaKey || e.ctrlKey || e.altKey) return;
  // Elements inside the card frame belong to another window, so `instanceof Element` misses them.
  const t = /** @type {any} */ (e.target);
  const target = /** @type {Element} */ (typeof t?.closest === 'function' ? t : document.body);
  if (target.closest('input, select')) return;
  // A focused button already turns Space and Enter into its own click.
  if (target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
  const study = reader.mode === 'study';
  /** @type {string | undefined} */
  let name = { ' ': 'flip', Enter: 'flip', ArrowRight: study ? undefined : 'next-card', ArrowLeft: study ? undefined : 'prev-card' }[e.key];
  /** @type {any} */
  let args = {};
  if (study && reader.side === 'answer' && /^[1-4]$/.test(e.key)) {
    name = 'rate';
    args = { rating: Number(e.key) };
  }
  if (study && reader.side === 'answer' && name === 'flip') name = undefined; // rate instead of flipping back
  if (name) {
    e.preventDefault();
    dispatch(name, args);
  }
}
document.addEventListener('keydown', onKey);

// The agent face: the same manifest and the same reader, minus person-only acts.
/** @type {any} */ (window).vocella = {
  tools: tools(),
  run: async (/** @type {string} */ name, /** @type {any} */ args) => {
    const out = await run(reader, name, args);
    draw();
    return out;
  },
};

// ── NakliOS host ─────────────────────────────────────────────────────────────────────────────────────
// Light is the default; the host's colours apply only when both Vocella and the host theme are light.

/** @param {string} hex */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** @type {{ colors?: Record<string, string> } | null} */
let hostTheme = null;

/** @param {{ colors?: Record<string, string> } | null} theme */
function applyHostTheme(theme) {
  hostTheme = theme;
  const c = theme?.colors;
  const root = document.documentElement.style;
  const light = reader.theme === 'light' && c && luminance(c.BODY) > 0.75 && luminance(c.INK) < 0.35;
  for (const [v, k] of [['--bg', 'BODY'], ['--fg', 'INK'], ['--accent', 'ACT'], ['--line', 'ROW']]) {
    if (light && c[k]) root.setProperty(v, c[k]);
    else root.removeProperty(v);
  }
}

function setTitle() {
  naklios?.title(reader.cards.length ? `Vocella — ${reader.current().deck.split('::').at(-1)}` : 'Vocella');
}

// Start: the catalog draws the shelf; sql.js loads alongside it.
loadSql().catch((e) => say(e.message, true));
naklios?.theme.onChange(applyHostTheme);
naklios?.onCapabilitiesChange?.(() => adoptHostFs());
drawTheme();
reader.loadCatalog().then(
  () => {
    draw();
    drawPicker().catch((e) => say(`Could not load AnkiGen's languages: ${e.message}`, true));
    naklios?.ready();
    naklios?.theme.request();
    naklios?.requestCapabilities?.();
  },
  (e) => {
    say(`Could not load the deck catalog: ${e.message}`, true);
    naklios?.ready();
  },
);
