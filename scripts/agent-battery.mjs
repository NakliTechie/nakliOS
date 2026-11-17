#!/usr/bin/env node
// App-shell layer 4 task battery (docs/specs/app-shell-001.md section 10.9). Runs real jobs through an app's Ask box or
// through the voice assistant's ask_app tool, inside a NakliOS tab in the person's Chrome over the CDP daemon
// (~/Code/infra/bin/chrome-cdpd.mjs on 127.0.0.1:9334), and judges each from doc.describe, not from the model's summary.
//
//   node scripts/agent-battery.mjs --origin http://127.0.0.1:8985 --tasks test/agent-battery/tasks.mjs \
//        [--only pellucia,reckon] [--task id1,id2] [--via box|voice] [--out <dir>] [--tab <targetId>] [--minutes 20]
//
// A task: { id, app, request, check: 'JS body; d is doc.describe; return { pass, why }', setup?: 'JS body', prep?: [{ app, js }], minutes? }.
// setup and check run in the app's frame with `shell` (naklishell.current) and `cmd(name, input)` in scope.
// The voice path stands in for the person on the host's "Let the assistant change …?" prompt (it answers Allow).
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const arg = (n, f = null) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : f; };
const origin = (arg('--origin', 'http://127.0.0.1:8985')).replace(/\/$/, '');
const via = arg('--via', 'box');
const out = resolve(arg('--out', `/tmp/agent-battery-${Date.now()}`));
const onlyApps = arg('--only') ? arg('--only').split(',') : null;
const onlyTasks = arg('--task') ? arg('--task').split(',') : null;
const defaultMinutes = Number(arg('--minutes', 20));
mkdirSync(out, { recursive: true });

