// The page: draws the library, wires every control to the command manifest, runs chat through the NakliOS
// model, and picks where the library lives (NakliOS Folder or Crate when connected, else this browser).

import { SPEAKERS, beforeSources, buildChat, citedRefs, esc, estimateTokens, mindmapSvg, parseOutline, parseScript, parseSlides, renderMarkdown, scriptMarkdown, studioRequest, summaryRequest, titleFrom } from './core.js';
import { pdfText } from './pdf.js';
import { Library, hostFs, opfsFs } from './store.js';
import { COMMANDS, railCommands, run, searchNotebook } from './commands.js';

/** The NakliOS SDK, inlined in index.html; a no-op when Lectella runs standalone. */
const naklios = /** @type {any} */ (window).naklios;
const caps = () => naklios?.capabilities ?? {};
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const dlg = (/** @type {string} */ id) => /** @type {HTMLDialogElement} */ ($(id));

// ── Errors and messages ──────────────────────────────────────────────────────────────────────────────

/** @param {string} msg @param {{ error?: boolean, action?: { label: string, run: () => void }, actions?: { label: string, run: () => void }[] }} [opts] */
function banner(msg, { error = false, action, actions = action ? [action] : [] } = {}) {
  const b = $('banner');
  b.hidden = !msg;
  b.classList.toggle('error', error);
  b.innerHTML = `<span>${esc(msg)}</span>`;
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.onclick = a.run;
    b.append(btn);
  }
  if (msg) {
    const close = document.createElement('button');
    close.className = 'link small';
    close.textContent = 'Dismiss';
    close.onclick = () => (b.hidden = true);
    b.append(close);
  }
}
const fail = (/** @type {any} */ e) => banner(String(e?.message ?? e), { error: true });
// Every failure reaches the banner, so nothing fails silently.
addEventListener('error', (e) => fail(e.message));
addEventListener('unhandledrejection', (e) => fail(e.reason));

/**
 * Resolves with the dialog's return value once it closes. Chrome fires a dialog's `close` event only at the next
 * rendering step, which a hidden tab never reaches, so this also listens for the form's submit, Escape, and `shut`.
 * @param {HTMLDialogElement} d @returns {Promise<string>}
 */
function closed(d) {
  return new Promise((resolve) => {
    const form = d.querySelector('form');
    const done = (/** @type {string} */ v) => {
      form?.removeEventListener('submit', onSubmit);
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('close', onClose);
      d.removeEventListener('shut', onShut);
      resolve(v);
    };
    const onSubmit = (/** @type {SubmitEvent} */ e) => done(/** @type {HTMLButtonElement | null} */ (e.submitter)?.value ?? '');
    const onCancel = () => done('');
    const onClose = () => done(d.returnValue);
    const onShut = (/** @type {any} */ e) => done(e.detail);
    form?.addEventListener('submit', onSubmit);
    d.addEventListener('cancel', onCancel);
    d.addEventListener('close', onClose);
    d.addEventListener('shut', onShut);
  });
}
/** Close a dialog from code with a return value, and tell `closed` at once. @param {HTMLDialogElement} d @param {string} v */
function shut(d, v) {
  d.close(v);
  d.dispatchEvent(new CustomEvent('shut', { detail: v }));
}

/**
 * A styled question in place of confirm() and prompt().
 * @param {{ title: string, text: string, ok?: string, danger?: boolean, value?: string }} q
 * @returns {Promise<string | boolean | null>}
 */
function ask({ title, text, ok = 'OK', danger = false, value }) {
  const d = dlg('dlg-ask');
  $('ask-title').textContent = title;
  $('ask-text').textContent = text;
  const input = /** @type {HTMLInputElement} */ ($('ask-input'));
  input.hidden = value === undefined;
  input.value = value ?? '';
  const okBtn = $('ask-ok');
  okBtn.textContent = ok;
  okBtn.className = danger ? 'primary danger' : 'primary';
  if (danger) okBtn.style.background = 'var(--err)';
  else okBtn.style.background = '';
  d.returnValue = '';
  d.showModal();
  if (value !== undefined) input.select();
  return closed(d).then((rv) => (rv === 'ok' ? (value === undefined ? true : input.value) : value === undefined ? false : null));
}

// ── Where the library lives ──────────────────────────────────────────────────────────────────────────

/** @type {Library} */
let lib = new Library(opfsFs());
/** 'browser' or the NakliOS backend id ('fsa' or 'crate'). */
let where = 'browser';
let disconnected = false;
let lastIndexWrite = '';
/** False until the first capability report has been handled. */
let settled = false;

/** Wrap an adapter so writes refuse while NakliOS storage is disconnected, and remember our own index writes. @param {import('./store.js').Fs} fs */
function guarded(fs) {
  return {
    ...fs,
    /** @param {string} p @param {string | Uint8Array} d */
    async write(p, d) {
      if (disconnected) throw new Error('Your NakliOS storage is disconnected, so this change was not saved. Reconnect it in NakliOS to keep working.');
      if (p === 'library.json') lastIndexWrite = /** @type {string} */ (d);
      return fs.write(p, d);
    },
    /** @param {string} p */
    async delete(p) {
      if (disconnected) throw new Error('Your NakliOS storage is disconnected, so nothing was deleted.');
      return fs.delete(p);
    },
  };
}

const label = (/** @type {string} */ w) => (w === 'browser' ? 'this browser' : (caps().fsBackends ?? []).find((/** @type {any} */ b) => b.id === w)?.label ?? w);

/** The person chose this browser's library over NakliOS storage (a per-viewer setting). */
let preferBrowser = false;
try {
  preferBrowser = localStorage.getItem('lectella:where') === 'browser';
} catch {
  // storage blocked: follow NakliOS storage
}
let askedStorage = false;

function drawStore() {
  const sel = /** @type {HTMLSelectElement} */ ($('where'));
  const c = caps();
  const backends = c.hosted && c.fs ? c.fsBackends ?? [] : [];
  sel.innerHTML = '';
  for (const [id, text] of [['browser', 'This browser'], ...backends.map((/** @type {any} */ b) => [b.id, `${b.label}${b.name ? ` (${b.name})` : ''}`])]) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = text;
    sel.append(o);
  }
  sel.value = where === 'init' ? 'browser' : where;
  sel.disabled = backends.length === 0;
  sel.classList.toggle('err', disconnected);
  sel.title = disconnected
    ? `Your ${label(where)} is disconnected; changes are refused until it is back.`
    : where === 'browser'
      ? 'Kept in this browser\'s private storage. In NakliOS, pick your Folder or Crate to keep it on your own disk.'
      : 'Kept as plain files under apps/lectella/ in your NakliOS storage.';
}

