// Wiring for the target-review page: load a structure from disk or by PDB ID, show it, and
// print a plain summary of what came in.

import * as status from './status.js';
import * as viewer from './viewer.js';
import * as design from './design.js';
import * as searchApi from './search.js';
import * as tour from './tour.js';
import { summarise, extractBackbone } from './structure.js';
import { DesignTable, allColumns } from './table.js';
import { createRegistry } from './commands.js';
import * as bridge from './bridge.js';
import { withInterfaceScore } from './score.js';

const $ = (id) => document.getElementById(id);

status.installGlobalErrorSurface();

const ui = {
  file: $('file'),
  drop: $('drop'),
  find: $('find'),
  findGo: $('find-go'),
  results: $('results'),
  starters: $('starters'),
  tourOpen: $('tour-open'),
  clear: $('clear'),
  empty: $('viewer-empty'),
  summaryWrap: $('summary-wrap'),
  summary: $('summary'),
  chains: $('chains'),
  chainsNote: $('chains-note'),
  version: $('viewer-version'),
  designWrap: $('design-wrap'),
  designChain: $('design-chain'),
  designTemp: $('design-temp'),
  designCount: $('design-count'),
  designSeed: $('design-seed'),
  designRun: $('design-run'),
  designNote: $('design-note'),
  hostNote: $('host-note'),
  models: $('models'),
  designRanking: $('design-ranking'),
  designResults: $('design-results'),
};

