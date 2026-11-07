// The TeX service without the engine: the queue, refusals, cancel, log reading, SyncTeX paths, the Worker's /tex/ route
// and the SDK envelope. scripts/test-tex-browser.mjs runs the real engine through the desktop.
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { compileRequest, createTexService, TEX_ENGINES } from '../sys/tex/service.mjs';
import { mapSynctex, parseTexLog } from '../sys/tex/log.mjs';
import { texAsset } from '../worker/index.mjs';
import { createHostRegistry, HOST_COMMANDS } from '../sys/host/agent.mjs';
import { createAgentFace, createGrant, createOpLog } from '../sys/rig/agent/index.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';

const bytes = text => new TextEncoder().encode(text);
const memoryStore = files => ({
  written: {},
  async list(prefix) {
    const base = prefix ? `${prefix}/` : '';
    const names = Object.keys(files).filter(name => name.startsWith(base)).map(name => name.slice(base.length));
    return [...new Set(names.map(name => name.includes('/') ? `${base}${name.split('/')[0]}/` : base + name))];
  },
  async readBinary(path) { if (!(path in files)) throw new Error('ENOENT'); return bytes(files[path]).buffer; },
  async write(path, data) { this.written[path] = data; },
});
const synctex = gzipSync('SyncTeX Version:1\nInput:1:/home/web_user/project_dir/./main.tex\nInput:2:/texlive/article.cls\n');
function fakeEngine(answer = async () => ({ pdf:bytes('%PDF'), synctex, log:'', exitCode:0 })) {
  return { starts:0, stops:0, ready:false, compiled:[], async isReady() { return this.ready; },
    async start(progress) { this.starts += 1; progress({ percent:100 }); this.ready = true; },
    async compile(request) { this.compiled.push(request); return answer(request); },
    stop() { this.stops += 1; this.ready = false; } };
}
const service = (engine, extra = {}) => createTexService({ engine, confirmDownload:async () => true, ...extra });
const paper = () => memoryStore({ 'paper/main.tex':'x', 'paper/fig/a.png':'y', 'paper/.tex-build/old.pdf':'z', 'paper/.git/config':'g', 'other/secret.tex':'s' });

// Requests: the path rules and engine names are the service's own, whatever the caller sends.
assert.deepEqual({ ...compileRequest({ main:'main.tex' }) }, { folder:'', main:'main.tex', engine:'pdflatex' });
for (const bad of [{ main:'../x.tex' }, { folder:'../other', main:'x.tex' }, { main:'x.pdf' }, { main:'x.tex', engine:'tex' }, {}, { main:'x.tex', folder:7 }])
  assert.throws(() => compileRequest(bad), /EINVAL/, JSON.stringify(bad));
assert.deepEqual(Object.keys(TEX_ENGINES), ['pdflatex', 'xelatex', 'lualatex']);

// A compile reads the folder only, skips dot folders, writes outputs and records one event with no file contents.
{
  const engine = fakeEngine(), events = [], chunks = [], store = paper();
  const result = await service(engine, { record:async (job, output) => events.push({ request:job.request, caller:job.caller, output }) })
    .compile({ id:'a', caller:'app', openStore:async () => store, onChunk:chunk => chunks.push(chunk) }, { folder:'paper', main:'main.tex' });
  assert.deepEqual(engine.compiled[0].files.map(file => file.path).sort(), ['fig/a.png', 'main.tex']);
  assert.equal(engine.compiled[0].driver, 'pdftex_bibtex8');
  assert.deepEqual(result, { ok:true, exitCode:0, pdf:'paper/.tex-build/main.pdf', log:'paper/.tex-build/main.log', synctex:'paper/.tex-build/main.synctex.gz', diagnostics:[] });
  assert.deepEqual(Object.keys(store.written).sort(), ['paper/.tex-build/main.log', 'paper/.tex-build/main.pdf', 'paper/.tex-build/main.synctex.gz']);
  assert.match(gunzipSync(store.written['paper/.tex-build/main.synctex.gz']).toString(), /^Input:1:main\.tex$/m);
  assert.deepEqual(chunks.filter(c => c.kind === 'progress').map(c => c.stage), ['queued', 'download', 'download', 'reading', 'compiling', 'writing']);
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].output.ok, true);
  assert.ok(!JSON.stringify(events).includes('%PDF'));
}