/** Keep the library in this browser, or on a NakliOS backend ('fsa' or 'crate'). Each is a separate library. @param {string} id */
async function chooseStorage(id) {
  preferBrowser = id === 'browser';
  try {
    localStorage.setItem('lectella:where', preferBrowser ? 'browser' : 'host');
  } catch {
    // a per-viewer convenience only
  }
  $('banner').hidden = true;
  if (preferBrowser) return openLibrary('browser');
  if (caps().fsBackend === id) return openLibrary(id);
  // NakliOS binds the backend and re-sends capabilities; onCaps then opens the library there.
  await naklios.fs.useBackend(id);
}

/** @type {null | (() => void)} */
let stopWatch = null;

/** Open the library at a location. Locations are separate libraries; nothing is copied between them. @param {string} next */
async function openLibrary(next) {
  if (noteSaver?.dirty) await noteSaver.flush().catch(fail);
  const fs = next === 'browser' ? opfsFs() : hostFs(naklios);
  const fresh = new Library(guarded(fs));
  await fresh.load();
  const before = where;
  lib = fresh;
  where = next;
  disconnected = false;
  current = lib.findNotebook(current ?? '')?.id ?? lib.notebooks()[0]?.id ?? null;
  turns = current ? await lib.chat(current) : [];
  stopWatch?.();
  stopWatch = null;
  if (next !== 'browser' && naklios?.fs?.subscribe) {
    stopWatch = await naklios.fs.subscribe('library.json', onRemoteChange).catch(() => null);
  }
  // The first move from the start-up browser library to NakliOS storage is the normal start, not news.
  if (before !== next && before !== 'init' && !(before === 'browser' && !settled)) {
    banner(`Now showing your library in ${next === 'browser' ? 'this browser' : `your ${label(next)}`}. The library in ${before === 'browser' ? 'this browser' : `your ${label(before)}`} is kept as it was; nothing was copied.`);
  }
  draw();
}

let reloadTimer = 0;
/** A change to library.json from elsewhere (another window, another device through Crate). */
function onRemoteChange() {
  clearTimeout(reloadTimer);
  reloadTimer = /** @type {any} */ (setTimeout(async () => {
    try {
      // A new, empty library has no index yet; a watch event can arrive before the first write.
      if (!(await lib.fs.exists('library.json'))) return;
      const text = await lib.fs.read('library.json');
      if (text === lastIndexWrite) return; // our own write, seen by the folder poll
      if (noteSaver?.dirty) {
        banner('This library changed in another window or device.', { action: { label: 'Reload it', run: () => openLibrary(where).catch(fail) } });
        return;
      }
      await openLibrary(where);
    } catch (e) {
      fail(e);
    }
  }, 400));
}

/** Follow NakliOS storage: use it when it is connected, and refuse writes when it goes away. */
async function onCaps() {
  const c = caps();
  drawAi();
  if (c.hosted && c.fs && c.fsBackend && !preferBrowser) {
    if (where !== c.fsBackend || disconnected) await openLibrary(c.fsBackend);
  } else if (c.hosted && c.fs && !c.fsBackend && !preferBrowser) {
    // Connected storage, but no backend chosen for Lectella yet: NakliOS leaves that choice to the person.
    if (!askedStorage) {
      askedStorage = true;
      const opts = (c.fsBackends ?? []).map((/** @type {any} */ b) => ({ label: `Use my ${b.label}`, run: () => chooseStorage(b.id).catch(fail) }));
      banner('Where should Lectella keep its library? Until you choose, it stays in this browser.', { actions: [...opts, { label: 'Keep in this browser', run: () => chooseStorage('browser').catch(fail) }] });
    }
  } else if (where !== 'browser' && !preferBrowser && !disconnected) {
    disconnected = true;
    banner(`Your ${label(where)} is disconnected. You can read what is open; changes are refused until it is back.`, { error: true });
  }
  drawStore();
  settled = true;
  registerCommands();
}

// ── Model ────────────────────────────────────────────────────────────────────────────────────────────

const aiOn = () => !!(caps().hosted && caps().ai);
/** Tokens of context the chat may send: small for the in-browser model, larger for an endpoint. */
const budget = () => (caps().aiLocal ? 2400 : 24000);

function drawAi() {
  const s = $('ai-status');
  const c = caps();
  if (aiOn()) {
    s.className = c.aiState === 'error' ? 'err' : '';
    const name = c.aiModelLabel || c.aiModel || 'NakliOS model';
    s.textContent = `Chat: ${name}${/on-device|device|browser/i.test(name) ? '' : c.aiLocal ? ' (on this device)' : ' (your endpoint)'}${c.aiState && c.aiState !== 'ready' && c.aiState !== 'idle' ? ` · ${c.aiState}` : ''}`;
  } else if (c.hosted) {
    s.innerHTML = 'Chat is off: <button class="link" id="ai-settings">choose a model in NakliOS</button>';
    $('ai-settings').onclick = () => naklios.openSettings?.('ai');
  } else s.textContent = 'Chat needs NakliOS; search works here';
  const send = /** @type {HTMLButtonElement} */ ($('send'));
  send.disabled = !aiOn() || busy;
  $('chat-hint').textContent = aiOn() ? 'Enter sends · Shift+Enter adds a line' : c.hosted ? 'Pick a model in NakliOS Settings → AI to chat' : 'Open Lectella inside NakliOS to chat with your sources';
}

// ── State and drawing ────────────────────────────────────────────────────────────────────────────────

/** @type {string | null} */
let current = null;
/** @type {import('./store.js').Turn[]} */
let turns = [];
let busy = false;
/** @type {AbortController | null} */
let abort = null;
let tab = 'chat';

const ago = (/** @type {number} */ t) => {
  const s = (Date.now() - t) / 1000;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
};

