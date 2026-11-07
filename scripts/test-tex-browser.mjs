#!/usr/bin/env node
// The TeX service in real Chrome through the desktop: Notes stands in for a calling app, the engine files come from the
// real release through the same /tex/ route as production, and each compile goes SDK → host → engine → storage. It
// downloads about 680 MB into a disposable profile. No npm browser driver (as test-app-commands-browser).
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const candidates = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) { executable = candidate; break; } } catch {}
}
assert.ok(executable, 'Chrome is required; set CHROME_BIN to its executable');

const port = await new Promise(resolve => { const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['scripts/serve-coi.mjs', '--port', String(port)], { cwd:root, stdio:'ignore' });
const profile = await mkdtemp(path.join(tmpdir(), 'naklios-tex-'));
let browser, ws, exited = false, stderr = '';

function devtools(url) {
  const pending = new Map(); let next = 0;
  const socket = new WebSocket(url);
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const entry = message.id && pending.get(message.id); if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
  });
  const opened = new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  return { opened, close: () => socket.close(), send(method, params = {}, sessionId, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timed out: ${method}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  } };
}

// Runs in the desktop page. Each step records what the caller saw.
const SCRIPT = `(async () => {
  const out = {};
  const wait = async (test, label, ms = 30000) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) { const value = test(); if (value) return value; }
    throw new Error('timed out: ' + label);
  };
  const answerDialog = async label => (await wait(() => [...document.querySelectorAll('.nw-dlg-btn')].find(b => b.textContent.trim() === label), 'dialog ' + label)).click();
  const open = async id => {
    openApp(APPS.find(app => app.id === id));
    const frame = await wait(() => openWindows[id]?.querySelector('iframe')?.contentWindow?.naklios ? openWindows[id].querySelector('iframe') : null, id + ' window');
    return frame.contentWindow.naklios;
  };
  const notes = await open('notes');
  await wait(() => notes.capabilities.ai !== undefined, 'capabilities');

  // No Folder or Crate: refused before anything reaches the engine.
  out.noStoreCapability = notes.capabilities.experimental_tex;
  out.noStore = await notes.experimental_tex.compile({ folder:'paper', main:'main.tex' }).catch(e => e.message);

  // A connected Folder, granted to both apps. The browser's private file system stands in for a picked folder.
  state.fsHandle = await (await navigator.storage.getDirectory()).getDirectoryHandle('tex-test', { create:true });
  state.appPermissions.notes = { backend:'fsa', granted:true };
  state.appPermissions.calendar = { backend:'fsa', granted:true };
  broadcastCapabilities();
  await wait(() => notes.capabilities.experimental_tex === true, 'tex capability');
  const write = (file, text) => BACKENDS.fsa.write('apps/notes/' + file, text);
  const article = body => '\\\\documentclass{article}\\n' + body;
  await write('paper/main.tex', article('\\\\usepackage{environ,natbib,amsmath}\\n\\\\begin{document}\\n\\\\section{One}\\\\label{a}\\nSee \\\\ref{a}.\\n\\\\input{sections/two}\\n\\\\end{document}\\n'));
  await write('paper/sections/two.tex', 'Second file: $x^2$.\\n');
  await write('bib/main.tex', article('\\\\usepackage[backend=biber]{biblatex}\\n\\\\addbibresource{refs.bib}\\n\\\\begin{document}\\nA \\\\cite{knuth}.\\n\\\\printbibliography\\n\\\\end{document}\\n'));
  await write('bib/refs.bib', '@book{knuth, author={Donald Knuth}, title={The TeXbook}, year={1984}, publisher={Addison-Wesley}}\\n');
  await write('typo/main.tex', article('\\\\begin{document}\\nfine\\n\\\\oops\\n\\\\end{document}\\n'));
  await write('missing/main.tex', article('\\\\usepackage{algorithm2e}\\n\\\\begin{document}\\nx\\n\\\\end{document}\\n'));
  await write('fonts/main.tex', article('\\\\usepackage{fontspec}\\n\\\\begin{document}\\nfonts\\n\\\\end{document}\\n'));

  // The first compile asks. "Not now" refuses and downloads nothing.
  const refused = notes.experimental_tex.compile({ folder:'paper', main:'main.tex' }).catch(e => e.message);
  await answerDialog('Not now');
  out.refused = await refused;

  const chunks = [];
  const started = performance.now();
  const first = notes.experimental_tex.compile({ folder:'paper', main:'main.tex', onChunk:chunk => chunks.push(chunk) });
  await answerDialog('Download');
  out.paper = await first;
  out.firstMs = Math.round(performance.now() - started);
  out.stages = [...new Set(chunks.filter(c => c.kind === 'progress').map(c => c.stage))];
  out.logChunk = chunks.some(c => c.kind === 'log' && c.text.includes('This is pdfTeX'));
  const read = async file => new Uint8Array(await BACKENDS.fsa.readBinary('apps/notes/' + file));
  out.pdfHeader = new TextDecoder().decode((await read(out.paper.pdf)).slice(0, 5));
  const synctex = new TextDecoder().decode(await new Response(new Blob([await read(out.paper.synctex)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  out.synctexInputs = synctex.split('\\n').filter(line => line.startsWith('Input:') && !line.includes(':/')).map(line => line.split(':')[2]);

  const again = performance.now();
  out.warm = await notes.experimental_tex.compile({ folder:'paper', main:'main.tex' });
  out.warmMs = Math.round(performance.now() - again);
  out.bib = await notes.experimental_tex.compile({ folder:'bib', main:'main.tex' });
  out.bibLog = new TextDecoder().decode(await read(out.bib.log));
  out.typo = await notes.experimental_tex.compile({ folder:'typo', main:'main.tex' });
  out.missing = await notes.experimental_tex.compile({ folder:'missing', main:'main.tex' });
  out.xelatex = await notes.experimental_tex.compile({ folder:'fonts', main:'main.tex', engine:'xelatex' });
  out.lualatex = await notes.experimental_tex.compile({ folder:'fonts', main:'main.tex', engine:'lualatex' });

  // Cancel stops the run, and the next compile starts a fresh engine.
  const cancelled = notes.experimental_tex.compile({ folder:'paper', main:'main.tex' });
  notes.experimental_tex.cancel(cancelled.id);
  out.cancelled = await cancelled.catch(e => e.message);
  out.afterCancel = await notes.experimental_tex.compile({ folder:'paper', main:'main.tex' });

  // Another app sees only its own storage.
  const calendar = await open('calendar');
  await wait(() => calendar.capabilities.experimental_tex === true, 'calendar capability');
  out.otherApp = await calendar.experimental_tex.compile({ folder:'paper', main:'main.tex' }).catch(e => e.message);
  out.escape = await calendar.experimental_tex.compile({ folder:'../notes/paper', main:'main.tex' }).catch(e => e.message);

  // The desktop's commands reach the same service.
  const { face } = await hostAgentReady;
  out.engines = await face.invoke('tex.engines', {});
  out.cache = await face.invoke('tex.cache', {});
  out.door = await face.invoke('tex.compile', { path:'apps/notes/paper', main:'main.tex', engine:'pdflatex' });

  const history = await (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle('naklios')).getDirectoryHandle('history')).getFileHandle('tex.ndjson')).getFile();
  out.history = (await history.text()).trim().split('\\n');
  return out;
})()`;

