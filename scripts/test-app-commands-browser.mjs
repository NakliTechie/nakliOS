#!/usr/bin/env node
// Common rail step 2 in real Chrome: the desktop declares Notes' and Calendar's commands from their commands.json,
// a caller invokes them through the catalog while both apps are closed, the desktop opens each app minimized, and the
// command runs inside the app on its own storage. Disposable profile, no npm browser driver (as test-sqlite-browser).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
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

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    let target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if ((await stat(target).catch(() => null))?.isDirectory()) target = path.join(target, 'index.html');
    target = await realpath(target);
    if (!target.startsWith(root + path.sep) || !(await stat(target)).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': ({
      '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(target)] || 'application/octet-stream' });
    createReadStream(target).on('error', () => response.destroy()).pipe(response);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(path.join(tmpdir(), 'naklios-app-commands-'));
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
  const pad = n => String(n).padStart(2, '0');
  const day = new Date(Date.now() + 2 * 86400e3);
  const date = day.getFullYear() + '-' + pad(day.getMonth() + 1) + '-' + pad(day.getDate());
  const out = {};
  const { faceFor } = await hostAgentReady; await appCommandsDeclared;
  const face = faceFor('browser-test', ['app:read', 'app:write']);
  out.listed = window.nakliOS.tools().filter(t => ['notes', 'calendar'].includes(t.annotations?.app)).map(t => t.name).sort();
  out.notesOpenBefore = !!openWindows.notes;
  out.add = await face.invoke('notes.list.add', { list: 'shopping', things: 'milk, eggs and bread' });
  out.notesOpenAfter = !!openWindows.notes;
  out.notesMinimized = openWindows.notes?.classList.contains('is-minimized') === true;
  out.addAgain = await face.invoke('notes.list.add', { list: 'Shopping list', things: 'tea' });
  out.read = await face.invoke('notes.list.read', { list: 'my shopping list' });
  out.missing = await face.invoke('notes.list.read', { list: 'packing' });
  out.note = await face.invoke('notes.note.create', { text: 'The plumber comes on Tuesday. Leave the gate open.' });
  out.badArgs = await face.invoke('notes.list.add', { list: 'shopping' });
  const frame = openWindows.notes.querySelector('iframe').contentDocument;
  out.notesShowsList = frame.body.innerText.includes('Shopping list');
  out.event = await face.invoke('calendar.events.create', { title: 'Dentist', start: date + 'T15:00', duration_minutes: 30, location: 'Bandra' });
  out.calendarMinimized = openWindows.calendar?.classList.contains('is-minimized') === true;
  out.allDay = await face.invoke('calendar.events.create', { title: 'Holiday', start: date });
  out.past = await face.invoke('calendar.events.create', { title: 'Old', start: '2020-01-01T10:00' });
  out.badDate = await face.invoke('calendar.events.create', { title: 'Bad', start: '2031-02-30' });
  out.list = await face.invoke('calendar.events.list', { date });
  out.denied = await faceFor('reader', ['app:read']).invoke('notes.note.create', { text: 'x' });
  return out;
})()`;

try {
  browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-dev-shm-usage', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  browser.on('exit', () => { exited = true; });
  browser.stderr.on('data', data => { stderr = (stderr + data).slice(-8000); });
  let socket;
  for (const deadline = Date.now() + 20000; !socket && Date.now() < deadline;) {
    assert.ok(!exited, `Chrome exited: ${stderr}`);
    try {
      const [port, route] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      if (/^\d+$/.test(port) && route?.startsWith('/devtools/browser/')) socket = `ws://127.0.0.1:${port}${route}`;
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
    ready = (await ws.send('Runtime.evaluate', { expression: "typeof appCommandsDeclared !== 'undefined' && document.readyState === 'complete'", returnByValue: true }, sessionId)).result.value === true;
    if (!ready) await pause(200);
  }
  const evaluated = await ws.send('Runtime.evaluate', { expression: SCRIPT, awaitPromise: true, returnByValue: true }, sessionId, 120000);
  assert.ok(!evaluated.exceptionDetails, JSON.stringify(evaluated.exceptionDetails));
  const r = evaluated.result.value;

  assert.deepEqual(r.listed, ['calendar.events.create', 'calendar.events.list', 'notes.list.add', 'notes.list.read', 'notes.note.create'],
    'the catalog lists both apps\' declared commands while they are closed');
  assert.equal(r.notesOpenBefore, false);
  assert.equal(r.add.ok, true, JSON.stringify(r.add));
  assert.equal(r.notesOpenAfter, true, 'a call opens Notes');
  assert.equal(r.notesMinimized, true, 'and keeps it minimized');
  assert.deepEqual(r.add.result.added, ['milk', 'eggs', 'bread']);
  assert.equal(r.add.result.list, 'Shopping list');
  assert.equal(r.addAgain.ok, true);
  assert.deepEqual(r.read.result.items, ['milk', 'eggs', 'bread', 'tea'], '"my shopping list" and "Shopping list" are one list');
  assert.equal(r.missing.result.message, 'There is no packing list.');
  assert.equal(r.note.result.created, 'The plumber comes on Tuesday');
  assert.equal(r.badArgs.code, 'EINVAL', 'the catalog checks arguments before the app runs');
  assert.equal(r.notesShowsList, true, 'Notes shows the new list in its own window');
  assert.equal(r.event.ok, true, JSON.stringify(r.event));
  assert.equal(r.calendarMinimized, true);
  assert.equal(r.event.result.end.slice(-5), '15:30');
  assert.equal(r.allDay.result.all_day, true);
  assert.match(r.past.message, /in the past/);
  assert.match(r.badDate.message, /not a real date/);
  assert.deepEqual(r.list.result.events.map(e => e.title).sort(), ['Dentist', 'Holiday']);
  assert.equal(r.denied.code, 'EGRANT', 'a read-only caller cannot write');
  console.log('common rail step 2 — Notes and Calendar commands from closed apps, in Chrome: PASS');
} finally {
  try { ws?.close(); } catch {}
  if (browser && !exited) { browser.kill('SIGTERM'); await new Promise(resolve => { browser.once('exit', resolve); setTimeout(resolve, 3000); }); }
  server.close();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
