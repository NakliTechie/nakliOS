#!/usr/bin/env node
// Real pinned Pyodide in a disposable Chrome profile. No npm browser driver,
// existing user profile, private credential, or platform shell is involved.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { assertHarnessNetwork, assertHarnessResult } from './sqlite-browser-results.mjs';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const suites = [
  { harness: 'kiln', expectedByMode: { worker: 18, main: 17 } },
  { harness: 'adversarial', expectedByMode: { worker: 5, main: 4 } },
  { harness: 'columns', expectedByMode: { worker: 3, main: 3 } },
  { harness: 'startup', expectedByMode: { worker: 4, main: 4 } },
];
const candidates = [process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
let executable;
for (const candidate of candidates) {
  try {
    await access(candidate, constants.X_OK);
    if ((await stat(candidate)).isFile()) { executable = candidate; break; }
  } catch {}
}
assert.ok(executable, 'Chrome is required for real SQLite verification; set CHROME_BIN to its executable');
const profile = await mkdtemp(path.join(tmpdir(), 'naklios-sqlite-browser-'));
const servers = [];
let browser, connection, browserError, stderr = '', exited = false;
const reports = [];
const runDeadline = Date.now() + 8 * 60 * 1000;

async function serve(isolated) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      const target = await realpath(path.resolve(root, '.' + decodeURIComponent(url.pathname)));
      if (!target.startsWith(root + path.sep) || !(await stat(target)).isFile()) {
        response.writeHead(404).end(); return;
      }
      const headers = { 'Cache-Control': 'no-store', 'Content-Type': ({
        '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm',
      })[path.extname(target)] || 'application/octet-stream' };
      if (isolated) Object.assign(headers, {
        'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless',
      });
      response.writeHead(200, headers);
      const stream = createReadStream(target);
      stream.on('error', () => response.destroy()); stream.pipe(response);
    } catch { response.writeHead(404).end(); }
  });
  servers.push(server);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function connect(url) {
  const ws = new WebSocket(url), pending = new Map(), events = new Map();
  let next = 0;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Chrome DevTools connection timed out')); }, 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Chrome DevTools connection failed')); }, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id) {
      const entry = pending.get(message.id); if (!entry) return;
      pending.delete(message.id); clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    } else if (message.sessionId && events.has(message.sessionId)) events.get(message.sessionId)(message);
  });
  ws.addEventListener('close', () => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Chrome DevTools closed')); }
    pending.clear();
  });
  return {
    events,
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timed out: ${method}`)); }, 15000);
        pending.set(id, { resolve, reject, timer });
        try { ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    close: () => ws.close(),
  };
}

async function visit(url) {
  assert.ok(Date.now() < runDeadline, 'SQLite browser gate exceeded its eight-minute limit');
  const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
  let sessionId;
  const errors = [], externalRequests = [];
  try {
    ({ sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true }));
    connection.events.set(sessionId, event => {
      if (event.method === 'Runtime.exceptionThrown' && errors.length < 10) errors.push(event.params.exceptionDetails);
      if (event.method === 'Network.requestWillBeSent' && /^https?:/.test(event.params.request.url)
          && !event.params.request.url.startsWith(new URL(url).origin + '/') && externalRequests.length <= 200) {
        externalRequests.push(event.params.request.url);
      }
    });
    for (const method of ['Runtime.enable', 'Page.enable', 'Network.enable']) await connection.send(method, {}, sessionId);
    const navigation = await connection.send('Page.navigate', { url }, sessionId);
    assert.ok(!navigation.errorText, navigation.errorText);
    const deadline = Math.min(Date.now() + 120000, runDeadline);
    let last = '';
    while (Date.now() < deadline) {
      assert.ok(!exited && !browserError, `Chrome exited: ${browserError || stderr}`);
      const value = await connection.send('Runtime.evaluate', {
        expression: "document.querySelector('#out')?.textContent", returnByValue: true,
      }, sessionId);
      last = value.result?.value || '';
      let report; try { report = JSON.parse(last); } catch {}
      if (report?.done === true) return { report, externalRequests, errors };
      await pause(150);
    }
    throw new Error(`Harness timed out: ${url}\n${last.slice(-12000)}\n${JSON.stringify(errors)}`);
  } finally {
    connection.events.delete(sessionId);
    await connection.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

try {
  const isolatedOrigin = await serve(true), plainOrigin = await serve(false);
  browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.on('error', error => { browserError = error; });
  browser.on('exit', () => { exited = true; });
  browser.stderr.on('data', data => { stderr = (stderr + data).slice(-16000); });
  let socket;
  const startupDeadline = Date.now() + 20000;
  while (!socket && Date.now() < startupDeadline) {
    assert.ok(!browserError && !exited, `Chrome failed to start: ${browserError || stderr}`);
    try {
      const [port, route] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (/^\d+$/.test(port) && route?.startsWith('/devtools/browser/')) socket = `ws://127.0.0.1:${port}${route}`;
    } catch {}
    if (!socket) await pause(50);
  }
  assert.ok(socket, `Chrome did not expose DevTools: ${stderr}`);
  connection = await connect(socket);
  for (const suite of suites) {
    const route = `/test/u4b-sqlite-${suite.harness}-harness.html`;
    for (const isolated of [true, false]) {
      const expectedByMode = isolated ? suite.expectedByMode : { main: suite.expectedByMode.main };
      const url = (isolated ? isolatedOrigin : plainOrigin) + route + (isolated ? '' : '?mode=main');
      console.log(`Browser SQLite ${suite.harness}: ${isolated ? 'Worker + main' : 'main without isolation'}`);
      const captured = await visit(url);
      reports.push({ url, ...captured });
      assertHarnessResult(captured.report, { ...suite, expectedByMode, isolated });
      assertHarnessNetwork(captured.externalRequests);
      assert.deepEqual(captured.errors, [], 'no uncaught browser exceptions');
      console.log(`PASS ${captured.report.passed}/${captured.report.total}`);
    }
    for (const query of ['?mode=workre', '?mode=', '?mode=main&mode=worker']) {
      const captured = await visit(isolatedOrigin + route + query), report = captured.report;
      reports.push({ url: isolatedOrigin + route + query, ...captured });
      assert.equal(report.ok, false); assert.equal(report.passed, 0); assert.equal(report.failed, 1);
      assert.equal(report.expectedTotal, 0); assert.equal(report.total, 1);
      assert.equal(report.results.length, 1); assert.equal(report.results[0].ok, false);
      assert.match(JSON.stringify(report.results[0]), /invalid.*mode|mode.*invalid/i);
      assert.deepEqual(report.selectedModes, []);
      assert.deepEqual(captured.externalRequests, [], 'invalid mode must not initialize a CDN runtime');
      assert.throws(() => assertHarnessResult(report, { ...suite, isolated: true }));
    }
  }
  console.log(JSON.stringify({ ok: true, runtimeAssertions: 86, invalidModeChecks: 12, reports }, null, 2));
} catch (error) {
  // Retain caught browser assertion details before the original validation error exits CI.
  console.error(JSON.stringify({ ok: false, error: String(error?.stack || error), reports }, null, 2));
  throw error;
} finally {
  if (connection) {
    await connection.send('Browser.close').catch(() => {});
    connection.close();
  }
  if (browser && !exited) {
    browser.kill('SIGTERM');
    for (let i = 0; !exited && i < 20; i++) await pause(100);
    if (!exited) {
      browser.kill('SIGKILL');
      for (let i = 0; !exited && i < 20; i++) await pause(100);
    }
  }
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (!browser || exited || browserError) await rm(profile, { recursive: true, force: true });
}