// Every design of this target, whichever checkpoint wrote it, in one orderable table. Its columns
// are declared in table.js so a score computed later becomes a column rather than an edit here.
const ranking = new DesignTable(ui.designRanking);
ranking.onSelect = (row) => {
  const card = document.getElementById(row.cardId);
  if (!card) return;
  for (const picked of ui.designRanking.querySelectorAll('tr.picked')) picked.classList.remove('picked');
  for (const lit of ui.designResults.querySelectorAll('.design.picked')) lit.classList.remove('picked');
  card.classList.add('picked');
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

// Backbones handed to each checkpoint, keyed by checkpoint id. Each model encodes the structure
// itself, so a prepared protein belongs to the model that prepared it. Cleared whenever the target
// changes, so a run can never use the previous structure's coordinates.
let prepared = new Map();

/** The summary of the structure on screen, so the agent face can read it back. */
let lastSummary = null;

// The NakliOS host window, when the page is running inside it. The SDK is inlined in index.html and
// does nothing when the page is standalone, but it is guarded anyway: a failed splice must not stop
// the app from working on its own site.
const host = {
  ready() { try { window.naklios?.ready(); } catch { /* standalone, or no SDK */ } },
  title(text) { try { window.naklios?.title(text); } catch { /* standalone, or no SDK */ } },
};

async function boot() {
  status.busy('Starting the viewer…');
  await viewer.create($('viewer-host'));
  ui.version.textContent = 'Mol* ' + viewer.version();
  status.clear();
  window.addEventListener('resize', () => viewer.handleResize());
  // The viewer is up and the page can be used, which is what the host waits for.
  host.ready();
  host.title('Protavia');

  // First visit only. Deferred a moment so the panel is painted and the spotlight has something
  // real to sit on; the tour drops any step whose target is not on screen.
  if (tour.unseen()) setTimeout(() => tour.show(), 600);
}

/** Read a File, decompressing it first when it is gzipped. */
async function readFile(file) {
  const { format, binary, gzipped } = viewer.detectFormat(file.name);

  let buffer = await file.arrayBuffer();

  if (gzipped) {
    if (typeof DecompressionStream !== 'function') {
      throw new Error('This browser cannot decompress .gz files. Unzip it and try again.');
    }
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    buffer = await new Response(stream).arrayBuffer();
  }

  const data = binary ? new Uint8Array(buffer) : new TextDecoder().decode(buffer);
  return { data, format };
}

async function loadFile(file) {
  status.clear();
  status.busy(`Reading ${file.name}…`);
  try {
    const { data, format } = await readFile(file);
    await viewer.clear();
    await viewer.loadData(data, format, file.name);
    afterLoad(file.name);
  } catch (e) {
    status.fail(`Could not load ${file.name}.`, e.message);
  }
}

async function loadPdbId(raw) {
  const id = raw.trim().toLowerCase();
  if (!/^[0-9a-z]{4}$/.test(id)) {
    status.fail('A PDB ID is four characters, like 1ubq.', `Got "${raw.trim()}".`);
    return;
  }
  status.clear();
  status.busy(`Fetching ${id.toUpperCase()} from rcsb.org…`);
  try {
    await viewer.clear();
    await viewer.loadPdbId(id);
    afterLoad(id.toUpperCase() + ' (rcsb.org)');
  } catch (e) {
    status.fail(`Could not fetch ${id.toUpperCase()}.`, e.message);
  }
}

function afterLoad(label) {
  ui.empty.hidden = true;
  ui.clear.disabled = false;
  host.title(`Protavia \u2014 ${label}`);
  // The previous target's panel must not survive into a new one, whatever happens below.
  ui.designWrap.hidden = true;
  prepared.clear();

  // The structure is on screen at this point. A summary that cannot be read is worth a warning,
  // never a failure: showing the target is the job, the table beside it is a convenience.
  let summary = null;
  try {
    const structure = viewer.loadedStructure();
    if (structure) summary = summarise(structure);
  } catch (e) {
    status.warn(`Loaded ${label}, but could not summarise it.`, e.message);
    ui.summaryWrap.hidden = true;
    return;
  }

  if (!summary) {
    status.warn(`Loaded ${label}, but found no structure to summarise.`);
    ui.summaryWrap.hidden = true;
    return;
  }

  lastSummary = summary;
  renderSummary(summary);
  enableDesign(summary);
  const chainWord = summary.chains.length === 1 ? 'chain' : 'chains';
  status.info(`Loaded ${label} — ${summary.chains.length} polymer ${chainWord}, ${summary.totalAtoms.toLocaleString()} atoms.`);
}

function renderSummary(s) {
  const rows = [
    ['Entry', s.entryId || '—'],
    ['Models', String(s.modelCount)],
    ['Atoms', s.totalAtoms.toLocaleString()],
    ['Waters', s.waters.toLocaleString()],
    ['Other residues', s.ligands.toLocaleString()],
  ];

  ui.summary.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    ui.summary.append(dt, dd);
  }

  ui.chains.replaceChildren();
  for (const c of s.chains) {
    const tr = document.createElement('tr');

    const id = document.createElement('td');
    id.textContent = c.id + (c.kind === 'nucleic' ? ' · na' : '');

    const n = document.createElement('td');
    n.textContent = String(c.residues);

    const range = document.createElement('td');
    range.textContent = c.first === null ? '—' : `${c.first}–${c.last}`;

    tr.append(id, n, range);

    const seqRow = document.createElement('tr');
    const seqCell = document.createElement('td');
    seqCell.colSpan = 3;
    seqCell.className = 'seq';
    seqCell.textContent = c.sequence;
    seqRow.append(seqCell);

    ui.chains.append(tr, seqRow);
  }

  ui.chainsNote.textContent = s.modelCount > 1
    ? `Chains are from model 1 of ${s.modelCount}.`
    : '';
  ui.summaryWrap.hidden = false;
}

// --- Finding a target -------------------------------------------------------------------------

/** A four-character code opens directly; anything else is a search. */
async function findTarget(raw) {
  const text = raw.trim();
  if (text.length === 0) return;

  if (searchApi.looksLikeEntryId(text)) {
    ui.results.replaceChildren();
    await loadPdbId(text);
    return;
  }

  ui.findGo.disabled = true;
  status.clear();
  status.busy(`Searching rcsb.org for "${text}"…`);
  try {
    const found = await searchApi.searchTargets(text);
    renderResults(found, text);
  } catch (e) {
    status.fail('The search failed.', e.message);
  } finally {
    ui.findGo.disabled = false;
  }
}

