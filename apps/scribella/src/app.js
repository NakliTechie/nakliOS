// Scribella's page: wires storage, the editor, builds and the PDF pane. Writing works everywhere; compiling needs the
// NakliOS TeX service, because the engine lives there.
import { browserStore, hostStore } from './storage.js';
import { TEMPLATES, cleanFilePath, createProject, findMain, isImage, isText, listFiles, listProjects, loadVenues, projectFolder, readSettings, safeName, writeSettings } from './project.js';
import { createBuilder } from './build.js';
import { createEditor } from './editor.js';
import { createPdfView } from './pdf-view.js';
import { explain, visibleDiagnostics } from './explain.js';
import { bibKeys, collectKeys } from './lint.js';
import { buildOutline, wordCount } from './outline.js';
import { findAll, findTodos, replaceAllIn } from './search.js';
import { SYMBOLS, figureBlock, needsBooktabs, parseTable, slug, tableBlock } from './insert.js';
import { makeZip, readZip } from './zip.js';
import { forward, inverse, readSynctex } from './synctex.js';
import { listVersions, readVersion, saveVersion } from './versions.js';
import { markChanges } from './changes.js';
import { stripComments, usedFiles } from './arxiv.js';
import { HIGHLIGHTS, INTENTS, NOTES_PATH, locate, makeAnchor, parseNotes } from './annotations.js';
import { addFields, parseBib, sameWork, scanEntries, writeEntry } from './bib.js';
import { auditEntry, discover, findPaper } from './lookup.js';
import { checkPdf, checkSource } from './blind.js';
import { formatLatex } from './format.js';
import { merge3 } from './merge.js';
import { paragraphAt, renderParagraph } from './preview.js';
import { arxivMarkdown } from './papers.js';
import { readSheet, writeSheet } from './sheet.js';
import { blankBoard, boardPdf, boardSvg, readBoard, shapeSvg } from './board.js';
import { renderMarkdown } from './markdown.js';
import { projectGit } from './git.js';
import { SYSTEM, agentTurn } from './agent.js';
import { STATE_PATH, overleafProjectId, overleafSync } from './overleaf.js';
import { definitionOf, detectVenue, tokenAt, usesOf } from './latex-edit.js';
import { checkSpelling } from './spell.js';
import { parseBlg, parseLabels } from './aux.js';
import { MAX_PASSAGE, buildMessages, parseReply, safeResult, wordEdits } from './revise.js';

const AUTOSAVE_MS = 1200;
const OUTSIDE_EDIT_MS = 1500;
const KEYS_ITEM = 'scribella.keys';
const $ = id => document.getElementById(id);
const naklios = window.naklios;
const hosted = () => !!(naklios?.capabilities?.hosted && naklios.capabilities.fs);
const canCompile = () => storeKind === 'host' && naklios.capabilities.experimental_tex === true;
const COMPILE_HINT = () => (naklios?.capabilities?.hosted
  ? 'Writing works here. To compile, connect a Folder or Crate in NakliOS Settings.'
  : 'Writing works here. To compile, open Scribella inside NakliOS, where the TeX engine runs.');

let store = null, storeKind = null;
const state = { saved:{}, sync:null, builtRevision:null, findHits:[], findIndex:-1, project:null, settings:{}, files:[], texts:{}, path:null, dirty:false, revision:0, problems:[], log:'', job:null, auto:true };
let venues = {}, marksTimer = null;
const review = { notes:[], rounds:0, proposal:null };
const aiReady = () => naklios?.capabilities?.ai === true;
const SCRATCH = 'scratch-build';
let saveTimer = null, outsideTimer = null, stopWatching = null;
const readKeys = () => { try { return localStorage.getItem(KEYS_ITEM) || 'default'; } catch (_) { return 'default'; } };

const say = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const pdf = createPdfView($('pdf'), {
  onPages:pages => { $('pages').textContent = `${pages} ${pages === 1 ? 'page' : 'pages'}`; },
  onPoint:point => goToSource(point).catch(fail),
});

function projectIndex() {
  const labels = new Set(), keys = new Set(), macros = new Set();
  let hasBib = false;
  for (const [path, text] of Object.entries(state.texts)) {
    if (/\.bib$/i.test(path)) { hasBib = true; bibKeys(text).forEach(key => keys.add(key)); }
    if (/\.(tex|ltx)$/i.test(path)) {
      collectKeys(text).labels.forEach(label => labels.add(label.key));
      for (const [, name] of text.matchAll(/\\(?:re)?newcommand\*?\{?\\([A-Za-z@]+)/g)) macros.add(name);
    }
  }
  return { labels, bibKeys:keys, hasBib, files:new Set(state.files), macros };
}

const editor = createEditor($('editor'), {
  path:() => state.path || '',
  project:projectIndex,
  keys:readKeys(),
  onShow:() => showInPdf(),
  onDefinition:at => goToDefinition(at).catch(fail),
  spell:text => (/\.(tex|ltx|md|txt)$/i.test(state.path || '') ? checkSpelling(text).catch(error => { say(`Spellcheck failed: ${error.message}`, true); return []; }) : Promise.resolve([])),
  describeRef:key => {
    const label = state.labels?.get(key);
    return label ? `${key}: ${label.number || 'no number'}, page ${label.page}` : `${key}: not built yet`;
  },
  describeCite:key => {
    const entry = bibEntries().find(item => item.key === key);
    if (!entry) return `${key}: not in the bibliography`;
    const { title, author, year } = entry.fields;
    const notice = review.notices?.[key]?.length ? ` [${review.notices[key].join(', ')}]` : '';
    return `${author ? `${author.split(/\s+and\s+/)[0].split(',')[0]} ` : ''}${year ? `(${year}) ` : ''}${title || key}${notice}`;
  },
  onSelect:selected => { $('sel-bar').hidden = !selected || !editingText(); $('ai-tools').hidden = !aiReady(); },
  onDrop:(files, at) => dropFiles(files, at).catch(fail),
  onSave:() => saveNow().then(() => state.project && build()),
  onChange() {
    if (!editingText()) return;
    state.dirty = true;
    state.texts[state.path] = editor.text;
    state.revision += 1;
    showCounts();
    clearTimeout(marksTimer);
    marksTimer = setTimeout(showNoteMarks, 500);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow().then(() => { if (state.auto) build(); }), AUTOSAVE_MS);
  },
});

const fullPath = path => `${projectFolder(state.project)}/${path}`;

const writeFile = (path, data) => store.write(fullPath(path), data);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();
const fileExists = path => state.files.find(file => sameName(file, path));
const isSheet = path => /\.(csv|tsv)$/i.test(path || '');
const isBoard = path => /\.board$/i.test(path || '');
const editingText = () => !!state.path && isText(state.path) && !isSheet(state.path) && !isBoard(state.path);

async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.dirty || !state.path) return;
  state.dirty = false;
  try {
    // The text is taken before the write, so keystrokes typed while it runs are not marked as saved.
    const path = state.path, text = state.texts[path];
    await writeFile(path, text);
    state.saved[path] = text;
  } catch (error) {
    state.dirty = true;
    say(`Saving failed: ${error.message}`, true);
    throw error;
  }
}

function showCounts() {
  const main = state.texts[state.settings.main];
  const venue = main && detectVenue(main);
  $('words').textContent = main ? `${venue ? `${venue} · ` : ''}About ${wordCount(main).toLocaleString('en')} words` : '';
  renderOutline();
}

function renderTree() {
  $('files').replaceChildren(...state.files.map(path => {
    const row = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'row';
    open.dataset.command = 'open-file';
    open.textContent = path;
    open.title = path;
    open.setAttribute('aria-current', path === state.path ? 'true' : 'false');
    open.addEventListener('click', () => openFile(path).catch(fail));
    row.append(open);
    return row;
  }));
  const texFiles = state.files.filter(path => /\.(tex|ltx)$/i.test(path));
  $('main-file').replaceChildren(...texFiles.map(path => new Option(path, path, false, path === state.settings.main)));
  $('engine').value = state.settings.engine || 'pdflatex';
}

function renderOutline() {
  const items = state.settings.main ? buildOutline(path => state.texts[path] ?? null, state.settings.main) : [];
  $('outline').replaceChildren(...items.map(item => {
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'row';
    go.dataset.command = 'outline-item';
    go.style.paddingLeft = `${8 + Math.max(0, item.level - 2) * 12}px`;
    go.textContent = item.title;
    go.addEventListener('click', () => jump(item.file, item.line).catch(fail));
    row.append(go);
    return row;
  }));
}

async function jump(path, line, token) {
  if (path !== state.path && state.files.includes(path)) await openFile(path);
  if (line) editor.goToLine(line, token);
}

function renderProblems() {
  const list = state.problems;
  const errors = list.filter(item => item.severity === 'error').length;
  $('problem-count').textContent = list.length ? `${errors} ${errors === 1 ? 'error' : 'errors'}, ${list.length - errors} ${list.length - errors === 1 ? 'warning' : 'warnings'}` : 'No problems';
  $('problems').replaceChildren(...list.map(item => {
    const row = document.createElement('li');
    row.className = item.severity;
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'problem';
    go.dataset.command = 'problem';
    const title = document.createElement('strong');
    title.textContent = item.headline;
    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = item.line ? `${item.file}:${item.line}` : item.file || '';
    go.append(title, place);
    if (item.explanation) {
      const words = document.createElement('p');
      words.textContent = item.explanation;
      go.append(words);
    }
    go.addEventListener('click', () => jump(item.file, item.line, item.token).catch(fail));
    row.append(go);
    if (item.engine && item.engine !== state.settings.engine) {
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'btn small';
      change.dataset.command = 'apply-fix';
      change.textContent = `Switch to ${item.engine === 'lualatex' ? 'LuaLaTeX' : 'XeLaTeX'}`;
      change.addEventListener('click', () => changeSettings({ engine:item.engine }).then(renderTree).catch(fail));
      row.append(change);
    }
    if (item.suggestion) {
      const fix = document.createElement('button');
      fix.type = 'button';
      fix.className = 'btn small';
      fix.dataset.command = 'apply-fix';
      fix.textContent = `Replace with ${item.suggestion}`;
      fix.addEventListener('click', () => applyFix(item).catch(fail));
      row.append(fix);
    }
    return row;
  }));
}

async function applyFix(item) {
  await jump(item.file, item.line);
  if (!editor.replaceOnLine(item.line, item.token, item.suggestion)) say(`Line ${item.line} no longer holds ${item.token}.`, true);
}

