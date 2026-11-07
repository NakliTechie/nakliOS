// naklios.tex: one queue of compiles for every app. The service reads the project through the caller's own store, so
// no file bytes cross the rail, and the caller's storage scope decides which folders it can compile.
import { mapSynctex, parseTexLog } from './log.mjs';
export { TEX_VERSION } from './version.mjs';

export const TEX_ENGINES = Object.freeze({ pdflatex:'pdftex_bibtex8', xelatex:'xetex_bibtex8_dvipdfmx', lualatex:'luahbtex_bibtex8' });
export const TEX_PACKS = Object.freeze(['texlive-basic', 'texlive-recommended', 'texlive-extra']);
export const TEX_BUILD_DIR = '.tex-build';
const MAX_FILES = 5000;
const MAX_BYTES = 256 * 1024 * 1024;

function fail(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }

function cleanPath(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw fail('EINVAL', `${label} must be a string`);
  const segs = value.split('/').filter(seg => seg && seg !== '.');
  if (segs.includes('..')) throw fail('EINVAL', `${label} may not contain ..`);
  if (!segs.length && !allowEmpty) throw fail('EINVAL', `${label} is required`);
  return segs.join('/');
}

export function compileRequest({ folder = '', main, engine = 'pdflatex' } = {}) {
  const request = { folder:cleanPath(folder, 'folder', { allowEmpty:true }), main:cleanPath(main, 'main'), engine };
  if (!/\.(tex|ltx)$/i.test(request.main)) throw fail('EINVAL', 'main must be a .tex file');
  if (!Object.hasOwn(TEX_ENGINES, engine)) throw fail('EINVAL', `engine must be one of ${Object.keys(TEX_ENGINES).join(', ')}`);
  return request;
}

async function readProject(store, folder, check) {
  const pending = [folder], seen = new Set(), files = [];
  let bytes = 0;
  while (pending.length) {
    for (const entry of await store.list(pending.pop())) {
      const path = entry.replace(/\/$/, '');
      const relative = folder ? path.slice(folder.length + 1) : path;
      if (seen.has(path) || !relative || relative.split('/').some(seg => seg.startsWith('.'))) continue;
      seen.add(path);
      if (entry.endsWith('/')) { pending.push(path); continue; }
      check();
      const content = new Uint8Array(await store.readBinary(path));
      bytes += content.byteLength;
      files.push({ path:relative, content });
      if (files.length > MAX_FILES || bytes > MAX_BYTES) throw fail('EFBIG', `the project is over ${MAX_FILES} files or ${MAX_BYTES / 1024 / 1024} MB`);
    }
  }
  return files;
}

