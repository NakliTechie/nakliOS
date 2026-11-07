// Scribella's page: wires storage, the editor, builds and the PDF pane. Writing works everywhere; compiling needs the
// NakliOS TeX service, because the engine lives there.
import { browserStore, hostStore } from './storage.js';
import { TEMPLATES, createProject, findMain, isText, listFiles, listProjects, projectFolder, readSettings, writeSettings } from './project.js';
import { createBuilder } from './build.js';
import { createEditor } from './editor.js';
import { createPdfView } from './pdf-view.js';
import { explain, visibleDiagnostics } from './explain.js';
import { bibKeys, collectKeys } from './lint.js';
import { buildOutline, wordCount } from './outline.js';

const AUTOSAVE_MS = 1200;
const $ = id => document.getElementById(id);
const naklios = window.naklios;
const hosted = () => !!(naklios?.capabilities?.hosted && naklios.capabilities.fs);
const canCompile = () => storeKind === 'host' && naklios.capabilities.experimental_tex === true;
const COMPILE_HINT = () => (naklios?.capabilities?.hosted
  ? 'Writing works here. To compile, connect a Folder or Crate in NakliOS Settings.'
  : 'Writing works here. To compile, open Scribella inside NakliOS, where the TeX engine runs.');

let store = null, storeKind = null;
const state = { project:null, settings:{}, files:[], texts:{}, path:null, dirty:false, revision:0, problems:[], log:'', job:null, auto:true };
let saveTimer = null;

const say = (text, bad = false) => { $('status').textContent = text; $('status').classList.toggle('bad', bad); };
const pdf = createPdfView($('pdf'), { onPages:pages => { $('pages').textContent = `${pages} ${pages === 1 ? 'page' : 'pages'}`; } });

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
  onSave:() => saveNow().then(() => state.project && build()),
  onChange() {
    state.dirty = true;
    state.texts[state.path] = editor.text;
    state.revision += 1;
    showCounts();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNow().then(() => { if (state.auto) build(); }), AUTOSAVE_MS);
  },
});

const fullPath = path => `${projectFolder(state.project)}/${path}`;

async function saveNow() {
  clearTimeout(saveTimer);
  if (!state.dirty || !state.path) return;
  state.dirty = false;
  try {
    await store.write(fullPath(state.path), state.texts[state.path]);
  } catch (error) {
    state.dirty = true;
    say(`Saving failed: ${error.message}`, true);
    throw error;
  }
}

function showCounts() {
  const main = state.texts[state.settings.main];
  $('words').textContent = main ? `About ${wordCount(main).toLocaleString('en')} words` : '';
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
  try { return await state.job; } finally { state.job = null; }
}

async function afterBuild({ result, stale }) {
  const log = result.log ? await store.read(result.log).catch(() => '') : '';
  state.log = log;
  state.problems = visibleDiagnostics(result.diagnostics).map(item => ({ ...item, ...explain(item, { log, source:state.texts[item.file] || '' }) }));
  renderProblems();
  if (result.pdf && result.ok) await pdf.show(await store.readBinary(result.pdf));
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

async function openFile(path) {
  await saveNow();
  state.path = path;
  $('file-name').textContent = path;
  const text = isText(path);
  $('editor').hidden = !text;
  $('not-text').hidden = text;
  if (text) {
    state.texts[path] ??= await store.read(fullPath(path));
    editor.load(state.texts[path]);
  }
  renderTree();
}

async function openProject(name) {
  await saveNow();
  pdf.clear();
  $('pages').textContent = '';
  state.project = name;
  state.settings = await readSettings(store, name);
  state.files = await listFiles(store, name);
  state.texts = {};
  for (const path of state.files.filter(isText)) state.texts[path] = await store.read(fullPath(path));
  state.settings.main = state.files.includes(state.settings.main) ? state.settings.main : findMain(state.files, state.texts);
  state.problems = [];
  renderProblems();
  document.body.dataset.view = 'project';
  $('project-name').textContent = name;
  naklios?.title?.(`${name} — Scribella`);
  document.title = `${name} — Scribella`;
  await openFile(state.settings.main || state.files[0]);
  showCounts();
  const last = state.settings.main && `${projectFolder(name)}/.tex-build/${state.settings.main.replace(/^.*\//, '').replace(/\.[^.]+$/, '')}.pdf`;
  if (last && await store.exists(last)) await pdf.show(await store.readBinary(last));
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
  const path = $('new-file-name').value.trim().replace(/^\/+/, '');
  if (!path) return;
  if (path.split('/').some(part => part === '..' || part.startsWith('.'))) throw new Error('A file name cannot start with a dot or contain "..".');
  if (state.files.includes(path)) throw new Error(`${path} already exists.`);
  await store.write(fullPath(path), '');
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

function bindPage() {
  for (const [id, template] of Object.entries(TEMPLATES)) $('template').append(new Option(template.label, id));
  $('new-project').addEventListener('submit', event => {
    event.preventDefault();
    createProject(store, $('project-title').value, $('template').value).then(openProject).catch(fail);
  });
  $('home').addEventListener('click', () => saveNow().then(() => { state.project = null; state.path = null; return chooseStore(); }).then(renderHome).catch(fail));
  $('build').addEventListener('click', () => saveNow().then(build).catch(fail));
  $('cancel').addEventListener('click', () => { if (state.job) naklios.experimental_tex.cancel(state.job.id); });
  $('auto').addEventListener('change', event => { state.auto = event.target.checked; });
  $('engine').addEventListener('change', event => changeSettings({ engine:event.target.value }).catch(fail));
  $('main-file').addEventListener('change', event => changeSettings({ main:event.target.value }).catch(fail));
  $('zoom-in').addEventListener('click', () => pdf.zoomBy(0.2));
  $('zoom-out').addEventListener('click', () => pdf.zoomBy(-0.2));
  $('add-file').addEventListener('click', () => { $('new-file-form').hidden = false; $('new-file-name').focus(); });
  $('new-file-form').addEventListener('submit', event => { event.preventDefault(); newFile().catch(fail); });
  $('delete-file').addEventListener('click', () => deleteFile().catch(fail));
  addEventListener('pagehide', () => { saveNow().catch(() => {}); });
}

const commands = {
  'projects.list':() => listProjects(store),
  'project.open':({ name }) => openProject(name).then(() => ({ opened:name })),
  'project.create':({ name, template }) => createProject(store, name, template).then(openProject).then(() => ({ opened:state.project })),
  'files.list':() => state.files,
  'file.read':({ path }) => state.texts[path] ?? store.read(fullPath(path)),
  async 'file.write'({ path, text }) {
    await store.write(fullPath(path), text);
    state.texts[path] = text;
    state.files = await listFiles(store, state.project);
    if (path === state.path) editor.load(text);
    renderTree();
    showCounts();
    return { written:path };
  },
  async 'build.run'() {
    if (!canCompile()) throw new Error('Compiling needs the NakliOS TeX service.');
    const result = await compile();
    await afterBuild({ result, stale:false });
    $('build').hidden = false; $('cancel').hidden = true;
    return { ok:result.ok, problems:state.problems.map(({ severity, file, line, headline, explanation }) => ({ severity, file, line, headline, explanation })) };
  },
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
  window.scribella = { commands, state };
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