async function compile() {
  const project = state.project;
  await saveNow();
  $('build').hidden = true;
  $('cancel').hidden = false;
  state.job = naklios.experimental_tex.compile({
    folder:projectFolder(state.project),
    main:state.settings.main,
    engine:state.settings.engine || 'pdflatex',
    onChunk(chunk) {
      if (chunk.kind !== 'progress') return;
      if (chunk.stage === 'download') say(`Downloading TeX Live, once for this browser: ${Math.round(chunk.percent || 0)}%`);
      else say({ queued:'Waiting for TeX…', reading:'Reading the project…', compiling:'Compiling…', writing:'Saving the build…' }[chunk.stage] || 'Working…');
    },
  });
  try { return { ...await state.job, project }; } finally { state.job = null; }
}

async function afterBuild({ result, stale, revision = state.revision }) {
  if (result.project !== state.project) return;
  const log = result.log ? await store.read(result.log).catch(() => '') : '';
  state.log = log;
  state.problems = visibleDiagnostics(result.diagnostics).map(item => ({ ...item, ...explain(item, { log, source:state.texts[item.file] || '' }) }));
  if (result.aux) state.labels = parseLabels(await store.read(result.aux).catch(() => ''));
  if (result.blg) state.problems.push(...parseBlg(await store.read(result.blg).catch(() => '')).map(item => ({ ...item, file:'', headline:item.message, explanation:'' })));
  renderProblems();
  completeStep('build');
  if (result.pdf && result.ok) {
    await pdf.show(await store.readBinary(result.pdf));
    state.sync = result.synctex ? await readSynctex(await store.readBinary(result.synctex)).catch(() => null) : null;
    state.builtRevision = revision;
    state.findQuery = '';
    if (revision === state.revision) writeSettings(store, state.project, Object.assign(state.settings, { builtHash:sourceHash() })).catch(() => {});
  }
  const errors = state.problems.filter(item => item.severity === 'error').length;
  if (result.ok) say(stale ? 'Built. More edits are waiting.' : 'Built.');
  else say(pdf.pages ? `TeX stopped with ${errors} ${errors === 1 ? 'error' : 'errors'}. The last good PDF stays on screen.` : `TeX stopped with ${errors} ${errors === 1 ? 'error' : 'errors'}.`, true);
}

const builder = createBuilder({
  compile,
  onState(update) {
    if (update.phase === 'building') { document.body.dataset.building = 'true'; return; }
    if (!builder.running || update.phase === 'done' || update.phase === 'failed') { $('build').hidden = false; $('cancel').hidden = true; delete document.body.dataset.building; }
    if (update.phase === 'done') afterBuild(update).catch(fail);
    if (update.phase === 'failed' && update.error?.code !== 'ECANCELED' && !/ECANCELED/.test(update.error?.message || '')) say(`The build did not run: ${update.error.message}`, true);
    else if (update.phase === 'failed') say('Build stopped.');
  },
});

function build() {
  if (!state.project || !state.settings.main) return;
  if (!canCompile()) { say(COMPILE_HINT()); return; }
  builder.request(state.revision);
}

// Says whether the saved PDF was built from the text now in the project.
function sourceHash() {
  let hash = 2166136261;
  const names = state.files.join('|');
  for (const path of ['', ...Object.keys(state.texts).sort()]) for (const char of path ? path + state.texts[path] : names) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

// Lines move as you type, so a jump only trusts a PDF built from the text on screen.
const syncReady = () => {
  if (!state.sync) { say('Build the paper first.'); return false; }
  if (state.builtRevision !== state.revision) { say('The source changed since this PDF. Build, then jump.'); return false; }
  return true;
};

function showInPdf() {
  if (!syncReady()) return null;
  const box = forward(state.sync, state.path, editor.currentLine);
  if (!box || !pdf.reveal(box)) { say(`No PDF output for ${state.path} line ${editor.currentLine}.`); return null; }
  return box;
}

async function goToSource({ page, x, y, word = '' }) {
  if (!syncReady()) return null;
  const place = inverse(state.sync, page, x, y, new Set(state.files));
  if (!place) { say('Nothing in your project made this spot.'); return null; }
  // TeX closes a paragraph on the blank line after it, so a click can arrive one line low.
  const lines = (state.texts[place.file] || '').split('\n');
  while (place.line > 1 && !lines[place.line - 1]?.trim()) place.line -= 1;
  const onLine = word.length > 2 && (lines[place.line - 1] || '').includes(word) ? word : undefined;
  await jump(place.file, place.line, onLine);
  return place;
}

async function findInPdf(step = 0) {
  const query = $('pdf-find').value;
  if (query !== state.findQuery) { state.findQuery = query; state.findHits = await pdf.find(query); state.findIndex = -1; }
  const hits = state.findHits;
  if (!hits.length) { $('pdf-hits').textContent = query ? 'No matches' : ''; return; }
  state.findIndex = (state.findIndex + (step || 1) + hits.length) % hits.length;
  $('pdf-hits').textContent = `${state.findIndex + 1} of ${hits.length}`;
  pdf.reveal(hits[state.findIndex]);
}

async function openFile(path) {
  await saveNow();
  if (path && !state.files.includes(path)) throw new Error(`${path} is not in the project.`);
  clearTimeout(saveTimer);
  state.path = path;
  $('file-name').textContent = path;
  const text = isText(path), view = isSheet(path) ? 'sheet' : isBoard(path) ? 'board' : text ? 'editor' : 'none';
  for (const [id, name] of [['editor', 'editor'], ['sheet-view', 'sheet'], ['board-view', 'board']]) $(id).hidden = view !== name;
  $('not-text').hidden = view !== 'none';
  if (text) state.texts[path] ??= await store.read(fullPath(path));
  if (view === 'editor') { editor.load(state.texts[path]); showNoteMarks(); }
  if (view === 'sheet') { state.sheet = readSheet(state.texts[path], path); renderSheet(); }
  if (view === 'board') { state.board = readBoard(state.texts[path]); renderBoard(); }
  $('preview').hidden = view !== 'editor';
  renderTree();
  showPreview().catch(() => {});
}

// Edits from outside the page, such as an agent or another tab, reach the editor and start a build.
async function outsideChange(event) {
  const root = `${projectFolder(state.project)}/`;
  const path = event.path?.startsWith(root) ? event.path.slice(root.length) : event.path;
  if (!path || path.split('/').some(part => part.startsWith('.'))) return;
  state.files = await listFiles(store, state.project);
  if (state.files.includes(path) && isText(path)) {
    const text = await store.read(fullPath(path));
    // Our own saves arrive here too; they match what we hold.
    if (text === state.texts[path]) return;
    if (path === state.path && (isSheet(path) || isBoard(path))) {
      // Our own queued saves also arrive here; while any wait, the newer text in memory wins.
      if (structuredPending.get(path) > 0) return;
      state.texts[path] = text;
      state.saved[path] = text;
      if (isSheet(path)) { state.sheet = readSheet(text, path); renderSheet(); } else { state.board = readBoard(text); renderBoard(); }
      say(`${path} changed outside and is shown as it is now.`);
      return;
    }
    const merged = path === state.path && state.dirty && state.saved[path] != null ? merge3(state.saved[path], editor.text, text) : null;
    if (merged && !merged.conflicts) {
      state.saved[path] = text;
      state.texts[path] = merged.text;
      editor.load(merged.text);
      state.dirty = true;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveNow().catch(fail), AUTOSAVE_MS);
      say(`${path} changed outside. Both sets of changes are kept.`);
    } else if (path === state.path && state.dirty) {
      const copy = `${path}.outside-${Date.now()}.txt`;
      await writeFile(copy, text);
      state.files = await listFiles(store, state.project);
      state.texts[copy] = text;
      say(`${path} changed outside while you were typing. Your text stays here, and the other version is in ${copy}.`, true);
    } else {
      state.texts[path] = text;
      state.saved[path] = text;
      if (path === state.path) editor.load(text);
    }
  } else if (!state.files.includes(path)) delete state.texts[path];
  renderTree();
  showCounts();
  state.revision += 1;
  clearTimeout(outsideTimer);
  outsideTimer = setTimeout(() => { if (state.auto) build(); }, OUTSIDE_EDIT_MS);
}

async function watchProject(name) {
  stopWatching?.();
  stopWatching = null;
  if (storeKind !== 'host' || !naklios.fs.subscribe) return;
  stopWatching = await naklios.fs.subscribe(projectFolder(name), event => { outsideChange(event).catch(fail); });
}

async function openProject(name) {
  await saveNow();
  pdf.clear();
  $('pages').textContent = '';
  state.project = name;
  state.revision += 1;
  state.settings = await readSettings(store, name);
  state.files = await listFiles(store, name);
  state.texts = {};
  for (const path of state.files.filter(isText)) state.texts[path] = await store.read(fullPath(path));
  state.saved = { ...state.texts };
  state.settings.main = state.files.includes(state.settings.main) ? state.settings.main : findMain(state.files, state.texts);
  state.problems = [];
  state.sync = null;
  state.builtRevision = null;
  state.findQuery = '';
  renderProblems();
  document.body.dataset.view = 'project';
  $('project-name').textContent = name;
  naklios?.title?.(`${name} — Scribella`);
  document.title = `${name} — Scribella`;
  await openFile(state.settings.main || state.files[0]);
  showCounts();
  await renderVersions();
  await renderGit();
  await renderOverleaf();
  agent.history = [{ role:'system', content:SYSTEM }];
  $('agent-log').replaceChildren();
  Object.assign(review, { notes:[], rounds:0, proposal:null });
  if (await store.exists(notesFile())) Object.assign(review, parseNotes(await store.read(notesFile())));
  renderProposal();
  renderNotes();
  await watchProject(name).catch(error => console.error('Watching the project failed', error));
  const last = state.settings.main && `${projectFolder(name)}/.tex-build/${state.settings.main.replace(/^.*\//, '').replace(/\.[^.]+$/, '')}.pdf`;
  if (last && await store.exists(last)) {
    await pdf.show(await store.readBinary(last));
    const sync = last.replace(/\.pdf$/, '.synctex.gz');
    if (await store.exists(sync) && state.settings.builtHash === sourceHash()) { state.sync = await readSynctex(await store.readBinary(sync)).catch(() => null); state.builtRevision = state.revision; }
  }
  say(canCompile() ? 'Ready.' : COMPILE_HINT());
}