function draw() {
  drawStore();
  drawAi();
  const list = $('nb-list');
  list.innerHTML = '';
  for (const nb of lib.notebooks()) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.setAttribute('aria-current', String(nb.id === current));
    b.innerHTML = `${esc(nb.name)} <span class="count">${nb.sources.length}·${nb.notes.length}</span>`;
    b.title = `${nb.name}: ${nb.sources.length} sources, ${nb.notes.length} notes`;
    b.onclick = () => selectNotebook(nb.id).catch(fail);
    li.append(b);
    list.append(li);
  }
  const nb = current ? lib.findNotebook(current) : null;
  $('welcome').hidden = !!nb;
  for (const id of ['nb-head', 'cols', 'tabs']) $(id).hidden = !nb;
  if (!nb) {
    naklios?.title?.('Lectella');
    return;
  }
  naklios?.title?.(`Lectella — ${nb.name}`);
  $('nb-name').textContent = nb.name;
  $('nb-desc').textContent = nb.description;
  for (const t of document.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (t).dataset.tab === tab));
  for (const c of document.querySelectorAll('[data-col]')) c.classList.toggle('active', /** @type {HTMLElement} */ (c).dataset.col === tab);
  drawItems(nb);
  drawChat();
  drawContext().catch(fail);
}

/** @param {import('./store.js').Notebook} nb */
function drawItems(nb) {
  const sl = $('source-list');
  sl.innerHTML = '';
  const sources = lib.sourcesOf(nb.id);
  if (!sources.length) sl.innerHTML = '<li class="empty">No sources yet. Add one to start.</li>';
  for (const s of sources) sl.append(itemRow(nb, s.id, s.title, `${s.chars.toLocaleString()} characters · ${s.kind === 'text' ? 'text' : s.kind}`, () => openSource(s.id)));
  const nl = $('note-list');
  nl.innerHTML = '';
  const notes = lib.notesOf(nb.id);
  if (!notes.length) nl.innerHTML = '<li class="empty">No notes yet. Write one, or save a chat answer.</li>';
  for (const n of notes) nl.append(itemRow(nb, n.id, n.title, `${n.kind === 'ai' ? 'From chat' : 'Written'} · ${ago(n.updated)}`, () => openNote(n.id)));
}

/** @param {import('./store.js').Notebook} nb @param {string} id @param {string} title @param {string} meta @param {() => Promise<void>} open */
function itemRow(nb, id, title, meta, open) {
  const li = document.createElement('li');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = !nb.off.includes(id);
  box.title = 'Include in chat';
  box.setAttribute('aria-label', `Include ${title} in chat`);
  box.dataset.command = 'context.set';
  box.onchange = () => act('context.set', { notebook: nb.id, item: id, on: box.checked }).then(() => drawContext()).catch(fail);
  const b = document.createElement('button');
  b.className = 'item';
  b.innerHTML = `<span class="t">${esc(title)}</span><span class="m">${esc(meta)}</span>`;
  b.onclick = () => open().catch(fail);
  li.append(box, b);
  return li;
}

async function drawContext() {
  if (!current) return;
  const items = await lib.contextItems(current);
  const tokens = items.reduce((n, it) => n + estimateTokens(it.text), 0);
  const sources = items.filter((i) => i.kind === 'source').length;
  const notes = items.length - sources;
  const fits = tokens <= budget() - 600;
  $('context-summary').textContent = items.length
    ? `In chat: ${sources} source${sources === 1 ? '' : 's'}, ${notes} note${notes === 1 ? '' : 's'}, about ${tokens.toLocaleString()} tokens.${aiOn() && !fits ? ' That is more than this model takes, so each question sends the best-matching passages.' : ''}`
    : 'Nothing is switched on for chat. Tick a source or note.';
}

function drawChat() {
  const box = $('chat');
  box.innerHTML = '';
  if (!turns.length) {
    box.innerHTML = `<p class="empty">${aiOn() ? 'Ask about your sources. Answers cite them with numbers you can click.' : 'Chat answers come from the model you choose in NakliOS. You can still add sources, write notes and search.'}</p>`;
  }
  turns.forEach((t, idx) => box.append(turnEl(t, idx)));
  const scroller = /** @type {HTMLElement} */ (box.parentElement);
  scroller.scrollTop = scroller.scrollHeight;
}

/** @param {import('./store.js').Turn} t @param {number} idx */
function turnEl(t, idx) {
  const el = document.createElement('div');
  el.className = `turn ${t.role}`;
  if (t.role === 'user') {
    el.textContent = t.content;
    return el;
  }
  const md = document.createElement('div');
  md.className = 'md';
  md.innerHTML = renderMarkdown(t.content || '…', { cite: true });
  el.append(md);
  const refs = t.refs ?? [];
  const used = citedRefs(t.content, refs);
  if (used.length) {
    const ol = document.createElement('ol');
    ol.className = 'refs';
    for (const r of used) {
      const li = document.createElement('li');
      li.value = r.n;
      const b = document.createElement('button');
      b.className = 'link';
      b.textContent = `${r.title}${r.chunk !== undefined ? `, passage ${r.chunk + 1}` : ''}`;
      b.onclick = () => openRef(r).catch(fail);
      li.append(b);
      ol.append(li);
    }
    el.append(ol);
  }
  md.querySelectorAll('button.cite').forEach((b) => {
    const r = refs.find((x) => x.n === Number(/** @type {HTMLElement} */ (b).dataset.cite));
    if (r) {
      /** @type {HTMLElement} */ (b).title = r.title;
      /** @type {HTMLElement} */ (b).onclick = (e) => (e.preventDefault(), openRef(r).catch(fail));
    } else /** @type {HTMLButtonElement} */ (b).disabled = true;
  });
  if (t.content && !(busy && idx === turns.length - 1)) {
    const meta = document.createElement('div');
    meta.className = 'meta';
    const mode = t.mode === 'passages' ? 'Answered from the best-matching passages' : t.mode === 'full' ? 'Answered from the full text in chat' : 'Answered with no sources in chat';
    meta.innerHTML = `<span>${esc(mode)}</span>`;
    const save = document.createElement('button');
    save.className = 'link';
    save.textContent = 'Save to note';
    save.dataset.command = 'chat.save-note';
    save.onclick = () => saveAnswer(idx).catch(fail);
    meta.append(save);
    el.append(meta);
  }
  return el;
}

/** @param {string} id */
async function selectNotebook(id) {
  if (busy) abort?.abort();
  current = id;
  turns = await lib.chat(id);
  $('hits').hidden = true;
  /** @type {HTMLInputElement} */ ($('search')).value = '';
  draw();
}

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────

/** Run a command from the page and redraw. @param {string} name @param {any} args */
async function act(name, args) {
  const out = await run(lib, name, args);
  await afterCommand();
  return out;
}

