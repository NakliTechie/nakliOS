// The page: draws the library, wires every control to the command manifest, runs chat through the NakliOS
// model, and picks where the library lives (NakliOS Folder or Crate when connected, else this browser).

import { buildChat, citedRefs, esc, estimateTokens, renderMarkdown, titleFrom } from './core.js';
import { Library, hostFs, opfsFs } from './store.js';
import { COMMANDS, railCommands, run, searchNotebook } from './commands.js';

/** The NakliOS SDK, inlined in index.html; a no-op when Lectella runs standalone. */
const naklios = /** @type {any} */ (window).naklios;
const caps = () => naklios?.capabilities ?? {};
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const dlg = (/** @type {string} */ id) => /** @type {HTMLDialogElement} */ ($(id));

// ── Errors and messages ──────────────────────────────────────────────────────────────────────────────

/** @param {string} msg @param {{ error?: boolean, action?: { label: string, run: () => void } }} [opts] */
function banner(msg, { error = false, action } = {}) {
  const b = $('banner');
  b.hidden = !msg;
  b.classList.toggle('error', error);
  b.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const btn = document.createElement('button');
    btn.textContent = action.label;
    btn.onclick = action.run;
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

function drawStore() {
  const s = $('store-status');
  s.className = disconnected ? 'err' : '';
  s.textContent = disconnected ? `Storage disconnected: ${label(where)}` : `Saved in ${where === 'browser' ? 'this browser' : `your ${label(where)}`}`;
  s.title = where === 'browser' ? 'Kept in this browser\'s private storage. Connect a Folder or Crate in NakliOS to keep it on your own disk.' : 'Kept as plain files under apps/lectella/ in your NakliOS storage.';
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
  if (c.hosted && c.fs && c.fsBackend) {
    if (where !== c.fsBackend || disconnected) await openLibrary(c.fsBackend);
  } else if (where !== 'browser' && !disconnected) {
    disconnected = true;
    drawStore();
    banner(`Your ${label(where)} is disconnected. You can read what is open; changes are refused until it is back.`, { error: true });
  }
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

/** @param {File[]} files */
async function importFiles(files) {
  if (!current) throw new Error('Create a notebook first');
  let added = 0;
  for (const f of files) {
    if (!/\.(md|markdown|txt)$/i.test(f.name) && !/^text\//.test(f.type)) {
      banner(`${f.name} is not a text or Markdown file. PDF, web pages and audio come in a later version.`, { error: true });
      continue;
    }
    if (f.size > 20 * 1024 * 1024) {
      banner(`${f.name} is larger than 20 MB, so it was not added.`, { error: true });
      continue;
    }
    const bytes = new Uint8Array(await f.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    await lib.addSource(current, { title: f.name.replace(/\.(md|markdown|txt)$/i, ''), text, kind: /\.(md|markdown)$/i.test(f.name) ? 'markdown' : 'text', origin: 'file', original: { name: f.name, bytes } });
    added++;
  }
  draw();
  if (added) banner(`Added ${added} source${added === 1 ? '' : 's'}.`);
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

/** @param {string} id */
async function openNote(id) {
  const n = lib.note(id);
  const body = await lib.noteBody(id);
  openNoteId = id;
  const d = dlg('dlg-note');
  const form = /** @type {HTMLFormElement} */ (d.querySelector('form'));
  const titleEl = /** @type {HTMLInputElement} */ (form.elements.namedItem('title'));
  const bodyEl = /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('body'));
  titleEl.value = n.title;
  bodyEl.value = body;
  $('note-dlg-title').textContent = n.kind === 'ai' ? 'Note from chat' : 'Note';
  $('note-meta').textContent = `Edited ${ago(n.updated)}`;
  $('note-saved').textContent = '';
  const save = async () => {
    await run(lib, 'note.update', { note: id, title: titleEl.value, body: bodyEl.value });
    $('note-saved').textContent = 'Saved';
  };
  noteSaver?.dispose?.();
  noteSaver = naklios?.fs?.autosave
    ? naklios.fs.autosave({ save, delay: 800, onError: (/** @type {any} */ e) => (($('note-saved').textContent = 'Not saved'), fail(e)) })
    : fallbackSaver(save);
  const mark = () => (($('note-saved').textContent = 'Editing…'), noteSaver?.markDirty());
  titleEl.oninput = mark;
  bodyEl.oninput = mark;
  d.showModal();
  bodyEl.focus();
  closed(d).then(async () => {
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
openLibrary('browser')
  .catch((e) => {
    where = 'browser';
    fail(new Error(`Could not open the library in this browser: ${e?.message ?? e}`));
    draw();
  })
  .finally(() => {
    naklios?.theme?.onChange?.(applyHostTheme);
    naklios?.onCapabilitiesChange?.(() => onCaps().catch(fail));
    naklios?.ready?.();
    naklios?.theme?.request?.();
    naklios?.requestCapabilities?.();
  });