async function renderHome() {
  document.body.dataset.view = 'home';
  const names = await listProjects(store);
  $('projects').replaceChildren(...names.map(name => {
    const row = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'row';
    open.dataset.command = 'open-project';
    open.textContent = name;
    open.addEventListener('click', () => openProject(name).catch(fail));
    row.append(open);
    return row;
  }));
  $('no-projects').hidden = names.length > 0;
  $('where').textContent = storeKind === 'host' ? 'Projects live in your NakliOS storage.' : 'Projects live in this browser only.';
}

function fail(error) {
  console.error(error);
  say(error.message || String(error), true);
}

async function changeSettings(change) {
  Object.assign(state.settings, change);
  await writeSettings(store, state.project, state.settings);
  showCounts();
  build();
}

async function newFile() {
  const path = cleanFilePath($('new-file-name').value);
  if (fileExists(path)) throw new Error(`${fileExists(path)} already exists.`);
  await writeFile(path, '');
  state.files = await listFiles(store, state.project);
  state.texts[path] = '';
  $('new-file-name').value = '';
  $('new-file-form').hidden = true;
  await openFile(path);
}

async function deleteFile() {
  if (!state.path || !confirm(`Delete ${state.path}? This cannot be undone.`)) return;
  const gone = state.path;
  state.dirty = false;
  await store.remove(fullPath(gone));
  delete state.texts[gone];
  state.files = await listFiles(store, state.project);
  state.path = null;
  await openFile(state.settings.main && state.files.includes(state.settings.main) ? state.settings.main : state.files[0]);
}

async function renameFile(from, to) {
  const path = cleanFilePath(to), taken = fileExists(path);
  if (taken && !sameName(taken, from)) throw new Error(`${taken} already exists.`);
  await saveNow();
  const bytes = await store.readBinary(fullPath(from));
  // On a case-insensitive disk `a.tex` and `A.tex` are one file, so the old name goes first, with the bytes in hand.
  if (sameName(path, from)) {
    // A hidden copy holds the bytes until the new name is written.
    const hold = `.renaming-${Date.now()}`;
    await writeFile(hold, bytes);
    await store.remove(fullPath(from));
    await writeFile(path, bytes);
    await store.remove(fullPath(hold));
  } else { await writeFile(path, bytes); await store.remove(fullPath(from)); }
  if (from in state.texts) { state.texts[path] = state.texts[from]; delete state.texts[from]; }
  if (review.notes.some(note => note.file === from)) { for (const note of review.notes) if (note.file === from) note.file = path; await saveNotes(); }
  state.files = await listFiles(store, state.project);
  if (state.settings.main === from) await changeSettings({ main:path });
  if (state.path === from) state.path = null;
  await openFile(state.path || path);
  return path;
}

async function addFiles(files, folder = '') {
  const added = [];
  for (const file of files) {
    const path = cleanFilePath(folder + file.name.replace(/[\\/]/g, '-')), taken = fileExists(path);
    if (taken && !confirm(`Replace ${taken}?`)) continue;
    const target = taken || path;
    await writeFile(target, new Uint8Array(await file.arrayBuffer()));
    if (isText(target)) {
      state.texts[target] = await file.text();
      if (target === state.path) { state.dirty = false; clearTimeout(saveTimer); editor.load(state.texts[target]); }
    }
    added.push(target);
  }
  state.files = await listFiles(store, state.project);
  renderTree();
  showCounts();
  return added;
}

async function dropFiles(files, at) {
  if (!editingText()) throw new Error('Open a text file first.');
  const images = files.filter(file => isImage(file.name)), others = files.filter(file => !isImage(file.name));
  for (const path of await addFiles(images, 'figures/')) editor.insert(figureBlock({ path }), at);
  if (others.length) await addFiles(others);
}

// Data sheets and boards save through the same path as text, so the outside-edit check and versions cover them.
let structuredQueue = Promise.resolve();
const structuredPending = new Map();
function saveStructured(text) {
  const path = state.path;
  state.texts[path] = text;
  state.revision += 1;
  // Saves run in order, so an older one cannot land after a newer one; a failure says so and the next edit retries.
  structuredPending.set(path, (structuredPending.get(path) || 0) + 1);
  const run = structuredQueue.then(async () => {
    if (state.texts[path] !== text) return;
    await writeFile(path, text);
    state.saved[path] = text;
  }).finally(() => structuredPending.set(path, structuredPending.get(path) - 1));
  structuredQueue = run.catch(error => say(`Saving ${path} failed: ${error.message}. Your next change tries again.`, true));
  return run;
}

function renderSheet() {
  const { rows } = state.sheet;
  $('sheet').replaceChildren(...rows.map((row, r) => {
    const tr = document.createElement('tr');
    tr.append(...row.map((cell, c) => {
      const td = document.createElement(r ? 'td' : 'th');
      td.contentEditable = 'plaintext-only';
      td.textContent = cell;
      td.addEventListener('blur', () => {
        if (rows[r][c] === td.textContent) return;
        rows[r][c] = td.textContent;
        saveStructured(writeSheet(state.sheet)).catch(fail);
      });
      return td;
    }));
    return tr;
  }));
}

