// Wiring for the target-review page: load a structure from disk or by PDB ID, show it, and
// print a plain summary of what came in.

import * as status from './status.js';
import * as viewer from './viewer.js';
import * as design from './design.js';
import * as searchApi from './search.js';
import * as tour from './tour.js';
import { summarise, extractBackbone } from './structure.js';

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
  designResults: $('design-results'),
};

// The backbone currently handed to ProteinMPNN. Cleared whenever the target changes, so a redesign
// can never be run against the previous structure's coordinates.
let prepared = null;

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
  prepared = null;

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
      loadPdbId(entry.id);
    });
    ui.results.append(button);
  }

  status.info(`${found.length} result${found.length === 1 ? '' : 's'} for "${text}". Pick one to open it.`);
}

// --- Redesign ---------------------------------------------------------------------------------

function enableDesign(summary) {
  prepared = null;
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

  ui.designNote.textContent =
    `${design.MODEL_NAME} runs in this browser. About 9 MB of weights load on first use.`;
  ui.designRun.disabled = false;
  ui.designWrap.hidden = false;
}

async function runRedesign() {
  const chain = ui.designChain.value;
  const temperature = Number(ui.designTemp.value);
  const count = Number(ui.designCount.value);
  const seed = Number(ui.designSeed.value);

  if (!(temperature > 0)) {
    status.fail('Temperature has to be greater than zero.');
    return;
  }

  ui.designRun.disabled = true;
  status.clear();

  try {
    await design.loadModel({ onProgress: status.busy });

    if (!prepared) {
      status.busy('Reading the backbone…');
      const residues = extractBackbone(viewer.loadedStructure());
      prepared = await design.prepare(residues);
    }

    status.busy(`Designing chain ${chain} on ${design.activeBackend()}…`);
    const started = performance.now();
    const results = await design.redesign(prepared, { chains: [chain], temperature, count, seed });
    const seconds = (performance.now() - started) / 1000;

    renderDesigns(results, design.nativeChainSequence(prepared, chain));
    status.info(
      `${results.length} sequence${results.length === 1 ? '' : 's'} for chain ${chain} ` +
      `in ${seconds.toFixed(1)} s on ${design.activeBackend()}.`
    );
  } catch (e) {
    status.fail('The redesign failed.', e.message);
  } finally {
    ui.designRun.disabled = false;
  }
}

function renderDesigns(results, nativeSequence) {
  ui.designResults.replaceChildren();

  for (const r of results) {
    const box = document.createElement('div');
    box.className = 'design';

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
  }
}

async function clearTarget() {
  await viewer.clear();
  ui.empty.hidden = false;
  ui.clear.disabled = true;
  ui.summaryWrap.hidden = true;
  ui.designWrap.hidden = true;
  ui.designResults.replaceChildren();
  prepared = null;
  ui.file.value = '';
  host.title('Protavia');
  status.clear();
}

// Controls.
ui.file.addEventListener('change', () => {
  const file = ui.file.files && ui.file.files[0];
  if (file) loadFile(file);
});

ui.findGo.addEventListener('click', () => findTarget(ui.find.value));
ui.find.addEventListener('keydown', (e) => { if (e.key === 'Enter') findTarget(ui.find.value); });
ui.tourOpen.addEventListener('click', () => tour.show({ force: true }));

for (const button of ui.starters.querySelectorAll('.starter')) {
  button.addEventListener('click', () => loadPdbId(button.dataset.id));
}
ui.clear.addEventListener('click', () => clearTarget());
ui.designRun.addEventListener('click', () => runRedesign());

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

// The page is useless without the viewer, so a boot failure is a hard failure.
boot().catch((e) => status.fail('The viewer did not start.', e.message));