function renderResults(found, text) {
  ui.results.replaceChildren();

  if (found.length === 0) {
    status.warn(`Nothing in the archive matches "${text}".`);
    return;
  }

  for (const entry of found) {
    const button = document.createElement('button');
    button.className = 'result';
    button.type = 'button';

    const id = document.createElement('span');
    id.className = 'result-id';
    const parts = [entry.id];
    if (entry.chains !== null) parts.push(`${entry.chains} chain${entry.chains === 1 ? '' : 's'}`);
    if (entry.residues !== null) parts.push(`${entry.residues.toLocaleString()} residues`);
    id.textContent = parts.join(' · ');

    const title = document.createElement('span');
    title.className = 'result-title';
    // Archive titles are shouted in capitals; sentence case is easier to read down a list.
    title.textContent = entry.title
      ? entry.title.charAt(0) + entry.title.slice(1).toLowerCase()
      : 'No title recorded.';

    button.append(id, title);
    button.addEventListener('click', () => {
      ui.results.replaceChildren();
      dispatch('open-target', { id: entry.id });
    });
    ui.results.append(button);
  }

  status.info(`${found.length} result${found.length === 1 ? '' : 's'} for "${text}". Pick one to open it.`);
}

// --- Redesign ---------------------------------------------------------------------------------