// A TeX error is an answer: no PDF, the log kept, diagnostics returned.
{
  const log = '(./main.tex\n! Undefined control sequence.\nl.7 \\oops\n)\n';
  const store = paper();
  const result = await service(fakeEngine(async () => ({ pdf:null, log, exitCode:1 }))).compile({ id:'a', caller:'app', openStore:async () => store }, { folder:'paper', main:'main.tex' });
  assert.equal(result.ok, false);
  assert.equal(result.pdf, null);
  assert.deepEqual(result.diagnostics, [{ severity:'error', kind:'tex', file:'main.tex', line:7, message:'Undefined control sequence.' }]);
  assert.ok(store.written['paper/.tex-build/main.log']);
}

// Refusals: no download without the person's yes, a main file that is not there, a project over the limit.
{
  const engine = fakeEngine();
  await assert.rejects(createTexService({ engine, confirmDownload:async () => false }).compile({ id:'a', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' }), /EPERM/);
  assert.equal(engine.starts, 0);
  await assert.rejects(service(fakeEngine()).compile({ id:'a', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'missing.tex' }), /ENOENT/);
  const big = memoryStore(Object.fromEntries(Array.from({ length:5001 }, (_, i) => [`f${i}.tex`, 'x'])));
  await assert.rejects(service(fakeEngine()).compile({ id:'a', caller:'app', openStore:async () => big }, { main:'f0.tex' }), /EFBIG/);
}

// Cancel: a running compile stops the engine and frees the queue; only the owner can cancel; a queued one never starts.
{
  let release;
  const engine = fakeEngine(() => new Promise(resolve => { release = resolve; }));
  const tex = service(engine);
  const first = tex.compile({ id:'a', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' });
  const second = tex.compile({ id:'b', caller:'app', openStore:async () => paper() }, { folder:'other', main:'secret.tex' });
  const third = tex.compile({ id:'c', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'fig.tex' });
  while (!engine.compiled.length) await new Promise(resolve => setTimeout(resolve));
  assert.equal(tex.cancel('someone-else', 'a'), false);
  assert.equal(tex.cancel('app', 'c'), true);
  await assert.rejects(third, /ECANCELED/);
  assert.equal(tex.cancel('app', 'a'), true);
  await assert.rejects(first, /ECANCELED/);
  assert.equal(engine.stops, 1, 'a cancelled run stops the engine');
  while (engine.compiled.length < 2) await new Promise(resolve => setTimeout(resolve));
  assert.equal(engine.compiled.length, 2);
  assert.equal(engine.starts, 2, 'the next compile starts a fresh engine');
  release({ pdf:bytes('%PDF'), log:'', exitCode:0 });
  assert.equal((await second).ok, true);
}

// A newer compile of one project replaces the older one, and an engine failure leaves the service usable.
{
  let release;
  const engine = fakeEngine(request => engine.compiled.length === 1 ? new Promise(resolve => { release = resolve; }) : { pdf:bytes('%PDF'), log:'', exitCode:0 });
  const tex = service(engine);
  const older = tex.compile({ id:'a', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' });
  while (!engine.compiled.length) await new Promise(resolve => setTimeout(resolve));
  const newer = tex.compile({ id:'b', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' });
  await assert.rejects(older, /replaced/);
  assert.equal((await newer).ok, true);
  void release;
  const broken = fakeEngine(async () => { throw new Error('Compilation timeout'); });
  const after = service(broken);
  await assert.rejects(after.compile({ id:'c', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' }), /timeout/);
  assert.equal(broken.stops, 1);
}

// Cancel reaches every wait: the download question and a slow output write.
{
  const engine = fakeEngine();
  const asking = createTexService({ engine, confirmDownload:() => new Promise(() => {}) });
  const job = asking.compile({ id:'a', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' });
  await new Promise(resolve => setTimeout(resolve));
  asking.cancel('app', 'a');
  await assert.rejects(job, /ECANCELED/);
  const store = paper(), write = store.write.bind(store);
  let wrote = 0;
  store.write = async (path, data) => { wrote += 1; await new Promise(() => {}); return write(path, data); };
  const writing = service(fakeEngine());
  const slow = writing.compile({ id:'b', caller:'app', openStore:async () => store }, { folder:'paper', main:'main.tex' });
  while (!wrote) await new Promise(resolve => setTimeout(resolve));
  writing.cancel('app', 'b');
  await assert.rejects(slow, /ECANCELED/);
  assert.equal(wrote, 1, 'no output starts after a cancel');
}

// Clearing the cache ends every job first, and a compile sent meanwhile runs afterwards.
{
  const order = [];
  const engine = fakeEngine(() => new Promise(() => {}));
  engine.stop = () => { order.push('stop'); engine.ready = false; };
  let finishClear;
  engine.clear = () => { order.push('clear'); return new Promise(resolve => { finishClear = resolve; }); };
  const tex = service(engine);
  const active = tex.compile({ id:'a', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' });
  const queued = tex.compile({ id:'b', caller:'app', openStore:async () => paper() }, { folder:'other', main:'secret.tex' });
  while (!engine.compiled.length) await new Promise(resolve => setTimeout(resolve));
  const clearing = tex.clearCache();
  await assert.rejects(active, /deleted/);
  await assert.rejects(queued, /deleted/);
  while (!finishClear) await new Promise(resolve => setTimeout(resolve));
  assert.deepEqual(order, ['stop', 'clear'], 'the engine stops before the cache goes, never after');
  const later = tex.compile({ id:'c', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' });
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(engine.compiled.length, 1, 'a compile waits for the clear');
  engine.compile = async () => ({ pdf:bytes('%PDF'), log:'', exitCode:0 });
  finishClear();
  await clearing;
  assert.equal((await later).ok, true);
}

// A cancel during the permission question ends the job, and a late yes starts nothing. Two clears are one clear.
{
  const engine = fakeEngine();
  let answer;
  const tex = service(engine);
  const job = tex.compile({ id:'a', caller:'app', openStore:() => new Promise(resolve => { answer = resolve; }) }, { folder:'paper', main:'main.tex' });
  while (!answer) await new Promise(resolve => setTimeout(resolve));
  tex.cancel('app', 'a');
  await assert.rejects(job, /ECANCELED/);
  answer(paper());
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(engine.compiled.length, 0);
  let clears = 0;
  engine.clear = async () => { clears += 1; };
  await Promise.all([tex.clearCache(), tex.clearCache()]);
  assert.equal(clears, 1);
}

// A stuck History write does not hold the queue.
assert.equal((await service(fakeEngine(), { record:() => new Promise(() => {}) }).compile({ id:'a', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' })).ok, true);

// The desktop command obeys a caller's path grant, as the fs commands do.
{
  const registry = createHostRegistry(Object.fromEntries(HOST_COMMANDS.map(row => [row[2], async () => 'ran'])));
  const face = createAgentFace({ registry, grant:createGrant({ prefixes:['allowed'], scopes:['fs:write'] }), opLog:createOpLog({ fs:createFileops({ backend:new MemoryBackend() }) }) });
  const input = path => ({ path, main:'main.tex', engine:'pdflatex' });
  assert.equal((await face.invoke('tex.compile', input('apps/other/private'))).code, 'EGRANT');
  assert.equal((await face.invoke('tex.compile', input(''))).code, 'EGRANT');
  assert.equal((await face.invoke('tex.compile', input('allowed/paper'))).ok, true);
}

// A failed History write does not fail the compile.
assert.equal((await service(fakeEngine(), { record:async () => { throw new Error('disk'); } }).compile({ id:'a', caller:'app', openStore:async () => paper() }, { folder:'paper', main:'main.tex' })).ok, true);

// Log reading: the missing package message, the innermost project file, errors inside a style, warnings.
{
  const missing = parseTexLog("(./main.tex\n! LaTeX Error: File `algorithm2e.sty' not found.\n\nl.5 \\usepackage\n", 'main.tex');
  assert.equal(missing[0].kind, 'missing-file');
  assert.equal(missing[0].name, 'algorithm2e.sty');
  assert.equal(missing[0].line, 5);
  assert.match(missing[0].message, /Add the file to your project folder/);
  const nested = parseTexLog('(./main.tex (/home/web_user/project_dir/sections/a.tex\n! Missing $ inserted.\nl.3 x_y\n)\n)\n', 'main.tex');
  assert.equal(nested[0].file, 'sections/a.tex');
  const style = parseTexLog('(./main.tex (/texlive/texmf-dist/tex/latex/foo.sty\n! Bad thing.\nl.900 y\n)\n)\n', 'main.tex');
  assert.deepEqual([style[0].file, style[0].line], ['main.tex', null]);
  const warning = parseTexLog("(./main.tex\nLaTeX Warning: Citation `x' on page 1 undefined on input line 9.\n)\n", 'main.tex');
  assert.deepEqual([warning[0].severity, warning[0].line], ['warning', 9]);
  assert.equal(parseTexLog(Array(500).fill('! Boom.').join('\n'), 'main.tex').length, 200);
}

// SyncTeX: project paths become relative, TeX Live paths stay.
{
  const text = gunzipSync(await mapSynctex(synctex)).toString();
  assert.match(text, /Input:1:main\.tex/);
  assert.match(text, /Input:2:\/texlive\/article\.cls/);
}

// The /tex/ route: this version's release only, right types, length and range carried, no open proxy.
{
  const calls = [];
  const load = async (url, init) => { calls.push({ url, init }); return new Response('body', { status:init.headers.Range ? 206 : 200, headers:{ 'Content-Length':'4', 'Content-Range':'bytes 0-3/4' } }); };
  const get = (path, init) => texAsset(new Request(`https://naklios.dev${path}`, init), load);
  const wasm = await get('/tex/1.4.1/busytex.wasm');
  assert.equal(calls[0].url, 'https://github.com/NakliTechie/naklios-tex/releases/download/engine-1.4.1/busytex.wasm');
  assert.equal(wasm.headers.get('Content-Type'), 'application/wasm');
  assert.equal(wasm.headers.get('Content-Length'), '4');
  assert.match(wasm.headers.get('Cache-Control'), /immutable/);
  assert.equal((await get('/tex/1.4.1/texlive-extra.js')).headers.get('Content-Type'), 'text/javascript; charset=utf-8');
  assert.equal((await get('/tex/1.4.1/texlive-extra.data', { headers:{ Range:'bytes=0-3' } })).status, 206);
  const count = calls.length;
  for (const path of ['/tex/9.9.9/busytex.wasm', '/tex/1.4.1/../secret.js', '/tex/1.4.1/a/b.js', '/tex/1.4.1/x.exe', '/tex/1.4.1/.env'])
    assert.equal((await get(path)).status, 404, path);
  assert.equal((await get('/tex/1.4.1/busytex.wasm', { method:'POST' })).status, 405);
  assert.equal(calls.length, count, 'a refused path never reaches GitHub');
  assert.equal((await texAsset(new Request('https://naklios.dev/tex/1.4.1/gone.js'), async () => new Response('', { status:404 }))).status, 404);
  assert.equal((await texAsset(new Request('https://naklios.dev/tex/1.4.1/x.js'), async () => new Response('', { status:503 }))).status, 502);
}

// The SDK envelope: refused without the capability; chunks reach onChunk; the reply settles; cancel sends no reply type.
{
  const listeners = [], sent = [];
  const parent = { postMessage:message => sent.push(message) };
  const win = { location:{ search:'', href:'https://app.test/', origin:'https://app.test' }, addEventListener:(type, cb) => { if (type === 'message') listeners.push(cb); }, postMessage() {}, parent };
  win.self = win;
  vm.createContext(Object.assign(win, { window:win, document:{ referrer:'https://naklios.dev/' }, URL, setTimeout, clearTimeout, Map, Promise, console }));
  vm.runInContext(readFileSync(new URL('../sdk/naklios.js', import.meta.url), 'utf8'), win);
  const deliver = data => listeners.forEach(cb => cb({ source:parent, origin:'https://naklios.dev', data }));
  deliver({ type:'naklios:capabilities', experimental_tex:false });
  const tex = win.naklios.experimental_tex;
  await assert.rejects(tex.compile({ main:'main.tex' }), /not permitted/);
  deliver({ type:'naklios:capabilities', experimental_tex:true });
  const chunks = [];
  const job = tex.compile({ folder:'paper', main:'main.tex', engine:'xelatex', onChunk:chunk => chunks.push(chunk) });
  const request = sent.find(message => message.type === 'naklios:tex:compile');
  assert.deepEqual([request.folder, request.main, request.engine, request.requestId], ['paper', 'main.tex', 'xelatex', job.id]);
  deliver({ type:'naklios:tex:event', requestId:job.id, event:'chunk', chunk:{ kind:'progress', stage:'compiling' } });
  tex.cancel(job.id);
  assert.equal(sent.at(-1).type, 'naklios:tex:cancel');
  deliver({ type:'naklios:tex:reply', requestId:job.id, result:{ ok:true } });
  assert.equal((await job).ok, true);
  assert.equal(chunks[0].stage, 'compiling');
  // A settled compile leaves no timer: this script exits on its own only if that holds.
}

console.log('TeX service: PASS');