function sheetEdit(action) {
  const { rows } = state.sheet;
  if (action === 'row') rows.push(Array(rows[0].length).fill(''));
  if (action === 'column') rows.forEach(row => row.push(''));
  if (action === 'table') {
    if (!state.settings.main) throw new Error('This project has no main file.');
    const name = state.path.replace(/^.*\//, '');
    state.pendingInsert = tableBlock(rows, { caption:name, label:slug(name) });
    say(`Open a .tex file and use Insert, Table from data, to place this table. It is copied to the table box.`);
    $('table-data').value = writeSheet(state.sheet);
    return;
  }
  renderSheet();
  saveStructured(writeSheet(state.sheet)).catch(fail);
}

const board = { tool:'pen', drawing:null };

function renderBoard() {
  const svg = $('board');
  svg.setAttribute('viewBox', `0 0 ${state.board.width} ${state.board.height}`);
  svg.innerHTML = state.board.shapes.map(shapeSvg).join('') + (board.drawing ? shapeSvg(board.drawing) : '');
}

function boardPoint(event) {
  const box = $('board').getBoundingClientRect();
  return [(event.clientX - box.left) * state.board.width / box.width, (event.clientY - box.top) * state.board.height / box.height];
}

function bindBoard() {
  const svg = $('board');
  svg.addEventListener('pointerdown', event => {
    const [x, y] = boardPoint(event);
    if (board.tool === 'text') {
      const text = prompt('Text');
      if (text) { state.board.shapes.push({ kind:'text', x, y, text }); renderBoard(); saveStructured(JSON.stringify(state.board)).catch(fail); }
      return;
    }
    svg.setPointerCapture(event.pointerId);
    board.drawing = board.tool === 'pen' ? { kind:'pen', points:[[x, y]] } : board.tool === 'arrow' ? { kind:'arrow', x1:x, y1:y, x2:x, y2:y } : { kind:board.tool, x, y, w:0, h:0 };
  });
  svg.addEventListener('pointermove', event => {
    const shape = board.drawing;
    if (!shape) return;
    const [x, y] = boardPoint(event);
    if (shape.kind === 'pen') shape.points.push([x, y]);
    else if (shape.kind === 'arrow') Object.assign(shape, { x2:x, y2:y });
    else Object.assign(shape, { w:x - shape.x, h:y - shape.y });
    renderBoard();
  });
  svg.addEventListener('pointerup', () => {
    if (!board.drawing) return;
    state.board.shapes.push(board.drawing);
    board.drawing = null;
    renderBoard();
    saveStructured(JSON.stringify(state.board)).catch(fail);
  });
  for (const button of document.querySelectorAll('[data-tool]')) button.addEventListener('click', () => {
    board.tool = button.dataset.tool;
    for (const other of document.querySelectorAll('[data-tool]')) other.setAttribute('aria-pressed', String(other === button));
  });
  $('board-undo').addEventListener('click', () => { state.board.shapes.pop(); renderBoard(); saveStructured(JSON.stringify(state.board)).catch(fail); });
  $('board-figure').addEventListener('click', () => boardFigure().catch(fail));
}

// Saves the board as a PDF beside it, ready for \includegraphics.
async function boardFigure() {
  const pdfPath = state.path.replace(/\.board$/i, '.pdf');
  await writeFile(pdfPath, await boardPdf(state.board));
  state.files = await listFiles(store, state.project);
  renderTree();
  say(`Saved ${pdfPath}. Include it with \\includegraphics{${pdfPath}}.`);
  return { pdf:pdfPath };
}

async function newBoard() {
  let index = 1;
  while (fileExists(`figures/board-${index}.board`)) index += 1;
  const path = `figures/board-${index}.board`;
  await writeFile(path, JSON.stringify(blankBoard()));
  state.texts[path] = JSON.stringify(blankBoard());
  state.files = await listFiles(store, state.project);
  await openFile(path);
  return path;
}

let katex = null;
async function showPreview() {
  if (!$('preview').open) return;
  if (/\.md$/i.test(state.path || '')) { $('preview-body').innerHTML = renderMarkdown(editor.text); return; }
  katex ||= (await import('../vendor/katex.mjs')).default;
  const source = paragraphAt(editor.text, editor.cursor);
  $('preview-body').innerHTML = renderParagraph(source, {
    labels:state.labels || new Map(),
    math:(tex, display) => katex.renderToString(tex, { displayMode:display, output:'mathml', throwOnError:false }),
  });
}

const paperPath = key => `${projectRoot()}/.scribella/papers/${key.replace(/[^\w.-]/g, '_')}.md`;

async function fetchFullText(key) {
  const entry = bibEntries().find(item => item.key === key);
  const id = entry?.fields.eprint || /arxiv\.(.+)$/i.exec(entry?.fields.doi || '')?.[1];
  if (!id) throw new Error(`${key} has no arXiv id, and only arXiv papers have a full text route here.`);
  const project = state.project;
  say(`Reading ${key} from arXiv…`);
  const markdown = await arxivMarkdown(id);
  if (state.project !== project) return null;
  await store.write(paperPath(key), `# ${entry.fields.title}\n\n${markdown}\n`);
  say(`Saved the full text of ${key}.`);
  return { key, characters:markdown.length };
}

async function searchPapers(query) {
  const folder = `${projectRoot()}/.scribella/papers`;
  if (!await store.exists(folder)) return [];
  const texts = {};
  for (const entry of await store.list(folder)) if (entry.endsWith('.md')) texts[entry.replace(/^.*\//, '').replace(/\.md$/, '')] = await store.read(entry);
  return findAll(texts, query);
}

const gitOf = () => projectGit(store, projectRoot());

async function renderGit() {
  const commits = await gitOf().log().catch(() => []);
  $('git-log').replaceChildren(...commits.map(item => {
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'row'; go.dataset.command = 'git-commit-open';
    go.textContent = `${item.message} · ${new Date(item.at).toLocaleString()}`;
    go.addEventListener('click', () => showCommit(item).catch(fail));
    row.append(go);
    return row;
  }));
  return commits;
}

async function commitProject(message) {
  await saveNow();
  const result = await gitOf().commitAll(message || 'Snapshot');
  say(result ? `Committed ${result.changed} ${result.changed === 1 ? 'file' : 'files'}.` : 'Nothing changed since the last commit.');
  await renderGit();
  return result;
}

async function showCommit(item) {
  const project = state.project, repo = gitOf(), files = await repo.changed(item.oid);
  const rows = await Promise.all(files.map(async path => {
    const bytes = await repo.readAt(item.oid, path).catch(() => null);
    if (!bytes) return { title:path, detail:'Deleted in this commit' };
    return {
      title:path, detail:'Changed in this commit',
      fixLabel:'Restore this version', fix:async () => {
        if (state.project !== project) throw new Error('This commit belongs to another project.');
        if (!confirm(`Replace ${path} with its version from "${item.message}"? Commit first if you want to keep the current one.`)) return;
        if (isText(path)) await setText(path, new TextDecoder().decode(bytes));
        else { await writeFile(path, bytes); state.files = await listFiles(store, state.project); renderTree(); }
      },
    };
  }));
  showChecks(`${item.message}: ${files.length} ${files.length === 1 ? 'file' : 'files'}`, rows);
}

const OVERLEAF_PROXY = 'https://scribella.naklitechie.com/git-proxy';
const overleafFile = () => `${projectRoot()}/${STATE_PATH}`;
const overleafLink = async () => (await store.exists(overleafFile()) ? JSON.parse(await store.read(overleafFile())) : {});

async function renderOverleaf() {
  const link = await overleafLink();
  $('overleaf-state').textContent = link.id ? `Linked to Overleaf project ${link.id.slice(0, 6)}…` : 'Not linked.';
  $('overleaf-pull').hidden = $('overleaf-push').hidden = !link.id;
}

async function linkOverleaf(address, token) {
  const id = overleafProjectId(address);
  if (!id) throw new Error('Paste the Overleaf project address, which holds a 24-character id.');
  if (!token) throw new Error('Paste a Git token from Overleaf: Account settings, Git integration.');
  // A different project starts its sync history over, so the old project's files are never the merge base.
  const old = await overleafLink();
  if (old.id && old.id !== id) await store.remove(`${projectRoot()}/.scribella/overleaf-git`).catch(() => {});
  await store.write(overleafFile(), JSON.stringify(old.id === id ? { ...old, token } : { id, token }));
  await renderOverleaf();
  return overleafRun('pull');
}

async function overleafRun(direction) {
  await saveNow();
  const link = await overleafLink();
  if (!link.id) throw new Error('Link an Overleaf project first.');
  const project = state.project;
  say(direction === 'pull' ? 'Pulling from Overleaf…' : 'Sending to Overleaf…');
  const sync = overleafSync({ store, root:projectRoot(), link, proxy:OVERLEAF_PROXY });
  // Editing waits while files change underneath, so nothing typed meanwhile is lost.
  editor.setLocked(true);
  document.body.dataset.locked = 'true';
  let result;
  try { result = direction === 'pull' ? await sync.pull() : await sync.push(); }
  finally { editor.setLocked(false); delete document.body.dataset.locked; }
  if (state.project !== project) return result;
  state.files = await listFiles(store, state.project);
  for (const path of state.files.filter(isText)) { state.texts[path] = await store.read(fullPath(path)); state.saved[path] = state.texts[path]; }
  state.revision += 1;
  if (state.path) { const keep = state.path; state.path = null; await openFile(state.files.includes(keep) ? keep : state.settings.main); }
  renderTree();
  showCounts();
  if (result.conflicts?.length) say(`Both sides changed ${result.conflicts.join(', ')}. Resolve the marked lines, or for a deleted or binary file decide which copy to keep, then push again.`, true);
  else if (direction === 'pull') say(result.changed.length ? `Pulled ${result.changed.length} changed ${result.changed.length === 1 ? 'file' : 'files'} from Overleaf.` : 'Overleaf has nothing new.');
  else say(result.pushed ? `Sent ${result.files} ${result.files === 1 ? 'file' : 'files'} to Overleaf.` : 'Nothing to send.');
  return result;
}

const agent = { history:[{ role:'system', content:SYSTEM }] };

function agentLine(role, text) {
  const item = document.createElement('li');
  item.className = `agent-${role}`;
  item.textContent = text;
  $('agent-log').append(item);
  item.scrollIntoView({ block:'nearest' });
}

async function agentTool(name, args) {
  if (name === 'list_files') return state.files;
  if (name === 'read_file') { if (!(args.path in state.texts)) throw new Error(`${args.path} is not a text file here.`); return state.texts[args.path]; }
  if (name === 'search') return findAll(state.texts, args.query).slice(0, 40).map(item => `${item.file}:${item.line}: ${item.text}`).join('\n') || 'No matches.';
  if (name === 'build') {
    if (!canCompile()) return 'Compiling is not available here.';
    const { ok, problems } = await commands['build.run']();
    return ok ? 'Built with no errors.' : `Build failed:\n${problems.map(item => `${item.file}:${item.line} ${item.headline}`).join('\n')}`;
  }
  if (name === 'propose_edit') {
    const text = state.texts[args.path];
    if (text == null) throw new Error(`${args.path} is not in the project.`);
    const at = text.indexOf(args.find);
    if (at < 0 || text.indexOf(args.find, at + 1) >= 0) throw new Error('`find` must appear exactly once in the file.');
    if (args.path !== state.path) await openFile(args.path);
    const decision = await showProposal({ file:args.path, from:at, to:at + args.find.length, revision:args.replace, reason:args.reason || 'The agent proposes an edit.' });
    return `The researcher ${decision} this edit.`;
  }
  throw new Error(`Unknown tool ${name}.`);
}

async function askAgent(question) {
  if (!aiReady()) throw new Error('Set up AI in NakliOS to use the agent.');
  await saveNow();
  agentLine('you', question);
  agent.history.push({ role:'user', content:question });
  const project = state.project;
  const { messages, text } = await agentTurn(agent.history, {
    ask:async (history, tools) => (await naklios.ai.chat.completions.create({ messages:history, tools, max_tokens:2048, stream:false })).choices[0].message,
    run:(name, args) => { if (state.project !== project) throw new Error('The project changed.'); return agentTool(name, args); },
    onStep:name => agentLine('step', `Using ${name.replace('_', ' ')}…`),
  });
  agent.history = messages;
  agentLine('agent', text);
  return text;
}

async function goToDefinition(at) {
  const token = tokenAt(editor.text, at);
  if (!token) { say('Put the cursor on a \\ref, \\cite, \\label or \\input key.'); return null; }
  if (token.kind === 'label') {
    const uses = usesOf(token.key, state.texts);
    showChecks(`${uses.length} ${uses.length === 1 ? 'use' : 'uses'} of ${token.key}`, uses.map(use => ({ title:use.text, detail:`${use.file}:${use.line}`, go:() => jump(use.file, use.line) })));
    return uses;
  }
  const place = definitionOf(token, state.texts);
  if (!place) { say(`No definition of ${token.key} in this project.`); return null; }
  await jump(place.file, place.line);
  return place;
}

function linkBib(file) {
  const run = addQueue.then(() => linkBibNow(file));
  addQueue = run.catch(() => {});
  return run;
}

// Entries already present by key and paper are skipped. A key taken by a different paper gets a letter, and the
// person is told, because citations written against the other file still use the old key.
async function linkBibNow(file) {
  const text = await file.text(), incoming = parseBib(text).entries;
  if (!incoming.length) throw new Error('That file holds no BibTeX entries.');
  const target = bibFiles()[0] || 'references.bib', existing = bibEntries();
  const fresh = [], renamed = [];
  for (const entry of incoming) {
    const same = existing.find(item => item.key === entry.key);
    if (same && sameWork(same.fields, entry.fields)) continue;
    let raw = entry.raw;
    if (same) {
      let key = entry.key;
      for (let letter = 98; existing.some(item => item.key === key) || fresh.some(item => item.key === key); letter += 1) key = `${entry.key}${String.fromCharCode(letter)}`;
      raw = raw.replace(/^(@\w+\s*\{\s*)[^,\s]+/, `$1${key}`);
      renamed.push(`${entry.key} → ${key}`);
      fresh.push({ key, raw });
    } else fresh.push({ key:entry.key, raw });
  }
  const current = state.texts[target] || '';
  // @string and @preamble blocks carry definitions entries may use; new ones come along.
  const definitions = [...text.matchAll(/@(string|preamble)\s*\{[^@]*?\}\s*(?=@|$)/gi)].map(match => match[0].trim()).filter(block => !current.includes(block));
  if (!fresh.length && !definitions.length) { say(`All ${incoming.length} entries are already in ${target}.`); return { added:0 }; }
  if (!confirm(`Add ${fresh.length} entries from ${file.name} to ${target}?${renamed.length ? ` ${renamed.length} keys are taken by other papers and get a letter: ${renamed.join(', ')}.` : ''}`)) return { added:0 };
  await setText(target, `${definitions.join('\n')}${definitions.length ? '\n\n' : ''}${current.trimEnd()}\n\n${fresh.map(entry => entry.raw).join('\n\n')}\n`.trimStart());
  say(`Added ${fresh.length} entries to ${target}.${renamed.length ? ` Renamed: ${renamed.join(', ')}.` : ''}`);
  return { added:fresh.length, renamed };
}

async function formatFile() {
  if (!editingText() || !/\.(tex|ltx)$/i.test(state.path)) throw new Error('Open a LaTeX file first.');
  const next = formatLatex(editor.text);
  if (next !== editor.text) editor.replaceRange(0, editor.text.length, next);
  say('Formatted.');
}

async function checkSetup() {
  const rows = [];
  const add = (title, detail, status) => rows.push({ title, detail, status });
  add(storeKind === 'host' ? 'Storage: NakliOS' : 'Storage: this browser only', storeKind === 'host' ? 'Projects can compile.' : 'Compiling needs a NakliOS Folder or Crate.', storeKind === 'host' ? 'checked' : 'warn');
  if (canCompile()) {
    const cache = await naklios.experimental_tex.cache();
    const ready = cache.packs.filter(pack => pack.cached).length;
    add(`TeX Live packs: ${ready} of ${cache.packs.length} in this browser`, ready === cache.packs.length ? 'Compiles need no download.' : 'The next compile downloads about 680 MB.', ready === cache.packs.length ? 'checked' : 'warn');
  } else add('TeX: not available here', COMPILE_HINT(), 'warn');
  add(aiReady() ? 'AI: available' : 'AI: not set up', aiReady() ? 'Proofread, Polish and revision rounds can run.' : 'Everything except revision works without it.', aiReady() ? 'checked' : 'warn');
  showChecks('Setup', rows);
  return rows.map(({ title, detail }) => ({ title, detail }));
}

const STEPS = [['build', 'Build the paper'], ['paper', 'Add a paper'], ['note', 'Add a note'], ['version', 'Save a version']];
const STEPS_ITEM = 'scribella.steps';
const doneSteps = () => { try { return new Set(JSON.parse(localStorage.getItem(STEPS_ITEM)) || []); } catch (_) { return new Set(); } };

function renderSteps() {
  const done = doneSteps();
  $('steps').hidden = STEPS.every(([id]) => done.has(id));
  $('steps').replaceChildren(...STEPS.map(([id, label]) => {
    const item = document.createElement('span');
    item.textContent = `${done.has(id) ? '✓' : '○'} ${label}`;
    item.className = done.has(id) ? 'step done' : 'step';
    return item;
  }));
}

function completeStep(id) {
  const done = doneSteps();
  if (done.has(id)) return;
  done.add(id);
  try { localStorage.setItem(STEPS_ITEM, JSON.stringify([...done])); } catch (_) {}
  renderSteps();
}

async function exportProject() {
  await saveNow();
  const files = await Promise.all(state.files.map(async path => ({ path, bytes:await store.readBinary(fullPath(path)) })));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([makeZip(files)], { type:'application/zip' }));
  link.download = `${safeName(state.project)}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  say(`Exported ${files.length} files.`);
}

async function importProject(file) {
  const files = readZip(new Uint8Array(await file.arrayBuffer()));
  if (!files.length) throw new Error('This zip holds no files.');
  const name = safeName(file.name.replace(/\.zip$/i, '')) || 'Imported';
  const existing = await listProjects(store);
  let unique = name;
  for (let copy = 2; existing.includes(unique); copy += 1) unique = `${name} ${copy}`;
  for (const { path, bytes } of files) await store.write(`${projectFolder(unique)}/${path}`, bytes);
  await writeSettings(store, unique, { engine:'pdflatex' });
  await openProject(unique);
}

const searchOptions = () => ({ regex:$('search-regex').checked, matchCase:$('search-case').checked });

function showMatches(matches) {
  $('search-count').textContent = `${matches.length}${matches.length >= 500 ? '+' : ''} ${matches.length === 1 ? 'match' : 'matches'}`;
  $('search-results').replaceChildren(...matches.map(item => {
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'row';
    go.dataset.command = 'search-result';
    go.title = item.text;
    go.textContent = `${item.file}:${item.line} ${item.text}`;
    go.addEventListener('click', () => jump(item.file, item.line, item.match).catch(fail));
    row.append(go);
    return row;
  }));
}

function runSearch() {
  try { showMatches(findAll(state.texts, $('search-query').value, searchOptions())); }
  catch (error) { $('search-count').textContent = `Bad pattern: ${error.message}`; }
}

async function replaceEverywhere(query, replacement, options) {
  if (Object.values(state.texts).some(text => findAll({ x:text }, query, options).length)) await keepVersion('Before replace all');
  let total = 0;
  for (const path of Object.keys(state.texts)) {
    const { text, count } = replaceAllIn(state.texts[path], query, replacement, options);
    if (!count) continue;
    total += count;
    state.texts[path] = text;
    await writeFile(path, text);
    if (path === state.path) editor.load(text);
  }
  state.revision += 1;
  showCounts();
  if (total && state.auto) build();
  return total;
}

function openPalette() {
  const filter = $('symbol-filter').value.trim().toLowerCase();
  $('symbols').replaceChildren(...SYMBOLS.flatMap(({ group, names }) => {
    const shown = names.filter(name => name.toLowerCase().includes(filter));
    if (!shown.length) return [];
    const heading = document.createElement('h2');
    heading.textContent = group;
    return [heading, ...shown.map(name => {
      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'btn small';
      pick.dataset.command = 'insert-symbol';
      pick.textContent = `\\${name}`;
      pick.addEventListener('click', () => { $('palette-dialog').close(); editor.insert(`\\${name}`); });
      return pick;
    })];
  }));
}

async function insertTable() {
  const rows = parseTable($('table-data').value);
  if (!rows.length) throw new Error('Paste some rows first.');
  const caption = $('table-caption').value.trim();
  editor.insert(tableBlock(rows, { caption, label:slug(caption || 'table') }));
  $('table-dialog').close();
  if (needsBooktabs(state.texts[state.settings.main] || '')) say('Add \\usepackage{booktabs} to the preamble for this table.', true);
}

const projectRoot = () => projectFolder(state.project);
const bibFiles = () => Object.keys(state.texts).filter(path => /\.bib$/i.test(path));
const bibEntries = () => bibFiles().flatMap(file => parseBib(state.texts[file]).entries.map(entry => ({ ...entry, file })));

async function setText(path, text) {
  await writeFile(path, text);
  state.texts[path] = text;
  if (!state.files.includes(path)) state.files = await listFiles(store, state.project);
  if (path === state.path) editor.load(text);
  state.revision += 1;
  renderTree();
}

async function addPaper(input) {
  say('Looking up the paper…');
  const project = state.project;
  const entry = await findPaper(input);
  if (state.project !== project) return null;
  if (!entry) { say('No record found for that.', true); return null; }
  return addEntry(entry);
}

async function discoverPapers(query) {
  say('Searching OpenAlex…');
  const project = state.project;
  const found = await discover(query);
  if (state.project !== project) return [];
  showChecks(`${found.length} papers for "${query}"`, found.map(entry => ({
    title:entry.fields.title, detail:`${entry.fields.author.split(' and ')[0]} · ${entry.fields.year} · cited ${entry.cited} times`,
    fixLabel:'Add', fix:() => { if (state.project !== project) throw new Error('This list belongs to another project.'); return addEntry(entry); },
  })));
  say('Ready.');
  return found.map(({ key, fields, cited }) => ({ key, title:fields.title, year:fields.year, cited }));
}

async function reviewPdf() {
  if (!state.sync || state.builtRevision !== state.revision) { say('Build the paper first, so notes land in the right place.'); return null; }
  const placed = [];
  for (const note of review.notes.filter(item => item.status !== 'resolved' && item.body)) {
    const place = whereIs(note);
    const line = place ? state.texts[note.file].slice(0, place.from).split('\n').length : 0;
    const box = line && forward(state.sync, note.file, line);
    if (box) placed.push({ page:box.page, x:box.x, y:box.y, text:note.body });
  }
  if (!placed.length) { say('No open notes have a place in the PDF.'); return null; }
  const { annotatePdf } = await import('./review-pdf.js');
  const stem = state.settings.main.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
  const bytes = await annotatePdf(await store.readBinary(`${projectRoot()}/.tex-build/${stem}.pdf`), placed);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([bytes], { type:'application/pdf' }));
  link.download = `${safeName(state.project)}-review.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  say(`Review PDF saved with ${placed.length} notes.`);
  return { notes:placed.length };
}

// One add at a time, because each builds on the bibliography the last one left.
let addQueue = Promise.resolve();
function addEntry(entry) {
  const run = addQueue.then(() => addEntryNow(entry));
  addQueue = run.catch(() => {});
  return run;
}

async function addEntryNow(entry) {
  const file = bibFiles()[0] || 'references.bib', existing = bibEntries();
  const newDoi = entry.fields.doi?.toLowerCase();
  const same = existing.find(item => {
    const doi = item.fields.doi?.toLowerCase();
    return doi && newDoi ? doi === newDoi : sameWork(item.fields, entry.fields);
  });
  if (same) { say(`Already in the bibliography as ${same.key}.`); return same; }
  // Two papers can share a first author, year and title word, so a taken key gets a letter.
  const base = entry.key;
  for (let letter = 98; existing.some(item => item.key === entry.key); letter += 1) entry.key = `${base}${String.fromCharCode(letter)}`;
  await setText(file, `${(state.texts[file] || '').trimEnd()}\n\n${writeEntry(entry)}`.trimStart());
  say(`Added ${entry.key} to ${file}.`);
  completeStep('paper');
  return entry;
}

function showChecks(title, rows) {
  $('checks-title').textContent = title;
  $('checks-list').replaceChildren(...rows.map(row => {
    const item = document.createElement('li');
    item.className = `check ${row.status || ''}`;
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'problem'; go.dataset.command = 'check-go';
    const head = document.createElement('strong');
    head.textContent = row.title;
    const place = document.createElement('span');
    place.className = 'place';
    place.textContent = row.detail || '';
    go.append(head, place);
    if (row.go) go.addEventListener('click', () => row.go().catch(fail));
    item.append(go);
    if (row.fix) {
      const fix = document.createElement('button');
      fix.type = 'button'; fix.className = 'btn small'; fix.dataset.command = 'check-fix'; fix.textContent = row.fixLabel;
      fix.addEventListener('click', () => row.fix().then(() => { fix.disabled = true; }).catch(fail));
      item.append(fix);
    }
    return item;
  }));
  $('tab-checks').click();
}

// Lookups run four at a time, because the services limit bursts.
async function eachLimited(items, work, limit = 4) {
  const results = [];
  let next = 0;
  await Promise.all(Array.from({ length:limit }, async () => {
    while (next < items.length) { const index = next; next += 1; results[index] = await work(items[index]); }
  }));
  return results;
}

async function auditReferences() {
  await saveNow();
  const entries = bibEntries();
  if (!entries.length) { say('This project has no bibliography entries.'); return []; }
  const local = bibFiles().flatMap(file => scanEntries(parseBib(state.texts[file])).map(item => ({ title:item.message, detail:item.key ? `${file}: ${item.key}` : file, status:'warn' })));
  say(`Checking ${entries.length} references…`);
  const project = state.project;
  const results = await eachLimited(entries, entry => auditEntry(entry));
  if (state.project !== project) return [];
  review.notices = Object.fromEntries(results.filter(item => item.notices?.length).map(item => [item.key, item.notices]));
  const labels = { checked:'Matches the record', update:'A record adds details', conflict:'Differs from the record', unmatched:'No record found', unavailable:'Could not check', skipped:'Skipped' };
  const rows = results.map((result, index) => {
    const notice = result.notices?.length ? `Notice: ${result.notices.join(', ')}. ` : '';
    const row = { title:`${result.key}: ${labels[result.status]}`, detail:`${notice}${result.message || ''}`, status:result.notices?.length ? 'bad' : result.status };
    const entry = entries[index];
    if (!result.additions && (entry.fields.eprint || /arxiv/i.test(entry.fields.doi || ''))) Object.assign(row, { fixLabel:'Save full text', fix:() => fetchFullText(entry.key) });
    if (result.additions) Object.assign(row, { fixLabel:'Add the details', fix:() => addEntryDetails(project, entries[index], result.additions) });
    return row;
  });
  const seen = results.filter(item => item.status === 'checked' || item.status === 'update').length;
  showChecks(`References: ${seen} of ${entries.length} seen in a record`, [...local, ...rows]);
  say(`Checked ${entries.length} references.`);
  return results;
}

async function addEntryDetails(project, entry, additions) {
  if (state.project !== project) throw new Error('This check belongs to another project.');
  await setText(entry.file, addFields(state.texts[entry.file], entry, additions));
}

async function submissionCheck() {
  await saveNow();
  const source = checkSource(state.texts).map(item => ({ title:item.message, detail:`${item.file}:${item.line}`, status:'warn', go:() => jump(item.file, item.line) }));
  // Only a PDF built from the current text, and not the changes PDF, says anything about this submission.
  const facts = state.builtRevision === state.revision ? await pdf.inspect() : null;
  const fromPdf = facts ? checkPdf(facts).map(item => ({ title:item.message, detail:item.page ? `PDF page ${item.page}` : 'PDF', status:'warn' })) : [];
  const rows = [...source, ...fromPdf];
  showChecks(`Double-blind check: ${rows.length} ${rows.length === 1 ? 'finding' : 'findings'}${facts ? '' : ' (source only: build first to include the PDF)'}`, rows);
  return rows;
}

const notesFile = () => `${projectRoot()}/${NOTES_PATH}`;
const saveNotes = () => store.write(notesFile(), JSON.stringify({ notes:review.notes, rounds:review.rounds }, null, 1));
const whereIs = note => (state.texts[note.file] == null ? null : locate(state.texts[note.file], note.anchor));

function showNoteMarks() {
  if (!editingText()) return;
  editor.showMarks(review.notes.filter(note => note.file === state.path && note.status !== 'resolved').flatMap(note => {
    const place = whereIs(note);
    return place ? [{ ...place, color:note.color || 'note' }] : [];
  }));
}

function renderNotes() {
  const open = review.notes.filter(note => note.status !== 'resolved');
  $('notes-tab').textContent = `Notes (${open.length})`;
  $('revise-all').hidden = !aiReady() || !open.some(note => note.body);
  $('notes').replaceChildren(...review.notes.map(note => {
    const row = document.createElement('li');
    row.className = `note ${note.status}`;
    const go = document.createElement('button');
    go.type = 'button'; go.className = 'problem'; go.dataset.command = 'note-go';
    const place = whereIs(note);
    const quote = document.createElement('span');
    quote.className = 'place';
    quote.textContent = `${note.file}: ${note.anchor.quote.slice(0, 70)}${place ? '' : ' (text no longer found)'}`;
    const body = document.createElement('strong');
    body.textContent = note.body || HIGHLIGHTS.find(([id]) => id === note.color)?.[1] || 'Note';
    go.append(body, quote);
    go.addEventListener('click', () => goToNote(note).catch(fail));
    row.append(go);
    const action = (label, command, run) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn small'; button.dataset.command = command; button.textContent = label;
      button.addEventListener('click', () => Promise.resolve().then(run).catch(fail));
      row.append(button);
    };
    if (aiReady() && note.body && place && note.status !== 'resolved') action('Revise', 'note-revise', () => reviseNote(note));
    action(note.status === 'resolved' ? 'Reopen' : 'Resolve', 'note-resolve', () => setNoteStatus(note, note.status === 'resolved' ? 'open' : 'resolved'));
    action('Delete', 'note-delete', () => deleteNote(note));
    return row;
  }));
  showNoteMarks();
}

async function goToNote(note) {
  if (!state.files.includes(note.file)) { say(`${note.file} is no longer in the project.`, true); return; }
  if (note.file !== state.path) await openFile(note.file);
  const place = whereIs(note);
  if (place) editor.select(place.from, place.to);
}

async function addNote({ body = '', intent = '', color = 'note', file = state.path, from, to }) {
  if (from == null) ({ from, to } = editor.selection);
  if (from === to) throw new Error('Select some text first.');
  const note = { id:`n${Date.now()}${Math.floor(Math.random() * 1000)}`, file, anchor:makeAnchor(state.texts[file], from, to), body, intent, color, status:'open' };
  review.notes.unshift(note);
  await saveNotes();
  renderNotes();
  completeStep('note');
  return note;
}

async function setNoteStatus(note, status) { note.status = status; await saveNotes(); renderNotes(); }
async function deleteNote(note) { review.notes = review.notes.filter(item => item !== note); await saveNotes(); renderNotes(); }

async function askModel(messages) {
  const reply = await naklios.ai.chat.completions.create({ messages, max_tokens:4096, stream:false, onStatus:status => say(`The model is ${status}…`) });
  return parseReply(reply.choices?.[0]?.message?.content || '');
}

function renderProposal() {
  const proposal = review.proposal;
  $('proposal').hidden = !proposal;
  if (!proposal) return;
  $('proposal-reason').textContent = proposal.question ? `The model asks: ${proposal.question}` : proposal.reason || 'Proposed edits';
  $('proposal-accept').hidden = !!proposal.question;
  $('proposal-edits').replaceChildren(...(proposal.edits || []).map((edit, index) => {
    const row = document.createElement('li');
    const box = document.createElement('input');
    box.type = 'checkbox'; box.checked = !edit.held; box.disabled = edit.held; box.dataset.index = index;
    box.setAttribute('aria-label', 'Apply this edit');
    const words = document.createElement('span');
    const gone = document.createElement('del'); gone.textContent = edit.original;
    const come = document.createElement('ins'); come.textContent = edit.insert;
    words.append(gone, ' ', come);
    if (edit.held) words.append(' (held: touches math, a citation or a command)');
    row.append(box, ' ', words);
    return row;
  }));
  if (proposal.edits && !proposal.edits.length) $('proposal-reason').textContent = 'The model suggests no changes here.';
  $('tab-notes').click();
}

// Answers when the person has decided, so a round can wait for each proposal in turn.
async function propose({ file, from, to, task = '', note = null, instruction = '', rejected = '', guidance = '' }) {
  const text = state.texts[file], passage = text.slice(from, to);
  if (passage.length > MAX_PASSAGE) throw new Error('This passage is too long. Select less text.');
  const keys = [...projectIndex().bibKeys];
  const messages = buildMessages({ task, passage, before:text.slice(Math.max(0, from - 1200), from), after:text.slice(to, to + 1200), note:note?.body, intent:note?.intent, instruction, rejected, guidance, keys });
  say('Asking the model…');
  const project = state.project;
  const reply = await askModel(messages);
  if (state.project !== project) return 'abandoned';
  say('Ready.');
  // A citation note may add \\cite commands for keys in the bibliography, and nothing else protected.
  const citeKeys = note?.intent === 'cite' ? keys : [];
  review.proposal = { project, file, from, to, passage, task, note, instruction, citeKeys, ...reply, edits:reply.revision === undefined ? null : wordEdits(passage, reply.revision) };
  renderProposal();
  return new Promise(resolve => { review.proposal.done = resolve; });
}

// A proposal that already has its replacement, from the agent. It waits on the same Accept and Reject.
function showProposal({ file, from, to, revision, reason }) {
  const passage = state.texts[file].slice(from, to);
  review.proposal = { project:state.project, file, from, to, passage, task:'', note:null, citeKeys:[], revision, reason, edits:wordEdits(passage, revision) };
  renderProposal();
  return new Promise(resolve => { review.proposal.done = resolve; });
}

function chosenEdits() {
  return [...$('proposal-edits').querySelectorAll('input:checked')].map(box => review.proposal.edits[Number(box.dataset.index)]);
}

async function acceptProposal() {
  const proposal = review.proposal, { file, from, to, passage } = proposal;
  if (state.path !== file) await openFile(file);
  if (editor.slice(from, to) !== passage) throw new Error('This text changed while the proposal waited, so nothing was applied. Try again.');
  if (proposal.project !== state.project) throw new Error('This proposal belongs to another project.');
  const next = safeResult(passage, chosenEdits(), { citeKeys:proposal.citeKeys });
  editor.replaceRange(from, to, next);
  if (proposal.note) {
    proposal.note.anchor = makeAnchor(editor.text, from, from + next.length);
    await setNoteStatus(proposal.note, 'resolved');
  }
  finishProposal('accepted');
}

function finishProposal(outcome) {
  const done = review.proposal?.done;
  review.proposal = null;
  renderProposal();
  done?.(outcome);
}

async function rejectProposal() {
  if (review.proposal?.note) await setNoteStatus(review.proposal.note, 'rejected');
  finishProposal('rejected');
}

async function tryAgain() {
  const { file, from, to, task, note, instruction, revision, done } = review.proposal;
  const guidance = prompt('What should change? This is optional.', '') ?? '';
  review.proposal = null;
  renderProposal();
  done?.(await propose({ file, from, to, task, note, instruction, rejected:revision || '', guidance }));
}

async function reviseSelection(task, instruction = '') {
  const { from, to } = editor.selection;
  if (from === to) throw new Error('Select some text first.');
  await saveNow();
  return propose({ file:state.path, from, to, task, instruction });
}

async function reviseNote(note) {
  const place = whereIs(note);
  if (!place) throw new Error('This note lost its text.');
  if (note.file !== state.path) await openFile(note.file);
  return propose({ file:note.file, ...place, note });
}

// One proposal at a time; when the last settles, the round is saved as a version.
async function reviseRound() {
  await saveNow();
  review.rounds += 1;
  const number = review.rounds, open = review.notes.filter(note => note.status === 'open' && note.body && whereIs(note));
  const outcomes = [];
  for (const note of open) outcomes.push(await reviseNote(note));
  await saveNotes();
  await saveNow();
  await keepVersion(`Round ${number}`);
  return outcomes;
}

async function renderVersions() {
  const versions = await listVersions(store, projectRoot());
  $('versions').replaceChildren(...versions.map(version => {
    const row = document.createElement('li');
    row.className = 'version';
    const name = document.createElement('span');
    name.textContent = `${version.label} · ${new Date(version.at).toLocaleString()}`;
    const compare = document.createElement('button');
    compare.type = 'button'; compare.className = 'btn small'; compare.dataset.command = 'version-changes'; compare.textContent = 'Changes';
    compare.addEventListener('click', () => changesPdf(version).catch(fail));
    const restore = document.createElement('button');
    restore.type = 'button'; restore.className = 'btn small'; restore.dataset.command = 'version-restore'; restore.textContent = 'Restore';
    restore.addEventListener('click', () => { if (confirm(`Restore "${version.label}"? Your current text is saved as a version first.`)) restoreVersion(version).catch(fail); });
    row.append(name, compare, restore);
    return row;
  }));
}

async function keepVersion(label) {
  await saveNow();
  const version = await saveVersion(store, projectRoot(), state.texts, label);
  await renderVersions();
  say(`Saved "${version.label}".`);
  completeStep('version');
  return version;
}

async function restoreVersion(version) {
  await keepVersion(`Before restoring ${version.label}`);
  const texts = await readVersion(store, projectRoot(), version.id);
  for (const path of Object.keys(state.texts)) {
    if (path in texts) continue;
    await store.remove(fullPath(path));
    delete state.texts[path];
  }
  for (const [path, text] of Object.entries(texts)) { await writeFile(path, text); state.texts[path] = text; }
  state.files = await listFiles(store, state.project);
  state.revision += 1;
  if (!state.files.includes(state.settings.main)) await changeSettings({ main:findMain(state.files, state.texts) });
  state.dirty = false;
  state.path = null;
  await openFile(state.settings.main || state.files[0]);
  showCounts();
  build();
}

// Builds a set of files in a scratch folder and answers the compile result. The project's own build stays as it is.
async function scratchBuild(files, main) {
  await store.remove(SCRATCH).catch(() => {});
  for (const { path, data } of files) await store.write(`${SCRATCH}/${path}`, data);
  say('Compiling a separate copy…');
  return naklios.experimental_tex.compile({ folder:SCRATCH, main, engine:state.settings.engine || 'pdflatex' });
}

async function changesPdf(version) {
  if (!canCompile()) { say(COMPILE_HINT()); return null; }
  await saveNow();
  const old = await readVersion(store, projectRoot(), version.id);
  const files = await Promise.all(state.files.map(async path => ({
    path,
    data:/\.(tex|ltx)$/i.test(path) ? markChanges(old[path] ?? '', state.texts[path]) : await store.readBinary(fullPath(path)),
  })));
  const result = await scratchBuild(files, state.settings.main);
  if (!result.ok || !result.pdf) { say('The changes PDF did not build. The marks may clash with a package here.', true); return result; }
  await pdf.show(await store.readBinary(result.pdf));
  state.sync = null;
  state.builtRevision = null;
  say(`Showing changes since "${version.label}". Build to return to the paper.`);
  return result;
}

async function arxivPack() {
  if (!canCompile()) { say(COMPILE_HINT()); return null; }
  await saveNow();
  // The .bbl must match the .bib as it is now, so the paper builds first.
  const revision = state.revision;
  const fresh = await compile();
  $('build').hidden = false; $('cancel').hidden = true;
  await afterBuild({ result:fresh, stale:revision !== state.revision, revision });
  if (!fresh.ok) { say('The paper does not build yet, so no arXiv pack was made.', true); return fresh; }
  if (revision !== state.revision) { say('The text changed during the build, so no arXiv pack was made. Try again.', true); return null; }
  const main = state.settings.main, stem = main.replace(/\.[^.]+$/, '');
  const { used, missing } = usedFiles({ files:state.files, texts:state.texts, main });
  if (missing.length) { say(`Missing from the project: ${missing.join(', ')}`, true); return { missing }; }
  let removed = 0;
  const files = await Promise.all(used.map(async path => {
    if (!/\.(tex|ltx)$/i.test(path)) return { path, data:await store.readBinary(fullPath(path)) };
    const stripped = stripComments(state.texts[path]);
    removed += stripped.removed;
    return { path, data:stripped.text };
  }));
  const bbl = `${projectRoot()}/.tex-build/${stem.replace(/^.*\//, '')}.bbl`;
  if (await store.exists(bbl)) files.push({ path:`${stem}.bbl`, data:await store.readBinary(bbl) });
  const result = await scratchBuild(files, main);
  if (!result.ok) { say('The arXiv pack did not build on its own, so nothing was saved. See the problems list.', true); state.problems = visibleDiagnostics(result.diagnostics).map(item => ({ ...item, ...explain(item) })); renderProblems(); return result; }
  const zipped = makeZip(files.map(({ path, data }) => ({ path, bytes:typeof data === 'string' ? new TextEncoder().encode(data) : data })));
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([zipped], { type:'application/zip' }));
  link.download = `${safeName(state.project)}-arxiv.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  say(`arXiv pack saved: ${files.length} files, ${removed} comments removed, and it builds on its own.`);
  return { ok:true, files:files.map(file => file.path), removed };
}

// A dragged divider sets one column width; widths are remembered per browser.
function bindSplit(handle) {
  const name = handle.dataset.column;
  handle.addEventListener('pointerdown', start => {
    handle.setPointerCapture(start.pointerId);
    const left = $('workspace').getBoundingClientRect().left, rail = name === '--source' ? $('rail').offsetWidth : 0;
    const move = event => $('workspace').style.setProperty(name, `${Math.max(140, event.clientX - left - rail)}px`);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', () => {
      handle.removeEventListener('pointermove', move);
      try { localStorage.setItem(`scribella${name}`, $('workspace').style.getPropertyValue(name)); } catch (_) {}
    }, { once:true });
  });
}

function bindPage() {
  for (const [id, template] of Object.entries(TEMPLATES)) $('template').append(new Option(template.label, id));
  loadVenues().then(list => { venues = list; for (const [id, venue] of Object.entries(list)) $('template').append(new Option(venue.label, id)); }).catch(error => console.error('Templates failed to load', error));
  $('new-project').addEventListener('submit', event => {
    event.preventDefault();
    createProject(store, $('project-title').value, $('template').value, venues).then(openProject).catch(fail);
  });
  $('home').addEventListener('click', () => saveNow().then(() => { stopWatching?.(); stopWatching = null; state.project = null; state.path = null; return chooseStore(); }).then(renderHome).catch(fail));
  $('build').addEventListener('click', () => saveNow().then(build).catch(fail));
  $('cancel').addEventListener('click', () => { if (state.job) naklios.experimental_tex.cancel(state.job.id); });
  $('auto').addEventListener('change', event => { state.auto = event.target.checked; });
  $('engine').addEventListener('change', event => changeSettings({ engine:event.target.value }).catch(fail));
  $('main-file').addEventListener('change', event => changeSettings({ main:event.target.value }).catch(fail));
  for (const [id, label] of HIGHLIGHTS) $('highlight').append(new Option(label, id));
  for (const [id, label] of INTENTS) $('note-intent').append(new Option(label, id));
  $('annotate').addEventListener('click', () => { review.selection = editor.selection; $('note-dialog').showModal(); $('note-body').focus(); });
  $('note-form').addEventListener('submit', event => {
    event.preventDefault();
    const { from, to } = review.selection;
    addNote({ body:$('note-body').value.trim(), intent:$('note-intent').value, from, to }).then(() => { $('note-body').value = ''; $('note-dialog').close(); $('tab-notes').click(); }).catch(fail);
  });
  $('highlight').addEventListener('change', event => { const color = event.target.value; event.target.value = ''; if (color) addNote({ color }).catch(fail); });
  $('proofread').addEventListener('click', () => reviseSelection('proofread').catch(fail));
  $('polish').addEventListener('click', () => reviseSelection('polish').catch(fail));
  $('rewrite').addEventListener('click', () => { const instruction = prompt('What should change?'); if (instruction) reviseSelection('', instruction).catch(fail); });
  $('proposal-accept').addEventListener('click', () => acceptProposal().catch(fail));
  $('proposal-reject').addEventListener('click', () => rejectProposal().catch(fail));
  $('proposal-again').addEventListener('click', () => tryAgain().catch(fail));
  $('revise-all').addEventListener('click', () => reviseRound().catch(fail));
  const tabs = [['tab-problems', 'problems-list'], ['tab-notes', 'notes-list'], ['tab-checks', 'checks'], ['tab-agent', 'agent']];
  for (const [tab, pane] of tabs) $(tab).addEventListener('click', () => {
    for (const [, other] of tabs) $(other).hidden = other !== pane;
    for (const [other] of tabs) $(other).setAttribute('aria-pressed', String(other === tab));
  });
  $('spell').addEventListener('change', event => { editor.setSpell(event.target.checked); if (event.target.checked) say('Spellcheck downloads a 20 MB engine the first time.'); });
  for (const handle of document.querySelectorAll('.split')) bindSplit(handle);
  try { for (const name of ['--rail', '--source']) { const value = localStorage.getItem(`scribella${name}`); if (value) $('workspace').style.setProperty(name, value); } } catch (_) {}
  $('check-setup').addEventListener('click', () => checkSetup().catch(fail));
  $('format').addEventListener('click', () => formatFile().catch(fail));
  renderSteps();
  bindBoard();
  for (const button of document.querySelectorAll('[data-sheet]')) button.addEventListener('click', () => { try { sheetEdit(button.dataset.sheet); } catch (error) { fail(error); } });
  $('overleaf-form').addEventListener('submit', event => {
    event.preventDefault();
    linkOverleaf($('overleaf-address').value, $('overleaf-token').value.trim()).then(() => { $('overleaf-token').value = ''; $('overleaf-dialog').close(); }).catch(fail);
  });
  $('overleaf-link').addEventListener('click', () => $('overleaf-dialog').showModal());
  $('overleaf-pull').addEventListener('click', () => overleafRun('pull').catch(fail));
  $('overleaf-push').addEventListener('click', () => overleafRun('push').catch(fail));
  $('git-commit').addEventListener('click', () => { const message = prompt('Describe this snapshot', 'Snapshot'); if (message) commitProject(message).catch(fail); });
  $('agent-form').addEventListener('submit', event => {
    event.preventDefault();
    const question = $('agent-input').value.trim();
    if (!question) return;
    $('agent-input').value = '';
    askAgent(question).catch(error => { agentLine('step', error.message); fail(error); });
  });
  $('preview').addEventListener('toggle', () => showPreview().catch(fail));
  editor.view.dom.addEventListener('keyup', () => { clearTimeout(state.previewTimer); state.previewTimer = setTimeout(() => showPreview().catch(() => {}), 300); });
  editor.view.dom.addEventListener('click', () => showPreview().catch(() => {}));
  $('search-papers').addEventListener('click', () => searchPapers($('search-query').value).then(matches => { showMatches([]); showChecks(`${matches.length} matches in saved papers`, matches.map(item => ({ title:item.text, detail:`${item.file}, line ${item.line}` }))); }).catch(fail));
  $('link-bib').addEventListener('change', event => { const [file] = event.target.files; event.target.value = ''; if (file) linkBib(file).catch(fail); });
  $('wrap').addEventListener('change', event => {
    const pick = event.target.value; event.target.value = '';
    if (!pick || !editingText()) return;
    if (pick === 'rename') { const name = prompt('New environment name'); if (name && !editor.renameEnvironment(name.trim())) say('The cursor is not inside an environment.'); }
    else editor.wrapIn(pick);
  });
  $('definition').addEventListener('click', () => goToDefinition(editor.cursor).catch(fail));
  $('discover').addEventListener('click', () => { const query = prompt('Find papers about'); if (query) discoverPapers(query).catch(fail); });
  $('review-pdf').addEventListener('click', () => reviewPdf().catch(fail));
  $('check-references').addEventListener('click', () => auditReferences().catch(fail));
  $('check-blind').addEventListener('click', () => submissionCheck().catch(fail));
  $('add-paper').addEventListener('click', () => { const input = prompt('arXiv id, DOI or exact title'); if (input) addPaper(input).catch(fail); });
  $('show-in-pdf').addEventListener('click', showInPdf);
  $('pdf-find').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); findInPdf(event.shiftKey ? -1 : 1).catch(fail); } });
  $('zoom-in').addEventListener('click', () => pdf.zoomBy(0.2));
  $('zoom-out').addEventListener('click', () => pdf.zoomBy(-0.2));
  $('add-file').addEventListener('click', () => { $('new-file-form').hidden = false; $('new-file-name').focus(); });
  $('new-file-form').addEventListener('submit', event => { event.preventDefault(); newFile().catch(fail); });
  $('delete-file').addEventListener('click', () => deleteFile().catch(fail));
  $('rename-file').addEventListener('click', () => {
    const next = prompt('New file name', state.path);
    if (next && next !== state.path) renameFile(state.path, next).catch(fail);
  });
  $('add-files').addEventListener('change', event => { addFiles([...event.target.files]).catch(fail); event.target.value = ''; });
  $('export').addEventListener('click', () => exportProject().catch(fail));
  $('arxiv').addEventListener('click', () => arxivPack().catch(fail));
  $('save-version').addEventListener('click', () => { const label = prompt('Name this version', 'Draft'); if (label) keepVersion(label).catch(fail); });
  $('import-zip').addEventListener('change', event => { const [file] = event.target.files; event.target.value = ''; if (file) importProject(file).catch(fail); });
  $('search-query').addEventListener('input', runSearch);
  $('search-regex').addEventListener('change', runSearch);
  $('search-case').addEventListener('change', runSearch);
  $('search-todos').addEventListener('click', () => showMatches(findTodos(state.texts)));
  $('replace-all').addEventListener('click', () => {
    const query = $('search-query').value, matches = findAll(state.texts, query, searchOptions());
    if (!matches.length || !confirm(`Replace ${matches.length} matches across the project?`)) return;
    replaceEverywhere(query, $('search-replace').value, searchOptions()).then(count => { say(`Replaced ${count}.`); runSearch(); }).catch(fail);
  });
  $('insert').addEventListener('change', event => {
    const pick = event.target.value;
    event.target.value = '';
    if (pick && pick !== 'board' && !editingText()) { say('Open a text file first.', true); return; }
    if (pick === 'table') $('table-dialog').showModal();
    if (pick === 'symbol') { openPalette(); $('palette-dialog').showModal(); }
    if (pick === 'figure') $('figure-file').click();
    if (pick === 'board') newBoard().catch(fail);
  });
  $('figure-file').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; dropFiles(files, editor.view.state.selection.main.head).catch(fail); });
  $('symbol-filter').addEventListener('input', openPalette);
  $('table-form').addEventListener('submit', event => { event.preventDefault(); insertTable().catch(fail); });
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
  $('keys').value = readKeys();
  $('keys').addEventListener('change', event => {
    editor.setKeys(event.target.value);
    try { localStorage.setItem(KEYS_ITEM, event.target.value); } catch (_) {}
  });
  addEventListener('pagehide', () => { saveNow().catch(() => {}); });
}

const commands = {
  'projects.list':() => listProjects(store),
  'project.open':({ name }) => openProject(name).then(() => ({ opened:name })),
  'project.create':({ name, template }) => createProject(store, name, template, venues).then(openProject).then(() => ({ opened:state.project })),
  'files.list':() => state.files,
  'file.read':({ path }) => state.texts[path] ?? store.read(fullPath(path)),
  async 'file.write'({ path, text }) {
    await writeFile(path, text);
    state.texts[path] = text;
    state.files = await listFiles(store, state.project);
    if (path === state.path) editor.load(text);
    renderTree();
    showCounts();
    return { written:path };
  },
  async 'build.run'() {
    if (!canCompile()) throw new Error('Compiling needs the NakliOS TeX service.');
    const revision = state.revision;
    const result = await compile();
    await afterBuild({ result, stale:revision !== state.revision, revision });
    $('build').hidden = false; $('cancel').hidden = true;
    return { ok:result.ok, problems:state.problems.map(({ severity, file, line, headline, explanation }) => ({ severity, file, line, headline, explanation })) };
  },
  async 'file.rename'({ from, to }) { return { renamed:await renameFile(from, to) }; },
  'search.find':({ query, regex, matchCase }) => findAll(state.texts, query, { regex, matchCase }),
  'search.todos':() => findTodos(state.texts),
  async 'search.replace'({ query, replacement, regex, matchCase }) { return { replaced:await replaceEverywhere(query, replacement, { regex, matchCase }) }; },
  'pdf.locate':({ path, line }) => (syncReady() ? forward(state.sync, path, line) : null),
  'pdf.source':({ page, x, y }) => (syncReady() ? inverse(state.sync, page, x, y, new Set(state.files)) : null),
  'versions.list':() => listVersions(store, projectRoot()),
  'versions.save':({ label }) => keepVersion(label),
  async 'versions.changes'({ id }) { const version = (await listVersions(store, projectRoot())).find(item => item.id === id); return changesPdf(version); },
  'arxiv.pack':() => arxivPack(),
  'overleaf.pull':() => overleafRun('pull'),
  'overleaf.push':() => overleafRun('push'),
  'git.commit':({ message }) => commitProject(message),
  'git.log':() => gitOf().log(),
  'agent.ask':({ question }) => askAgent(question),
  'board.new':() => newBoard().then(path => ({ path })),
  'board.figure':() => (isBoard(state.path) ? boardFigure() : Promise.reject(new Error('Open a board first.'))),
  'papers.fulltext':({ key }) => fetchFullText(key),
  'papers.search':({ query }) => searchPapers(query),
  'project.definition':({ path, key, kind }) => definitionOf({ key, kind }, state.texts) ?? (kind === 'label' ? usesOf(key, state.texts) : null),
  'file.format':() => formatFile().then(() => ({ formatted:state.path })),
  'setup.check':() => checkSetup(),
  'references.discover':({ query }) => discoverPapers(query),
  'review.pdf':() => reviewPdf(),
  'references.add':({ query }) => addPaper(query).then(entry => entry && { key:entry.key }),
  'references.check':() => auditReferences().then(results => results.map(({ key, status, notices, message }) => ({ key, status, notices, message }))),
  'submission.check':() => submissionCheck().then(rows => rows.map(({ title, detail }) => ({ title, detail }))),
  'notes.list':() => review.notes.map(({ id, file, body, intent, color, status, anchor }) => ({ id, file, body, intent, color, status, quote:anchor.quote })),
  async 'notes.add'({ file, quote, body, intent }) {
    const at = state.texts[file]?.indexOf(quote) ?? -1;
    if (at < 0) throw new Error('That text is not in the file.');
    return { id:(await addNote({ file, from:at, to:at + quote.length, body, intent })).id };
  },
  async 'notes.resolve'({ id }) { const note = review.notes.find(item => item.id === id); if (!note) throw new Error('No such note.'); await setNoteStatus(note, 'resolved'); return { resolved:id }; },
  'problems.list':() => state.problems.map(({ severity, file, line, headline, explanation, suggestion }) => ({ severity, file, line, headline, explanation, suggestion })),
};

async function registerCommands() {
  const manifest = await (await fetch('./commands.json')).json();
  naklios?.experimental_commands?.register?.(manifest.commands.map(command => ({ ...command, name:`scribella.${command.name}`, handler:commands[command.name] })));
}

// TeX reads NakliOS storage, so a project must live there to compile. The host's capabilities can arrive after the page
// starts, so the choice is made again whenever they change, while no project is open.
async function chooseStore() {
  const kind = hosted() ? 'host' : 'browser';
  if (kind === storeKind || state.project) return;
  storeKind = kind;
  store = kind === 'host' ? hostStore(naklios.fs) : browserStore();
  await renderHome();
}

async function start() {
  bindPage();
  window.scribella = { commands, state, editor };
  naklios?.ready?.();
  await chooseStore();
  naklios?.onCapabilitiesChange?.(() => { chooseStore().catch(fail); });
  await registerCommands().catch(error => console.error('Commands failed to register', error));
}

// Inside NakliOS the capabilities arrive after load, so the first read waits for them briefly.
const hostedFrame = window.parent !== window;
let started = false;
const go = () => { if (!started) { started = true; start().catch(fail); } };
if (hostedFrame && naklios?.onCapabilitiesChange) {
  naklios.onCapabilitiesChange(() => { if (naklios.capabilities.hosted) go(); });
  setTimeout(go, 1500);
} else go();