try {
  browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-gpu',
    '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.on('exit', () => { exited = true; });
  browser.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  let socket;
  for (const deadline = Date.now() + 20000; !socket && Date.now() < deadline;) {
    assert.ok(!exited, `Chrome exited: ${stderr}`);
    try {
      const [debugPort, route] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (/^\d+$/.test(debugPort) && route?.startsWith('/devtools/browser/')) socket = `ws://127.0.0.1:${debugPort}${route}`;
    } catch {}
    if (!socket) await pause(50);
  }
  assert.ok(socket, `Chrome did not expose DevTools: ${stderr}`);
  ws = devtools(socket); await ws.opened;
  const { targetId } = await ws.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await ws.send('Target.attachToTarget', { targetId, flatten: true });
  await ws.send('Runtime.enable', {}, sessionId);
  await ws.send('Page.navigate', { url: `${origin}/` }, sessionId);
  for (let ready = false, deadline = Date.now() + 30000; !ready;) {
    assert.ok(Date.now() < deadline, 'the desktop did not load');
    ready = (await ws.send('Runtime.evaluate', { expression: "typeof hostAgentReady !== 'undefined' && document.readyState === 'complete'", returnByValue: true }, sessionId)).result.value === true;
    if (!ready) await pause(200);
  }
  const evaluated = await ws.send('Runtime.evaluate', { expression: SCRIPT, awaitPromise: true, returnByValue: true }, sessionId, 20 * 60 * 1000);
  assert.ok(!evaluated.exceptionDetails, JSON.stringify(evaluated.exceptionDetails));
  const r = evaluated.result.value;

  assert.equal(r.noStoreCapability, false, 'no connected storage, no TeX');
  assert.match(r.noStore, /not permitted/);
  assert.match(r.refused, /EPERM/, 'Not now refuses the download');
  assert.equal(r.paper.ok, true, JSON.stringify(r.paper));
  assert.equal(r.paper.pdf, 'paper/.tex-build/main.pdf');
  assert.equal(r.pdfHeader, '%PDF-');
  assert.deepEqual(r.stages, ['queued', 'download', 'reading', 'compiling', 'writing']);
  assert.equal(r.logChunk, true, 'the log reaches the caller');
  assert.ok(r.synctexInputs.includes('main.tex') && r.synctexInputs.includes('sections/two.tex'), `SyncTeX paths: ${r.synctexInputs}`);
  assert.equal(r.warm.ok, true);
  assert.equal(r.bib.ok, true, JSON.stringify(r.bib));
  assert.equal(r.bib.diagnostics.filter(d => /undefined/i.test(d.message)).length, 0, 'the citation resolves');
  assert.equal(r.typo.ok, false);
  assert.deepEqual(r.typo.diagnostics.filter(d => d.severity === 'error').map(d => [d.file, d.line, d.message])[0], ['main.tex', 4, 'Undefined control sequence.']);
  assert.equal(r.missing.ok, false);
  assert.equal(r.missing.diagnostics.find(d => d.kind === 'missing-file')?.name, 'algorithm2e.sty');
  assert.equal(r.xelatex.ok, true, JSON.stringify(r.xelatex));
  assert.equal(r.lualatex.ok, true, JSON.stringify(r.lualatex));
  assert.match(r.cancelled, /ECANCELED/);
  assert.equal(r.afterCancel.ok, true, 'a cancel leaves the service usable');
  assert.match(r.otherApp, /ENOENT/, 'Calendar cannot compile Notes\' project');
  assert.match(r.escape, /EINVAL/);
  assert.deepEqual(r.engines.result.engines, ['pdflatex', 'xelatex', 'lualatex']);
  assert.deepEqual(r.cache.result.packs.map(pack => pack.cached), [true, true, true]);
  assert.equal(r.door.result?.ok, true, JSON.stringify(r.door));
  assert.ok(r.history.length >= 10, `History holds ${r.history.length} events`);
  assert.equal(JSON.parse(r.history[0]).door, 'tex');
  assert.ok(!r.history.join('\n').includes('documentclass'), 'History holds no file contents');
  console.log(`TeX service in Chrome: PASS (first compile with download ${r.firstMs} ms, warm ${r.warmMs} ms; observed, not a benchmark)`);
} finally {
  try { ws?.close(); } catch {}
  if (browser && !exited) { browser.kill('SIGTERM'); await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 3000); }); }
  server.kill('SIGTERM');
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