/** Redraw after any command; open the newest notebook when none is open (an agent may have made the first). */
async function afterCommand() {
  if (!current || !lib.findNotebook(current)) {
    current = lib.notebooks()[0]?.id ?? null;
    turns = current ? await lib.chat(current) : [];
  }
  draw();
}

async function editNotebook(/** @type {boolean} */ isNew) {
  const d = dlg('dlg-notebook');
  const form = /** @type {HTMLFormElement} */ (d.querySelector('form'));
  const nb = isNew ? null : lib.findNotebook(current ?? '');
  $('dlg-notebook-title').textContent = nb ? 'Edit notebook' : 'New notebook';
  form.elements.namedItem('name').value = nb?.name ?? '';
  form.elements.namedItem('description').value = nb?.description ?? '';
  /** @type {HTMLElement} */ (d.querySelector('[data-command="notebook.delete"]')).hidden = !nb;
  d.returnValue = '';
  d.showModal();
  const rv = await closed(d);
  if (rv === 'delete' && nb) {
    const okay = await ask({ title: `Delete “${nb.name}”?`, text: `This deletes its ${nb.notes.length} notes and its chat. Sources that no other notebook uses are deleted too. This cannot be undone.`, ok: 'Delete', danger: true });
    if (okay) {
      await act('notebook.delete', { notebook: nb.id });
      current = lib.notebooks()[0]?.id ?? null;
      turns = current ? await lib.chat(current) : [];
      draw();
    }
    return;
  }
  if (rv !== 'ok') return;
  const name = form.elements.namedItem('name').value;
  const description = form.elements.namedItem('description').value;
  if (nb) await act('notebook.update', { notebook: nb.id, name, description });
  else {
    const made = await act('notebook.create', { name, description });
    await selectNotebook(made.id);
  }
}

/**
 * Add one file's bytes as a source. PDF, Markdown and text; anything else is refused with a message.
 * @param {string} nbId @param {string} name @param {Uint8Array} bytes @param {string} [from] where it came from
 * @returns {Promise<'added' | 'linked' | false>}
 */
async function importBytes(nbId, name, bytes, from = 'file') {
  const isPdf = /\.pdf$/i.test(name);
  if (!isPdf && !/\.(md|markdown|txt)$/i.test(name)) {
    banner(`${name} is not a PDF, text or Markdown file. Web pages and audio come in a later version.`, { error: true });
    return false;
  }
  if (bytes.length > 50 * 1024 * 1024) {
    banner(`${name} is larger than 50 MB, so it was not added.`, { error: true });
    return false;
  }
  const nbName = lib.notebook(nbId).name;
  // The same file sent or picked again is not read or stored twice.
  const known = await lib.hasFile(nbId, bytes);
  if (known) {
    banner(`${name} is already in “${nbName}” as “${known.title}”.`);
    return false;
  }
  /** @type {{ title: string, text: string, kind: string, origin: string }} */
  let input;
  if (isPdf) {
    banner(`Reading ${name}…`);
    let out;
    try {
      out = await pdfText(bytes, { onPage: (n, total) => banner(`Reading ${name}: page ${n} of ${total}…`) });
    } catch (e) {
      banner(`${name}: ${/** @type {any} */ (e)?.message ?? e}`, { error: true });
      return false;
    }
    input = { title: out.title || name.replace(/\.pdf$/i, ''), text: out.text, kind: 'pdf', origin: `${from} · ${out.pages} page${out.pages === 1 ? '' : 's'}` };
  } else {
    input = { title: name.replace(/\.(md|markdown|txt)$/i, ''), text: new TextDecoder().decode(bytes), kind: /\.(md|markdown)$/i.test(name) ? 'markdown' : 'text', origin: from };
  }
  const { source, status } = await lib.importSource(nbId, { ...input, original: { name, bytes } });
  if (status === 'present') {
    banner(`${name} is already in “${nbName}” as “${source.title}”.`);
    return false;
  }
  if (status === 'linked') banner(`${name} was already in another notebook, so “${nbName}” now links that copy.`);
  return status;
}

/** @param {File[]} files */
async function importFiles(files) {
  if (!current) throw new Error('Create a notebook first');
  const nbId = current;
  let added = 0;
  for (const f of files) {
    const name = f.type === 'application/pdf' && !/\.pdf$/i.test(f.name) ? `${f.name}.pdf` : f.name;
    if ((await importBytes(nbId, name, new Uint8Array(await f.arrayBuffer()))) === 'added') added++;
  }
  draw();
  if (added) banner(`Added ${added} source${added === 1 ? '' : 's'}.`);
}

/** The notebook a file sent from another app lands in: the open one, else a new "Inbox". */
async function inboxNotebook() {
  if (current && lib.findNotebook(current)) return current;
  const nb = lib.findNotebook('Inbox') ?? (await lib.createNotebook({ name: 'Inbox', description: 'Files sent to Lectella from other apps' }));
  current = nb.id;
  turns = await lib.chat(nb.id);
  return nb.id;
}

/** A file another NakliOS app sent with "Send to": a read-only copy, added as a source. @param {any} grant */
async function onSent(grant) {
  if (grant.kind !== 'send') return;
  await started;
  // Wait for the first capability report, so the file lands in the Folder or Crate library, not the start-up one.
  for (let i = 0; i < 50 && !settled; i++) await new Promise((r) => setTimeout(r, 100));
  try {
    const file = await naklios.files.read(grant.token);
    const raw = file.bytes ?? file.data;
    const bytes = raw instanceof Uint8Array ? raw : typeof raw === 'string' ? new TextEncoder().encode(raw) : new Uint8Array(raw);
    const app = file.sourceAppId === 'books' ? 'Lorewell' : file.sourceAppId || 'another app';
    const nbId = await inboxNotebook();
    if ((await importBytes(nbId, file.name || grant.name, bytes, `sent from ${app}`)) === 'added') banner(`Added ${file.name || grant.name} from ${app} to “${lib.notebook(nbId).name}”.`);
    draw();
  } finally {
    naklios.files.release(grant.token);
  }
}

/** Model call without streaming; answers the text. @param {{ role: string, content: string }[]} messages @param {AbortSignal} signal */
async function complete(messages, signal, max_tokens = 700) {
  const res = await naklios.ai.chat.completions.create({ messages, max_tokens, signal });
  return String(res?.choices?.[0]?.message?.content ?? '').trim();
}

