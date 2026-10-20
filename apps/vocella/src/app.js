// The page: wires the buttons, keys and file drop to the command manifest, and draws what the reader says.

import { Reader } from './reader.js';
import { run, tools } from './commands.js';
import { cardDocument } from './render.js';

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const status = $('status');
const shelf = $('shelf');
const viewer = $('viewer');
const deckList = $('decks');
const library = $('library');
const yours = $('yours');
const frame = /** @type {HTMLIFrameElement} */ ($('card'));
const fileInput = /** @type {HTMLInputElement} */ ($('file'));
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

const reader = new Reader(loadSql, fetchBytes);

/** @param {string} msg @param {boolean} [error] */
function say(msg, error = false) {
  status.textContent = msg;
  status.classList.toggle('error', error);
}

// Every failure reaches the status line, so nothing fails silently.
addEventListener('error', (e) => say(e.message, true));
addEventListener('unhandledrejection', (e) => say(String(e.reason?.message ?? e.reason), true));

function draw() {
  const inDeck = reader.cards.length > 0;
  setTitle();
  viewer.hidden = !inDeck;
  shelf.hidden = inDeck;
  if (inDeck) {
    const c = reader.current();
    $('deck-name').textContent = c.deck;
    $('position').textContent = `${c.position} / ${c.total} · ${c.side}`;
    frame.srcdoc = cardDocument(c.html, c.css, c.ord, false);
    frame.title = `Card ${c.position} of ${c.total}, ${c.side}: ${c.text}`;
  } else {
    drawShelf();
  }
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
  const own = reader.col && !reader.shelfId;
  if (own) {
    $('shelf-empty').textContent = `${reader.fileName} · ${reader.col?.format}`;
    deckList.replaceChildren(
      ...reader.decks().map((d) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.dataset.command = 'open-deck';
        b.dataset.deckId = d.id;
        b.style.paddingLeft = `${0.9 + d.depth * 1.25}rem`;
        b.append(span('', d.name.split('::').at(-1) ?? d.name), span('count', `${d.cards} cards`));
        li.append(b);
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

/** Dispatch a UI command through the manifest. @param {string} name @param {any} [args] */
async function dispatch(name, args) {
  if (name === 'import-deck') return fileInput.click();
  if (name === 'build-deck') args = pickerArgs();
  const slow = { 'open-shelf-deck': 'Opening deck…', 'build-deck': 'Building deck…' }[name];
  try {
    if (slow) say(slow);
    await run(reader, name, args, { person: true });
    if (slow) say('');
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
  if (b) dispatch(/** @type {string} */ (b.dataset.command), { deckId: b.dataset.deckId, id: b.dataset.id });
});

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) openFile(f);
  fileInput.value = '';
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

document.addEventListener('keydown', (e) => {
  if (!reader.cards.length || e.metaKey || e.ctrlKey || e.altKey) return;
  const target = e.target instanceof Element ? e.target : document.body;
  if (target.closest('input')) return;
  // A focused button already turns Space and Enter into its own click.
  if (target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
  const name = { ' ': 'flip', Enter: 'flip', ArrowRight: 'next-card', ArrowLeft: 'prev-card' }[e.key];
  if (name) {
    e.preventDefault();
    dispatch(name);
  }
});


// The agent face: the same manifest and the same reader, minus person-only acts.
/** @type {any} */ (window).vocella = {
  tools: tools(),
  run: async (/** @type {string} */ name, /** @type {any} */ args) => {
    const out = await run(reader, name, args);
    draw();
    return out;
  },
};

// Vocella stays light by the owner's choice, so it takes the host's colours only from a light theme.

/** @param {string} hex */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** @param {{ colors?: Record<string, string> } | null} theme */
function applyTheme(theme) {
  const c = theme?.colors;
  const root = document.documentElement.style;
  const light = c && luminance(c.BODY) > 0.75 && luminance(c.INK) < 0.35;
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
naklios?.theme.onChange(applyTheme);
reader.loadCatalog().then(
  () => {
    draw();
    drawPicker().catch((e) => say(`Could not load AnkiGen's languages: ${e.message}`, true));
    naklios?.ready();
    naklios?.theme.request();
  },
  (e) => {
    say(`Could not load the deck catalog: ${e.message}`, true);
    naklios?.ready();
  },
);