function enableDesign(summary) {
  prepared.clear();
  ui.designResults.replaceChildren();

  const protein = summary.chains.filter((c) => c.kind === 'protein');
  if (protein.length === 0) {
    ui.designWrap.hidden = true;
    return;
  }

  ui.designChain.replaceChildren();
  for (const c of protein) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.id} (${c.residues})`;
    ui.designChain.append(opt);
  }

  renderModelChoices();
  ui.designNote.textContent =
    'Everything runs in this browser. Each checkpoint is about 9 MB and loads the first time it '
    + 'is used.';
  ui.designRun.disabled = false;
  ui.designWrap.hidden = false;
}

/** One checkbox per checkpoint, with a line saying what makes it different. */
function renderModelChoices() {
  if (ui.models.children.length > 0) return; // built once; the choice survives a new target
  for (const m of design.MODELS) {
    const row = document.createElement('label');
    row.className = 'model';

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = m.id;
    box.checked = m.id === design.MODELS[0].id;

    const text = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'model-name';
    name.textContent = m.label;
    const note = document.createElement('span');
    note.className = 'model-note';
    note.textContent = m.note;
    text.append(name, note);

    row.append(box, text);
    ui.models.append(row);
  }
}

function chosenModels() {
  return [...ui.models.querySelectorAll('input:checked')].map((b) => b.value);
}

/**
 * Run a redesign. Called with nothing it reads the panel, which is what the button does; called
 * with values it sets the panel first, so what ran is visible on screen afterwards rather than
 * hidden in a call an agent made.
 */
async function runRedesign(over = {}) {
  if (over.chain !== undefined) setChain(over.chain);
  if (over.checkpoints !== undefined) setCheckpoints(over.checkpoints);
  if (over.temperature !== undefined) ui.designTemp.value = String(over.temperature);
  if (over.count !== undefined) ui.designCount.value = String(over.count);
  if (over.seed !== undefined) ui.designSeed.value = String(over.seed);

  const chain = ui.designChain.value;
  const temperature = Number(ui.designTemp.value);
  const count = Number(ui.designCount.value);
  const seed = Number(ui.designSeed.value);
  const ids = chosenModels();

  if (!(temperature > 0)) {
    status.fail('Temperature has to be greater than zero.');
    return [];
  }
  if (ids.length === 0) {
    status.fail('Pick at least one checkpoint to run.');
    return [];
  }

  ui.designRun.disabled = true;
  ui.designResults.replaceChildren();
  ranking.clear();
  status.clear();

  const residues = extractBackbone(viewer.loadedStructure());
  const native = [];
  let ran = 0;

  try {
    // Each checkpoint in turn, rendering as it finishes, so the first answer is readable while the
    // rest are still running. Same chain, temperature and seed throughout, so the only thing that
    // differs between the groups is the model.
    for (const id of ids) {
      const spec = design.modelById(id);
      await design.loadModel(id, { onProgress: status.busy });

      if (!prepared.has(id)) {
        status.busy(`Reading the backbone for ${spec.label}\u2026`);
        prepared.set(id, await design.prepare(residues, id));
      }
      const protein = prepared.get(id);

      status.busy(`Designing chain ${chain} with ${spec.label} on ${design.activeBackend()}\u2026`);
      const started = performance.now();
      const results = await design.redesign(protein, { chains: [chain], temperature, count, seed });
      const seconds = (performance.now() - started) / 1000;

      if (native.length === 0) native.push(design.nativeChainSequence(protein, chain));
      renderGroup(spec, results, native[0], seconds, ids.length > 1);
      ran++;
    }

    const what = ids.length === 1
      ? design.modelById(ids[0]).label
      : `${ids.length} checkpoints`;
    status.info(`Chain ${chain}, ${count} sequence${count === 1 ? '' : 's'} each, ${what}, `
      + `on ${design.activeBackend()}.`);
  } catch (e) {
    status.fail(ran === 0 ? 'The redesign failed.' : `Stopped after ${ran} of ${ids.length} checkpoints.`,
      e.message);
  } finally {
    ui.designRun.disabled = false;
  }
  return ranking.ordered();
}

/** Point the panel at one chain, and say so if that chain is not on offer. */
function setChain(chain) {
  const wanted = String(chain);
  const found = [...ui.designChain.options].some((o) => o.value === wanted);
  if (!found) {
    const have = [...ui.designChain.options].map((o) => o.value).join(', ') || 'none';
    throw new Error(`This target has no chain "${wanted}". Chains: ${have}.`);
  }
  ui.designChain.value = wanted;
  return wanted;
}

/** Tick exactly the given checkpoints. */
function setCheckpoints(ids) {
  const wanted = (Array.isArray(ids) ? ids : [ids]).map(String);
  const known = design.MODELS.map((m) => m.id);
  const unknown = wanted.filter((id) => !known.includes(id));
  if (unknown.length) {
    throw new Error(`No checkpoint called ${unknown.join(', ')}. Known: ${known.join(', ')}.`);
  }
  if (wanted.length === 0) throw new Error('Pick at least one checkpoint.');
  for (const box of ui.models.querySelectorAll('input')) box.checked = wanted.includes(box.value);
  return wanted;
}

// --- The agent face ---------------------------------------------------------------------------

// Bound once, at load, so a command declared without an implementation stops the page here rather
// than on the call that needed it. See app/commands.js for why there is a manifest at all.
const registry = createRegistry({
  'open-target': ({ id }) => loadPdbId(id),
  'search': ({ text }) => findTarget(text),
  'clear-target': () => clearTarget(),
  'set-chain': ({ chain }) => setChain(chain),
  'set-checkpoints': ({ ids }) => setCheckpoints(ids),
  'list-checkpoints': () => design.MODELS.map((m) => ({ id: m.id, label: m.label, about: m.note })),
  'redesign': (args) => runRedesign(args),
  'rank': ({ column, descending }) => {
    ranking.sortBy(column, descending);
    return ranking.visible().map(asPlainDesign);
  },
  'filter': ({ column, value }) => ranking.setFilter(column, value ?? null).map(asPlainDesign),
  'clear-filters': () => ranking.clearFilters().map(asPlainDesign),
  'list-columns': () => allColumns().map((c) => ({
    id: c.id,
    label: c.label,
    explain: c.explain,
    rankable: c.rankable !== false,
    ...(c.rankable === false ? { whyNotRankable: c.whyNotRankable } : {}),
  })),
  'designs': () => ranking.visible().map(asPlainDesign),
  'target': () => lastSummary,
  'show-tour': () => { tour.show({ force: true }); return true; },
  'host': () => bridge.detect(),
  'load-run': ({ runId }) => loadRunDesigns(runId),
});

/**
 * Put a compute run's designs into the same table as the browser's own.
 *
 * A design from a run carries an interface score the engine computed, and sometimes the predicted
 * aligned error matrix behind it. Either way it goes through `withInterfaceScore`, which decides
 * where the number comes from and registers the ipSAE column the first time one exists.
 */
async function loadRunDesigns(runId) {
  const response = await fetch(`/bridge/runs/${encodeURIComponent(runId)}`);
  if (!response.ok) throw new Error(`The bridge has no run ${runId}.`);
  const run = await response.json();

  const added = (run.designs || []).map((design) => {
    const metrics = design.metrics || {};
    return ranking.add(withInterfaceScore({
      chainSequence: design.sequence,
      sequence: design.sequence,
      score: metrics.i_pTM ?? null,
      recovery: null,
      ipsae: metrics.ipSAE ?? null,
      pae: design.pae,
      chainIds: design.chainIds,
      checkpointId: run.engine,
      checkpointLabel: run.engine,
      checkpointShort: run.engine,
      cardId: null,
      runId: run.runId,
      structure: design.structure,
    }));
  });

  status.info(added.length
    ? `${added.length} design${added.length === 1 ? '' : 's'} from ${run.engine} on ${run.host}.`
    : `Run ${runId} is ${run.state} and has accepted nothing yet.`);
  return added.map(asPlainDesign);
}

/** A table row without the page's own bookkeeping, so what comes back is the design and nothing else. */
function asPlainDesign(row) {
  const out = { checkpoint: row.checkpointId, sequence: row.chainSequence, score: row.score };
  for (const c of allColumns()) out[c.id] = c.value(row);
  return out;
}

window.protavia = {
  commands: () => registry.commands(),
  run: (id, args) => registry.run(id, args),
};

/** One checkpoint's results, under a heading naming it, so a comparison reads as a comparison. */
function renderGroup(spec, results, nativeSequence, seconds, showHeading) {
  if (showHeading) {
    const head = document.createElement('div');
    head.className = 'group-head';

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = spec.label;

    const best = results.reduce((a, b) =>
      (b.recovery?.fraction ?? -1) > (a.recovery?.fraction ?? -1) ? b : a, results[0]);
    const summary = document.createElement('span');
    summary.className = 'group-summary';
    summary.textContent = best?.recovery
      ? `best ${(best.recovery.fraction * 100).toFixed(1)}% \u00b7 ${seconds.toFixed(1)} s`
      : `${seconds.toFixed(1)} s`;

    head.append(name, summary);
    ui.designResults.append(head);
  }
  renderDesigns(spec, results, nativeSequence);
}

let cardCount = 0;

function renderDesigns(spec, results, nativeSequence) {
  for (const r of results) {
    const box = document.createElement('div');
    box.className = 'design';
    box.id = `design-${++cardCount}`;

    const head = document.createElement('div');
    head.className = 'head';

    const rec = document.createElement('span');
    rec.className = 'rec';
    rec.textContent = r.recovery
      ? `${(r.recovery.fraction * 100).toFixed(1)}% native`
      : 'recovery n/a';

    const detail = document.createElement('span');
    detail.textContent = r.recovery ? `${r.recovery.matched}/${r.recovery.counted}` : '';

    const score = document.createElement('span');
    score.textContent = r.score === null || r.score === undefined
      ? '' : `score ${r.score.toFixed(3)}`;

    head.append(rec, detail, score);

    // Marking the positions that differ from the native sequence makes the recovery figure
    // something the reader can check rather than take on trust.
    const seq = document.createElement('div');
    seq.className = 'seq';
    const designedChain = r.chainSequence;
    for (let i = 0; i < designedChain.length; i++) {
      const span = document.createElement('span');
      span.className = designedChain[i] === nativeSequence[i] ? 'hit' : 'miss';
      span.textContent = designedChain[i];
      seq.append(span);
    }

    box.append(head, seq);
    ui.designResults.append(box);

    // The same design, as a row the table can order. `cardId` is how a row points back here.
    ranking.add({
      ...r,
      checkpointId: spec.id,
      checkpointLabel: spec.label,
      checkpointShort: spec.short,
      cardId: box.id,
    });
  }
}

async function clearTarget() {
  await viewer.clear();
  ui.empty.hidden = false;
  ui.clear.disabled = true;
  ui.summaryWrap.hidden = true;
  ui.designWrap.hidden = true;
  ui.designResults.replaceChildren();
  ranking.clear();
  prepared.clear();
  lastSummary = null;
  ui.file.value = '';
  host.title('Protavia');
  status.clear();
}

// Controls.
ui.file.addEventListener('change', () => {
  const file = ui.file.files && ui.file.files[0];
  if (file) loadFile(file);
});

// Every control below goes through the registry rather than calling its function, so the buttons
// and the agent face are the same door. A failed command is a status line, never a thrown error
// into an event handler.
const dispatch = (id, args) => registry.run(id, args).catch((e) => status.fail(e.message));

ui.findGo.addEventListener('click', () => dispatch('search', { text: ui.find.value }));
ui.find.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dispatch('search', { text: ui.find.value });
});
ui.tourOpen.addEventListener('click', () => dispatch('show-tour'));

for (const button of ui.starters.querySelectorAll('.starter')) {
  button.addEventListener('click', () => dispatch('open-target', { id: button.dataset.id }));
}
ui.clear.addEventListener('click', () => dispatch('clear-target'));
ui.designRun.addEventListener('click', () => dispatch('redesign'));

// Drag and drop onto the panel.
for (const type of ['dragenter', 'dragover']) {
  ui.drop.addEventListener(type, (e) => { e.preventDefault(); ui.drop.classList.add('over'); });
}
for (const type of ['dragleave', 'dragend']) {
  ui.drop.addEventListener(type, () => ui.drop.classList.remove('over'));
}
ui.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  ui.drop.classList.remove('over');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) loadFile(file);
});

/**
 * Say which machine a design run would happen on, or that there is none. Shown once at boot and
 * never behind a click: the exemption Protavia relies on turns on whose machine the engine is,
 * so the reader should never have to ask.
 */
async function showHost() {
  const found = await bridge.detect();
  ui.hostNote.replaceChildren();

  if (!found.present) {
    ui.hostNote.textContent = found.why;
    ui.hostNote.hidden = false;
    return;
  }

  const where = document.createElement('b');
  where.textContent = bridge.hostLine(found);
  ui.hostNote.append('Compute host: ', where);

  const usable = bridge.usableEngines(found);
  const ready = usable.filter((e) => e.installed);
  const line = document.createElement('span');
  line.textContent = ready.length
    ? ` \u00b7 ${ready.map((e) => e.label).join(', ')} ready.`
    : ` \u00b7 no design engine installed. ${usable.map((e) => e.why).join(' ')}`;
  ui.hostNote.append(line);
  ui.hostNote.hidden = false;
}

// The page is useless without the viewer, so a boot failure is a hard failure.
boot().catch((e) => status.fail('The viewer did not start.', e.message));

// The bridge is a separate question from the viewer, so it never blocks the page.
showHost().catch(() => {});