const STUDIO_KINDS = {
  briefing: { label: 'Briefing', title: 'Briefing', noun: 'briefing', tokens: 1200 },
  audio: { label: 'Audio overview', title: 'Audio overview', noun: 'audio overview', tokens: 1600 },
  mindmap: { label: 'Mind map', title: 'Mind map', noun: 'mind map', tokens: 700 },
  slides: { label: 'Slides', title: 'Slides', noun: 'slide deck', tokens: 1400 },
};

/**
 * Summarise each source switched on for chat, then combine the summaries into one studio note: a briefing, an
 * audio overview script, a mind map or a slide deck. Two steps, so a small in-browser model can do it.
 * @param {'briefing' | 'audio' | 'mindmap' | 'slides'} kind
 */
async function studio(kind) {
  const spec = STUDIO_KINDS[kind];
  if (!current) return;
  if (!aiOn()) return banner(`${spec.label} needs a model. Choose one in NakliOS Settings → AI.`, { error: true });
  if (busy) return banner('Wait for the current answer to finish.', { error: true });
  const nbId = current;
  const nb = lib.notebook(nbId);
  const sources = (await lib.contextItems(nbId)).filter((i) => i.kind === 'source');
  if (!sources.length) return banner(`Tick at least one source for chat, then make the ${spec.noun}.`, { error: true });
  busy = true;
  drawAi();
  const ctl = new AbortController();
  abort = ctl;
  const stop = { label: 'Stop', run: () => ctl.abort() };
  try {
    const parts = [];
    let cut = 0;
    for (const [i, src] of sources.entries()) {
      banner(`${spec.label}: summarising source ${i + 1} of ${sources.length}, “${src.title}”…`, { actions: [stop] });
      const req = summaryRequest(src, budget());
      if (req.cut) cut++;
      parts.push({ n: i + 1, title: src.title, summary: await complete(req.messages, ctl.signal, 500) });
    }
    banner(`${spec.label}: writing it…`, { actions: [stop] });
    let text = await complete(studioRequest(kind, nb, parts), ctl.signal, spec.tokens);
    if (!text) throw new Error(`The model returned an empty ${spec.noun}`);
    // Check the shape before saving, so a malformed answer is reported instead of saved.
    if (kind === 'audio') {
      const lines = parseScript(text);
      if (lines.length < 4) throw new Error('The model did not write a two-voice script. Try again, or choose a larger model in NakliOS.');
      text = scriptMarkdown(lines);
    } else if (kind === 'mindmap' && !parseOutline(text).children.length) {
      throw new Error('The model did not write an outline for the mind map. Try again, or choose a larger model in NakliOS.');
    } else if (kind === 'slides' && parseSlides(text).length < 2) {
      throw new Error('The model did not write slides. Try again, or choose a larger model in NakliOS.');
    }
    const refs = parts.map((p) => ({ n: p.n, kind: 'source', id: sources[p.n - 1].id, title: p.title }));
    const list = parts.map((p) => `${p.n}. ${p.title}`).join('\n');
    const note = cut ? `\n\n_${cut} long source${cut === 1 ? ' was' : 's were'} cut to fit the model before summarising._` : '';
    const n = await lib.addNote(nbId, { title: `${spec.title}: ${nb.name}`, body: `${text}\n\n**Sources**\n\n${list}${note}`, kind: 'ai', refs, format: kind === 'briefing' ? undefined : kind });
    banner(`The ${spec.noun} is saved as a note.`);
    draw();
    await openNote(n.id);
  } catch (e) {
    if (ctl.signal.aborted) banner(`${spec.label} stopped. Nothing was saved.`);
    else throw e;
  } finally {
    busy = false;
    abort = null;
    drawAi();
  }
}

/** English voices on this device, distinct ones first, for the two speakers. */
function voicesFor() {
  const all = speechSynthesis.getVoices();
  const en = all.filter((v) => /^en/i.test(v.lang));
  const pool = en.length ? en : all;
  const local = pool.filter((v) => v.localService);
  const pick = local.length >= 2 ? local : pool;
  return [pick[0] ?? null, pick.find((v) => v !== pick[0] && v.name.split(' ')[0] !== pick[0]?.name.split(' ')[0]) ?? pick[1] ?? pick[0] ?? null];
}