// `engine` runs TeX, `confirmDownload` asks the person once before the first download, `record` writes the op log.
export function createTexService({ engine, confirmDownload, record = async () => {}, now = Date.now }) {
  const queue = [];
  let running = null, clearing = null;

  // A failed or stuck History write never fails or holds up the compile it records.
  const log = (job, output) => Promise.resolve().then(() => record(job, output)).catch(error => console.error('[naklios] TeX History append failed', error));

  function cancelJob(job, code = 'ECANCELED', message = 'the compile was cancelled') {
    job.cancelled = fail(code, message);
    const waiting = queue.indexOf(job);
    if (waiting >= 0) { queue.splice(waiting, 1); job.reject(job.cancelled); }
    else job.abort?.(job.cancelled);
  }

  // A cancel must end the wait even though the engine never answers once stopped.
  function untilCancelled(job, work) {
    return new Promise((resolve, reject) => {
      job.abort = reject;
      work.then(resolve, reject);
    }).finally(() => { job.abort = null; });
  }

  async function run(job) {
    const { request, emit } = job;
    const check = () => { if (job.cancelled) throw job.cancelled; };
    const stage = (name, extra = {}) => emit({ kind:'progress', stage:name, ...extra });
    if (!await engine.isReady()) {
      if (!await untilCancelled(job, confirmDownload(job.caller))) throw fail('EPERM', 'the person did not allow the TeX download');
      check();
      stage('download', { percent:0 });
      job.engineBusy = true;
      let shown = 0; // the engine reports every network read, so the rail carries one message per percent
      await untilCancelled(job, engine.start(progress => { if (progress.percent !== shown) { shown = progress.percent; stage('download', progress); } }));
      job.engineBusy = false;
    }
    check();
    stage('reading');
    const store = await untilCancelled(job, job.openStore());
    check();
    const files = await untilCancelled(job, readProject(store, request.folder, check));
    if (!files.some(file => file.path === request.main)) throw fail('ENOENT', `${request.main} is not in the project`);
    stage('compiling');
    job.engineBusy = true;
    const result = await untilCancelled(job, engine.compile({ files, main:request.main, driver:TEX_ENGINES[request.engine] }));
    job.engineBusy = false;
    check();
    stage('writing');
    const stem = request.main.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    const output = name => [request.folder, TEX_BUILD_DIR, name].filter(Boolean).join('/');
    const diagnostics = parseTexLog(result.log, request.main);
    for (const diagnostic of diagnostics) emit({ kind:'diagnostic', ...diagnostic });
    emit({ kind:'log', text:result.log });
    // The check sits between preparing and writing, so a cancelled job cannot overwrite the build that replaced it.
    const save = async (path, data) => { const bytes = await untilCancelled(job, Promise.resolve(data)); check(); await untilCancelled(job, store.write(path, bytes)); return path; };
    const written = { pdf:null, log:await save(output(`${stem}.log`), new TextEncoder().encode(result.log)), synctex:null };
    if (result.pdf?.byteLength) written.pdf = await save(output(`${stem}.pdf`), result.pdf);
    if (result.synctex?.byteLength) written.synctex = await save(output(`${stem}.synctex.gz`), mapSynctex(result.synctex));
    return { ok:result.exitCode === 0, exitCode:result.exitCode, ...written, diagnostics };
  }

  async function pump() {
    if (running || clearing || !queue.length) return;
    const job = running = queue.shift();
    job.finished = new Promise(resolve => { job.finish = resolve; });
    const started = now();
    try {
      const result = await run(job);
      log(job, { ok:result.ok, exitCode:result.exitCode, errors:result.diagnostics.filter(d => d.severity === 'error').length, ms:now() - started });
      job.resolve(result);
    } catch (error) {
      // A stopped or failed engine may hold a half-finished run, so the next compile starts a fresh one.
      if (job.engineBusy) engine.stop();
      log(job, { ok:false, error:String(error.code || error.message).slice(0, 200), ms:now() - started });
      job.reject(error);
    } finally {
      running = null;
      job.finish();
      pump();
    }
  }

  return {
    // `openStore` answers { list, readBinary, write } scoped to the caller. It runs inside the job, so a cancel covers
    // any permission question it asks. `id` names the job for cancel.
    compile({ id, caller, openStore, onChunk = () => {} }, options) {
      const request = compileRequest(options);
      const same = job => job.caller === caller && job.request.folder === request.folder && job.request.main === request.main;
      for (const job of [running, ...queue].filter(Boolean).filter(same)) cancelJob(job, 'ECANCELED', 'a newer compile of this project replaced it');
      return new Promise((resolve, reject) => {
        const emit = chunk => { try { onChunk(chunk); } catch (_) {} };
        queue.push({ id, caller, openStore, request, emit, resolve, reject, cancelled:null });
        emit({ kind:'progress', stage:'queued' });
        pump();
      });
    },
    // Every job ends first, so nothing is using the engine when the cache goes. A compile sent meanwhile waits.
    clearCache() {
      return clearing ||= (async () => {
        try {
          const active = running;
          for (const job of [running, ...queue].filter(Boolean)) cancelJob(job, 'ECANCELED', 'TeX Live was deleted');
          await active?.finished;
          await engine.clear();
        } finally {
          clearing = null;
          pump();
        }
      })();
    },
    cancel(caller, id) {
      const job = [running, ...queue].find(item => item?.caller === caller && item.id === id);
      if (job) cancelJob(job);
      return !!job;
    },
  };
}