async function cdp(body) {
  const res = await fetch('http://127.0.0.1:9334', { method: 'POST', body: JSON.stringify(body) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let tab = arg('--tab');
async function evalHost(js) {
  const r = await cdp({ cmd: 'eval', t: tab, js });
  if (r && typeof r === 'object' && r.exc) throw new Error(r.exc);
  if (r && typeof r === 'object' && r.err) throw new Error(r.err);
  return r;
}
// Code that runs in the app frame: W is its window, shell its mounted app shell.
const inApp = (app, body) => `(async () => {
  const f = openWindows[${JSON.stringify(app)}]?.querySelector('iframe'); if (!f) throw new Error('${app} is not open');
  const W = f.contentWindow, shell = W.naklishell && W.naklishell.current; if (!shell || !shell.assistant) throw new Error('${app} has no layer 4 shell');
  const cmd = (n, i) => shell.assistant.command(n, i);
  ${body}
})()`;

// A fresh document; a "Save changes?" question from the shell gets Don't save (the last task's document is not kept).
const fresh = (app) => inApp(app, `const p = shell.newDocument();
  for (let i = 0; i < 40; i++) {
    const d = [...W.document.querySelectorAll('dialog.nsh-dlg[open]')].find(x => /Save changes/.test(x.innerText));
    if (d) { const b = [...d.querySelectorAll('button')].find(x => /Don.t save/.test(x.textContent)); if (b) { b.click(); d.returnValue = 'discard'; d.dispatchEvent(new W.Event('close')); } break; }
    if (await Promise.race([p.then(() => true), new Promise(r => setTimeout(() => r(false), 100))])) break;
  }
  await p; return true;`);

async function openApp(app) {
  await evalHost(`(async () => { document.querySelector('.nw-tour-skip')?.click(); if (!openWindows[${JSON.stringify(app)}]) openApp(APPS.find(a => a.id === ${JSON.stringify(app)})); else focusWindow(openWindows[${JSON.stringify(app)}]); return true; })()`);
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    const ok = await evalHost(`(() => { const f = openWindows[${JSON.stringify(app)}]?.querySelector('iframe'); try { return !!(f && f.contentWindow.naklishell && f.contentWindow.naklishell.current && f.contentWindow.naklishell.current.assistant); } catch (e) { return false; } })()`);
    if (ok === true) return;
  }
  throw new Error(`${app} did not mount a layer 4 shell within 40 s`);
}

async function runTask(t) {
  const started = Date.now();
  const row = { id: t.id, app: t.app, via, request: t.request, pass: false, why: '', state: '', mode: '', turns: 0, commands: 0, seconds: 0, summary: '', lastSteps: [] };
  try {
    // Cross-app tasks first fill another app (prep: [{ app, js }]), which stays open for the task to read from.
    for (const p of t.prep || []) {
      await openApp(p.app);
      await evalHost(fresh(p.app)); await evalHost(inApp(p.app, `${p.js}; return true;`));
    }
    await openApp(t.app);
    // A fresh document for every task, so one task cannot pass on another's work.
    await evalHost(fresh(t.app));
    if (t.setup) await evalHost(inApp(t.app, t.setup));
    if (via === 'voice') {
      const r = await evalHost(`(async () => {
        const { moreTools } = await import('./sys/voice/more-tools.mjs');
        const [{ catalog }] = await Promise.all([hostAgentReady, appCommandsDeclared]);
        const apps = { tools: catalog.toolSchemas().filter(x => APPS.find(a => a.id === x.annotations?.app)?.commands).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
          invoke: (name, args) => runAppCommandFor('voice-assistant', name, args, async () => true) };
        const tool = moreTools({ apps, memory: { read: async () => null, write: async () => {} } }).find(x => x.name === 'ask_app');
        // One retry: a first call to an app that is still restoring its last document once never answered (2026-11-17).
        const once = () => Promise.race([tool.run({ app: ${JSON.stringify(t.app)}, request: ${JSON.stringify(t.request)} }), new Promise(r => setTimeout(() => r(null), 90000))]);
        const out = (await once()) || { retried: true, ...(await once()) };
        return JSON.stringify(out);
      })()`);
      row.handoff = JSON.parse(r);
    } else {
      // The Ask box shows once NakliOS has told the app that AI is allowed.
      for (let i = 0; i < 40; i++) { if (await evalHost(inApp(t.app, `return shell.assistant.available();`)) === true) break; await sleep(500); }
      await evalHost(inApp(t.app, `shell.assistant.open();
        const box = W.document.querySelector('.nsh-pane textarea'); box.value = ${JSON.stringify(t.request)};
        box.closest('form').requestSubmit(); return true;`));
    }
    const limit = Date.now() + (t.minutes || defaultMinutes) * 60000;
    let st;
    for (;;) {
      await sleep(3000);
      // The person's answers on the host prompts this test origin raises (AI use, another app's commands, a change).
      await evalHost(`(() => { for (const d of document.querySelectorAll('dialog.nw-dlg[open]')) { const t = d.innerText;
        if (/^(Allow AI\\?|Let .* use |Allow this change\\?|Allow this\\?|This change is hard to undo)/m.test(t)) { const b = [...d.querySelectorAll('button')].find(x => /^(Allow|Allow once|OK)$/.test(x.textContent.trim()));
          // In a window Chrome counts as hidden (covered by others) the dialog closes but its close event never fires, so the
          // host's promise would wait for ever: send the event the browser should have sent.
          if (b) { b.click(); d.returnValue = b.value || 'ok'; d.dispatchEvent(new Event('close')); } } } return true; })()`);
      // The same for the app's own "hard to undo" question from its assistant (the person allows it once).
      await evalHost(inApp(t.app, `for (const d of W.document.querySelectorAll('dialog.nsh-dlg[open]')) { if (/hard to undo/.test(d.innerText)) {
        const b = d.querySelector('.nsh-primary'); if (b) { b.click(); d.returnValue = 'ok'; d.dispatchEvent(new W.Event('close')); } } } return true;`)).catch(() => {});
      st = JSON.parse(await evalHost(inApp(t.app, `return JSON.stringify(shell.assistant.status());`)));
      if (st.state && st.state !== 'running' && st.state !== 'idle') break;
      if (Date.now() > limit) { await evalHost(inApp(t.app, `shell.assistant.stop(); return true;`)); st.state = 'timeout'; break; }
    }
    Object.assign(row, { state: st.state, mode: st.mode, turns: st.turns, commands: st.commands, summary: st.summary || '', lastSteps: st.lastSteps || [] });
    const verdict = JSON.parse(await evalHost(inApp(t.app, `const d = await cmd('doc.describe', {}); const st = shell.assistant.status(); const v = await (async (d) => { ${t.check} })(d); return JSON.stringify(v || { pass: false, why: 'check returned nothing' });`)));
    row.pass = !!verdict.pass; row.why = verdict.why || '';
    const shot = await evalHost(inApp(t.app, `try { const s = await cmd('view.snapshot', {}); return s && (s.dataUrl || s.image) || ''; } catch (e) { return ''; }`));
    if (typeof shot === 'string' && shot.startsWith('data:image/')) {
      const ext = shot.slice(11, shot.indexOf(';')) === 'jpeg' ? 'jpg' : 'png';
      writeFileSync(`${out}/${t.id}-${via}.${ext}`, Buffer.from(shot.slice(shot.indexOf(',') + 1), 'base64'));
      row.snapshot = `${t.id}-${via}.${ext}`;
    }
  } catch (e) { row.why = `harness: ${e.message}`; row.state = row.state || 'error'; }
  row.seconds = Math.round((Date.now() - started) / 1000);
  return row;
}

const { TASKS } = await import(resolve(arg('--tasks', new URL('../test/agent-battery/tasks.mjs', import.meta.url).pathname)));
const tasks = TASKS.filter(t => (!onlyApps || onlyApps.includes(t.app)) && (!onlyTasks || onlyTasks.includes(t.id)));
// Its own window: a background tab throttles timers and stops animation frames, which stalls snapshots and polling.
if (!tab) tab = (await cdp({ cmd: 'raw', text: JSON.stringify({ method: 'Target.createTarget', params: { url: `${origin}/index.html`, newWindow: true, background: true } }) })).targetId, await sleep(6000);
const rows = [];
for (const t of tasks) {
  process.stdout.write(`${t.id} (${t.app}, ${via}) … `);
  const row = await runTask(t);
  rows.push(row);
  writeFileSync(`${out}/results-${via}.json`, JSON.stringify(rows, null, 2));
  console.log(`${row.pass ? 'PASS' : 'FAIL'} ${row.state} ${row.mode} ${row.commands} cmds ${row.seconds}s ${row.pass ? '' : '— ' + row.why}`);
}
const passed = rows.filter(r => r.pass).length;
console.log(`\n${passed}/${rows.length} passed (${via}); results in ${out}/results-${via}.json`);