/** Read the open note aloud with this device's voices: an audio overview in two voices. A second press stops. */
function listen() {
  if (!('speechSynthesis' in window)) return banner('This browser has no speech voices.', { error: true });
  const btn = $('note-listen');
  if (speechSynthesis.speaking || speechSynthesis.pending) {
    speechSynthesis.cancel();
    btn.textContent = btn.dataset.idle ?? 'Listen';
    return;
  }
  const form = /** @type {HTMLFormElement} */ (dlg('dlg-note').querySelector('form'));
  const body = String(form.elements.namedItem('body').value);
  const clean = (/** @type {string} */ t) =>
    t
      .replace(/```[^]*?```/g, ' ')
      .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, '')
      .replace(/[#*_`>]/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const lines = openNoteFormat === 'audio' ? parseScript(body) : [{ speaker: '', text: `${form.elements.namedItem('title').value}. ${clean(beforeSources(body))}` }];
  const [a, b] = voicesFor();
  const rows = [...$('note-read').querySelectorAll('[data-line]')];
  lines.forEach((l, i) => {
    const u = new SpeechSynthesisUtterance(clean(l.text));
    const second = l.speaker === SPEAKERS[1];
    const voice = second ? b : a;
    if (voice) u.voice = voice;
    // With a single voice on the device, the second speaker still sounds different.
    if (second && a === b) u.pitch = 0.8;
    u.onstart = () => rows.forEach((r, j) => r.classList.toggle('speaking', j === i));
    if (i === lines.length - 1) u.onend = u.onerror = () => ((btn.textContent = btn.dataset.idle ?? 'Listen'), rows.forEach((r) => r.classList.remove('speaking')));
    speechSynthesis.speak(u);
  });
  btn.textContent = 'Stop';
}

async function addSource() {
  if (!current) return;
  const d = dlg('dlg-add');
  const form = /** @type {HTMLFormElement} */ (d.querySelector('form'));
  form.reset();
  d.returnValue = '';
  d.showModal();
  if ((await closed(d)) !== 'ok') return;
  const text = form.elements.namedItem('text').value;
  if (!text.trim()) return;
  const title = form.elements.namedItem('title').value.trim() || titleFrom(text);
  await act('source.add', { notebook: current, title, text });
}

/** @type {string | null} */
let openSourceId = null;

/** @param {string} id @param {number} [chunk] */
async function openSource(id, chunk) {
  const s = lib.source(id);
  const text = await lib.sourceText(id);
  openSourceId = id;
  $('src-title').textContent = s.title;
  $('src-meta').textContent = `${s.chars.toLocaleString()} characters · added ${ago(s.added)}`;
  const box = $('src-text');
  if (chunk !== undefined) {
    const c = (await lib.sourceChunks(id))[chunk];
    box.innerHTML = c ? `${esc(text.slice(0, c.start))}<mark id="hl">${esc(text.slice(c.start, c.end))}</mark>${esc(text.slice(c.end))}` : esc(text);
  } else box.textContent = text;
  const d = dlg('dlg-source');
  d.showModal();
  document.getElementById('hl')?.scrollIntoView({ block: 'center' });
}

/** @type {null | { markDirty(): void, flush(): Promise<void>, dirty: boolean, dispose?(): void }} */
let noteSaver = null;
/** @type {string | null} */
let openNoteId = null;

/** The open note's format: '' (Markdown), 'audio', 'mindmap' or 'slides'. */
let openNoteFormat = '';
let slideAt = 0;

/** Draw the open note's Read view from the editor's current text. */
function drawNoteRead() {
  const form = /** @type {HTMLFormElement} */ (dlg('dlg-note').querySelector('form'));
  const body = String(form.elements.namedItem('body').value);
  const box = $('note-read');
  const note = openNoteId ? lib.data.notes.find((n) => n.id === openNoteId) : null;
  const refs = note?.refs ?? [];
  const sourcesHtml = (/** @type {string} */ md) => {
    const tail = md.split(/\n\s*\*\*Sources\*\*\s*\n/)[1];
    return tail ? `<h4>Sources</h4>${renderMarkdown(tail)}` : '';
  };
  $('note-present').hidden = openNoteFormat !== 'slides';
  if (openNoteFormat === 'mindmap') {
    box.innerHTML = `<div class="mindmap">${mindmapSvg(parseOutline(body))}</div>${sourcesHtml(body)}`;
  } else if (openNoteFormat === 'slides') {
    const slides = parseSlides(body);
    slideAt = Math.min(slideAt, Math.max(0, slides.length - 1));
    const sl = slides[slideAt];
    box.innerHTML = sl
      ? `<div class="deck" id="deck" tabindex="0"><div class="slide${slideAt === 0 ? ' first' : ''}"><h3>${renderMarkdown(sl.title, { cite: true }).replace(/^<p>|<\/p>$/g, '')}</h3>${sl.subtitle ? `<p class="sub">${renderMarkdown(sl.subtitle).replace(/^<p>|<\/p>$/g, '')}</p>` : ''}${sl.bullets.length ? `<ul>${sl.bullets.map((b) => `<li>${renderMarkdown(b, { cite: true }).replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>` : ''}</div>` +
        `<div class="deck-nav"><button type="button" data-slide="-1" aria-label="Previous slide">‹</button><span>${slideAt + 1} / ${slides.length}</span><button type="button" data-slide="1" aria-label="Next slide">›</button></div></div>${sourcesHtml(body)}`
      : '<p class="empty">No slides in this note.</p>';
    box.querySelectorAll('[data-slide]').forEach((b) => ((/** @type {HTMLElement} */ (b)).onclick = () => moveSlide(Number(/** @type {HTMLElement} */ (b).dataset.slide))));
  } else if (openNoteFormat === 'audio') {
    const lines = parseScript(body);
    box.innerHTML = `<ol class="script">${lines.map((l) => `<li data-line><b>${esc(l.speaker)}</b> ${esc(l.text)}</li>`).join('')}</ol>${sourcesHtml(body)}`;
  } else {
    box.innerHTML = renderMarkdown(body, { cite: true });
  }
  box.querySelectorAll('button.cite').forEach((b) => {
    const r = refs.find((/** @type {any} */ x) => x.n === Number(/** @type {HTMLElement} */ (b).dataset.cite));
    if (r) (/** @type {HTMLElement} */ (b)).onclick = (e) => (e.preventDefault(), openRef(r).catch(fail));
    else /** @type {HTMLButtonElement} */ (b).disabled = true;
  });
}

/** @param {number} step */
function moveSlide(step) {
  const form = /** @type {HTMLFormElement} */ (dlg('dlg-note').querySelector('form'));
  const count = parseSlides(String(form.elements.namedItem('body').value)).length;
  slideAt = Math.max(0, Math.min(count - 1, slideAt + step));
  drawNoteRead();
  document.getElementById('deck')?.focus();
}

/** Show the note's Read or Edit view. @param {'read' | 'edit'} view */
function noteView(view) {
  $('note-read').hidden = view !== 'read';
  $('note-edit').hidden = view !== 'edit';
  for (const b of document.querySelectorAll('[data-note-view]')) b.setAttribute('aria-selected', String(/** @type {HTMLElement} */ (b).dataset.noteView === view));
  if (view === 'read') drawNoteRead();
}

/** @param {string} id */
async function openNote(id) {
  const n = lib.note(id);
  const body = await lib.noteBody(id);
  openNoteId = id;
  openNoteFormat = n.format ?? '';
  slideAt = 0;
  const d = dlg('dlg-note');
  const form = /** @type {HTMLFormElement} */ (d.querySelector('form'));
  const titleEl = /** @type {HTMLInputElement} */ (form.elements.namedItem('title'));
  const bodyEl = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('body'));
  titleEl.value = n.title;
  bodyEl.value = body;
  $('note-dlg-title').textContent = n.title;
  $('note-meta').textContent = `${n.kind === 'ai' ? 'Made by the model' : 'Written'} · edited ${ago(n.updated)}`;
  $('note-saved').textContent = '';
  const listenBtn = $('note-listen');
  listenBtn.dataset.idle = openNoteFormat === 'audio' ? 'Play' : 'Listen';
  listenBtn.textContent = listenBtn.dataset.idle;
  const save = async () => {
    await run(lib, 'note.update', { note: id, title: titleEl.value, body: bodyEl.value });
    $('note-saved').textContent = 'Saved';
    $('note-dlg-title').textContent = titleEl.value;
  };
  noteSaver?.dispose?.();
  noteSaver = naklios?.fs?.autosave
    ? naklios.fs.autosave({ save, delay: 800, onError: (/** @type {any} */ e) => (($('note-saved').textContent = 'Not saved'), fail(e)) })
    : fallbackSaver(save);
  const mark = () => (($('note-saved').textContent = 'Editing…'), noteSaver?.markDirty());
  titleEl.oninput = mark;
  bodyEl.oninput = mark;
  // A note someone writes opens for editing; a note the model made opens for reading.
  noteView(n.kind === 'ai' || openNoteFormat ? 'read' : 'edit');
  d.showModal();
  if (!$('note-edit').hidden) bodyEl.focus();
  closed(d).then(async () => {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try {
      await noteSaver?.flush();
    } catch (e) {
      fail(e);
    }
    openNoteId = null;
    draw();
  });
}

/** A saver with the same face as naklios.fs.autosave, for a browser that lacks the SDK. @param {() => Promise<void>} save */
function fallbackSaver(save) {
  let timer = 0;
  const s = {
    dirty: false,
    markDirty() {
      s.dirty = true;
      clearTimeout(timer);
      timer = /** @type {any} */ (setTimeout(() => s.flush().catch(fail), 800));
    },
    async flush() {
      clearTimeout(timer);
      if (!s.dirty) return;
      await save();
      s.dirty = false;
    },
  };
  return s;
}

async function newNote() {
  if (!current) return;
  const n = await act('note.add', { notebook: current, title: 'New note', body: '' });
  await openNote(n.id);
}

/** @param {{ kind: string, id: string, chunk?: number }} r */
async function openRef(r) {
  const exists = r.kind === 'note' ? lib.data.notes.some((n) => n.id === r.id) : lib.data.sources.some((s) => s.id === r.id);
  if (!exists) return banner('That item has been removed from this library since the answer was written.', { error: true });
  if (r.kind === 'note') return openNote(r.id);
  return openSource(r.id, r.chunk);
}

/** @param {number} idx */
async function saveAnswer(idx) {
  if (!current) return;
  const t = turns[idx];
  const question = turns.slice(0, idx).reverse().find((x) => x.role === 'user')?.content ?? 'Chat answer';
  const used = citedRefs(t.content, t.refs ?? []);
  const sources = used.map((r) => `${r.n}. ${r.title}${r.chunk !== undefined ? `, passage ${r.chunk + 1}` : ''}`).join('\n');
  const body = `${t.content}${sources ? `\n\n**Sources**\n\n${sources}` : ''}`;
  await lib.addNote(current, { title: titleFrom(question), body, kind: 'ai', refs: used });
  draw();
  banner('Saved the answer as a note.');
}

async function send() {
  const qEl = /** @type {HTMLTextAreaElement} */ ($('question'));
  const question = qEl.value.trim();
  if (!question || !current || busy) return;
  if (!aiOn()) return banner('Chat needs a model. Choose one in NakliOS Settings → AI.', { error: true });
  const nbId = current;
  const nb = lib.notebook(nbId);
  const items = await lib.contextItems(nbId);
  const chunks = await lib.chunksFor(items);
  const history = turns.filter((t) => t.content).map((t) => ({ role: t.role, content: t.content }));
  const req = buildChat({ notebook: nb, items, history, question, budget: budget(), chunks });
  qEl.value = '';
  turns.push({ role: 'user', content: question, at: Date.now() });
  /** @type {import('./store.js').Turn} */
  const answer = { role: 'assistant', content: '', refs: req.refs, mode: req.mode, at: Date.now() };
  turns.push(answer);
  busy = true;
  abort = new AbortController();
  $('stop').hidden = false;
  drawAi();
  drawChat();
  const live = /** @type {HTMLElement} */ ($('chat').lastElementChild);
  const paint = () => {
    const fresh = turnEl(answer, turns.length - 1);
    live.replaceChildren(...fresh.childNodes);
  };
  try {
    const stream = await naklios.ai.chat.completions.create({
      messages: req.messages,
      max_tokens: 1024,
      stream: true,
      signal: abort.signal,
      onStatus: (/** @type {string} */ status) => {
        if (!answer.content) live.querySelector('.md').textContent = status === 'permission' ? 'Waiting for you to allow AI in NakliOS…' : status === 'loading' ? 'Loading the model…' : status === 'queued' ? 'Waiting for the model…' : '…';
      },
    });
    for await (const chunk of stream) {
      answer.content += chunk?.choices?.[0]?.delta?.content ?? '';
      paint();
    }
  } catch (e) {
    if (!abort.signal.aborted) {
      answer.content += `${answer.content ? '\n\n' : ''}_The model stopped with an error: ${String(/** @type {any} */ (e)?.message ?? e)}_`;
    }
  } finally {
    if (abort.signal.aborted) answer.content += `${answer.content ? '\n\n' : ''}_Stopped._`;
    busy = false;
    abort = null;
    $('stop').hidden = true;
    if (current === nbId) {
      drawChat();
      drawAi();
    }
    await lib.saveChat(nbId, turns).catch(fail);
  }
}

async function runSearch() {
  const q = /** @type {HTMLInputElement} */ ($('search')).value.trim();
  const box = $('hits');
  if (!q || !current) {
    box.hidden = true;
    return;
  }
  const hits = await searchNotebook(lib, current, q, 8);
  box.hidden = false;
  box.innerHTML = hits.length ? '' : '<p class="empty">No passage matches those words.</p>';
  for (const h of hits) {
    const b = document.createElement('button');
    b.className = 'hit';
    const snippet = h.text.length > 220 ? `${h.text.slice(0, 217)}…` : h.text;
    b.innerHTML = `<b>${esc(h.title)} · passage ${h.passage}</b>${esc(snippet)}`;
    b.onclick = () => (h.kind === 'note' ? openNote(h.id) : openSource(h.id, h.passage - 1)).catch(fail);
    box.append(b);
  }
}

// ── Wiring ───────────────────────────────────────────────────────────────────────────────────────────

/** @type {Record<string, () => any>} */
const UI = {
  'notebook.create': () => editNotebook(true),
  'notebook.update': () => editNotebook(false),
  'source.add': () => addSource(),
  'source.import': () => /** @type {HTMLInputElement} */ ($('file')).click(),
  'note.add': () => newNote(),
  'notebook.briefing': () => studio('briefing'),
  'notebook.audio': () => studio('audio'),
  'notebook.mindmap': () => studio('mindmap'),
  'notebook.slides': () => studio('slides'),
  'note.listen': () => listen(),
  'note.present': () => {
    const deck = document.getElementById('deck');
    if (deck && !document.fullscreenElement) deck.requestFullscreen?.().then(() => deck.focus()).catch(fail);
  },
  'chat.ask': () => send(),
  'source.rename': async () => {
    if (!openSourceId || !current) return;
    const s = lib.source(openSourceId);
    const title = await ask({ title: 'Rename source', text: 'New title', value: s.title, ok: 'Rename' });
    if (typeof title === 'string' && title.trim()) {
      await act('source.rename', { notebook: current, source: s.id, title });
      $('src-title').textContent = title.trim();
    }
  },
  'source.remove': async () => {
    if (!openSourceId || !current) return;
    const s = lib.source(openSourceId);
    const shared = lib.data.notebooks.filter((n) => n.sources.includes(s.id)).length > 1;
    const okay = await ask({ title: `Remove “${s.title}”?`, text: shared ? 'Another notebook uses this source, so it stays there.' : 'Its text and file are deleted from your library. This cannot be undone.', ok: 'Remove', danger: true });
    if (!okay) return;
    shut(dlg('dlg-source'), 'removed');
    await act('source.remove', { notebook: current, source: s.id });
  },
  'note.delete': async () => {
    if (!openNoteId) return;
    const n = lib.note(openNoteId);
    const okay = await ask({ title: `Delete “${n.title}”?`, text: 'This cannot be undone.', ok: 'Delete', danger: true });
    if (!okay) return;
    const id = openNoteId;
    noteSaver?.dispose?.();
    noteSaver = null;
    shut(dlg('dlg-note'), 'deleted');
    await act('note.delete', { note: id });
  },
  'notebook.delete': () => {
    shut(dlg('dlg-notebook'), 'delete');
  },
};

document.addEventListener('click', (e) => {
  const el = /** @type {HTMLElement} */ (e.target)?.closest?.('[data-command]');
  if (!el || el.tagName === 'INPUT') return;
  const name = /** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.command);
  const handler = UI[name];
  if (!handler) return;
  if (el.getAttribute('value') !== 'close') e.preventDefault();
  Promise.resolve(handler()).catch(fail);
});
document.querySelectorAll('[data-tab]').forEach((t) =>
  t.addEventListener('click', () => {
    tab = /** @type {string} */ (/** @type {HTMLElement} */ (t).dataset.tab);
    draw();
  }),
);
$('question').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send().catch(fail);
  }
});
$('stop').onclick = () => abort?.abort();
document.querySelectorAll('[data-note-view]').forEach((b) => b.addEventListener('click', () => noteView(/** @type {any} */ (/** @type {HTMLElement} */ (b).dataset.noteView))));
$('note-read').addEventListener('keydown', (e) => {
  if (openNoteFormat !== 'slides') return;
  if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') (e.preventDefault(), moveSlide(1));
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') (e.preventDefault(), moveSlide(-1));
});
$('where').addEventListener('change', (e) => chooseStorage(/** @type {HTMLSelectElement} */ (e.target).value).catch(fail));
$('clear-chat').onclick = async () => {
  if (!current || !turns.length) return;
  const okay = await ask({ title: 'Clear this chat?', text: 'The questions and answers in this notebook\'s chat are deleted. Notes you saved stay.', ok: 'Clear', danger: true });
  if (!okay) return;
  abort?.abort();
  turns = [];
  await lib.saveChat(current, turns);
  drawChat();
};
let searchTimer = 0;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = /** @type {any} */ (setTimeout(() => runSearch().catch(fail), 200));
});
const fileInput = /** @type {HTMLInputElement} */ ($('file'));
fileInput.onchange = () => {
  const files = [...(fileInput.files ?? [])];
  fileInput.value = '';
  shut(dlg('dlg-add'), 'file');
  importFiles(files).catch(fail);
};
for (const zone of [$('sources-drop'), $('add-drop')]) {
  zone.addEventListener('dragover', (e) => (e.preventDefault(), zone.classList.add('over')));
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const files = [...(e.dataTransfer?.files ?? [])];
    if (dlg('dlg-add').open) shut(dlg('dlg-add'), 'file');
    if (files.length) importFiles(files).catch(fail);
  });
}

// ── Agent faces: the NakliOS rail and window.lectella ────────────────────────────────────────────────

const handlers = () =>
  railCommands().map((c) => ({
    name: c.name,
    description: c.description,
    input: c.input,
    scope: c.scope,
    handler: async (/** @type {any} */ args) => {
      const out = await run(lib, c.name, args);
      await afterCommand();
      return out;
    },
  }));
let registered = false;
function registerCommands() {
  if (registered || !naklios?.experimental_commands?.register || !caps().hosted) return;
  registered = true;
  Promise.resolve(naklios.experimental_commands.register(handlers())).catch((/** @type {any} */ e) => {
    registered = false;
    console.warn('Lectella: command registration failed', e);
  });
}
/** @type {any} */ (window).lectella = {
  tools: () => COMMANDS.map(({ name, description, scope, input, personOnly }) => ({ name, description, scope, input, ...(personOnly ? { personOnly } : {}) })),
  run: async (/** @type {string} */ name, /** @type {any} */ args) => {
    const out = await run(lib, name, args);
    await afterCommand();
    return out;
  },
};

// ── Host theme: light stays light; a light host theme tints the accent and surfaces ────────────────

/** @param {string} hex */
function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? '');
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
/** @param {{ colors?: Record<string, string> } | null} theme */
function applyHostTheme(theme) {
  const c = theme?.colors;
  const root = document.documentElement.style;
  const light = c && luminance(c.BODY) > 0.75 && luminance(c.INK) < 0.35;
  for (const [v, k] of [['--bg', 'BODY'], ['--panel', 'PANEL'], ['--fg', 'INK'], ['--accent', 'ACT'], ['--line', 'ROW']]) {
    if (light && c?.[k]) root.setProperty(v, c[k]);
    else root.removeProperty(v);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────────────────────────────

where = 'init';
const started = openLibrary('browser')
  .catch((e) => {
    where = 'browser';
    fail(new Error(`Could not open the library in this browser: ${e?.message ?? e}`));
    draw();
  })
  .finally(() => {
    naklios?.theme?.onChange?.(applyHostTheme);
    naklios?.onCapabilitiesChange?.(() => onCaps().catch(fail));
    naklios?.files?.onOpen?.((/** @type {any} */ g) => onSent(g).catch(fail));
    naklios?.ready?.();
    naklios?.theme?.request?.();
    naklios?.requestCapabilities?.();
  });
