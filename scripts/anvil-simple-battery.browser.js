// Anvil simple-task battery — run in the NakliOS HOST page (naklios.dev or a local serve), with
// Anvil open in an Immersive window and the host's AI configured (the bed's fuel: DeepSeek).
//
//   paste this file into the host console, then:  await anvilBattery.run()
//
// Why: on 2026-09-24 two trivial asks ran 4 and 13 steps, because a message sent into an existing
// task inherited that task's unfinished goal. This battery pins the behaviour: 6 trivial asks ×
// 3 task states. The bar (plan/pending.md): a trivial ask on a FRESH task ends in ≤ 2 steps with
// no unrelated writes; on a finished or errored task, no write outside the ask.
//
// It drives the real app through its own DOM (new project, new task, #prompt, #send, #stop) and
// reads the verdict from the run RECORD in the Anvil iframe's OPFS — never from the rendered log.
// Not a gate lane: it spends real model calls. A recorded run can later become a replay-corpus lane.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => [...document.querySelectorAll('iframe')].find((f) => /\/apps\/anvil\//.test(f.src));
  const W = () => frame().contentWindow;
  const D = () => frame().contentDocument;
  const T = () => W().__anvil && W().__anvil.test;

  async function waitFor(fn, ms = 20000, what = 'condition') {
    const t0 = Date.now();
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + what); await sleep(250); }
  }

  // The app's own prompt dialog (askText): fill the first input, press its primary button.
  async function answerDialog(value) {
    const inp = await waitFor(() => D().querySelector('dialog[open] input, .modal input, [role=dialog] input'), 5000, 'dialog input');
    inp.value = value; inp.dispatchEvent(new Event('input', { bubbles: true }));
    const ok = [...inp.closest('dialog, .modal, [role=dialog]').querySelectorAll('button')].find((b) => /ok|create|save|done/i.test(b.textContent)) || null;
    if (ok) ok.click(); else inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }

  async function newProject(name) { D().getElementById('new-project').click(); await answerDialog(name); await sleep(800); }
  async function newTask() { D().getElementById('new-task').click(); await sleep(300); return T().taskState().id; }

  function status() { const s = T().taskState(); return s && s.status; }
  // The Send button reads "Queue" while the app's own run flag is set — which outlives the task's
  // status for a moment after Stop. A prompt sent then is QUEUED, and the queue holds after an
  // aborted run (the first harness pass stalled every errored case on exactly this).
  const sendReady = () => D().getElementById('send').textContent.trim() === 'Send';
  async function send(text) {
    await waitFor(sendReady, 30000, 'Send button ready');
    const p = D().getElementById('prompt'); p.value = text; p.dispatchEvent(new Event('input', { bubbles: true }));
    D().getElementById('send').click();
  }
  // Send. The admission speed bump ("Send again to run anyway") keeps the prompt in the box and
  // lets the second click through — so while the prompt is still there, click again.
  async function sendAndWait(text, { abortAfterFirstCall = false, timeoutMs = 240000 } = {}) {
    const before = (await records()).length;
    await send(text);
    await sleep(800);
    if (D().getElementById('prompt').value.trim() === text) { D().getElementById('send').click(); await sleep(800); }
    if (abortAfterFirstCall) { await waitFor(() => status() === 'running', 15000, 'run start'); await sleep(1500); D().getElementById('stop').click(); }
    await waitFor(async () => status() !== 'running' && (await records()).length > before, timeoutMs, 'run end');
    return (await records()).at(-1);
  }

  // The active task's record files in OPFS (anvil/runs/<project>/<task>/<ts>.json), oldest first.
  async function records() {
    const st = T().taskState(); if (!st) return [];
    const root = await W().navigator.storage.getDirectory();
    try {
      let dh = await (await root.getDirectoryHandle('anvil')).getDirectoryHandle('runs');
      const proj = String(W().__anvilState?.activeProject || '');
      // project id is not on taskState; find the task dir under any project
      for await (const [pn, ph] of dh.entries()) {
        if (ph.kind !== 'directory') continue;
        try { const th = await ph.getDirectoryHandle(st.id); const out = []; for await (const [n] of th.entries()) out.push({ project: pn, task: st.id, name: n, h: th }); return out.sort((a, b) => a.name.localeCompare(b.name)); } catch (_) {}
      }
      void proj;
    } catch (_) {}
    return [];
  }

  const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'edit_lines', 'remove', 'move', 'mkdir']);
  async function readRecord(r) {
    const rec = JSON.parse(await (await (await r.h.getFileHandle(r.name)).getFile()).text());
    const evs = rec.events.split('\n').filter(Boolean).map(JSON.parse);
    const body = (h) => { const b = rec.blobs[h]; return typeof b === 'string' ? (() => { try { return JSON.parse(b); } catch (_) { return b; } })() : b; };
    const calls = []; let tokens = 0; let stop = null;
    for (const e of evs) {
      if (e.tool === 'llm.responded') { const o = body(e.output_hash) || {}; tokens += (o.usage && o.usage.total) || 0; for (const c of o.toolCalls || []) calls.push({ name: c.name || c.function?.name, args: c.arguments || c.function?.arguments || c.args }); }
      if (e.tool === 'run.stopped') stop = (body(e.output_hash) || {}).stop;
    }
    const steps = evs.filter((e) => e.tool === 'llm.requested').length;
    const wallMs = evs.length ? evs.at(-1).ts - evs[0].ts : 0;
    const writes = calls.filter((c) => WRITE_TOOLS.has(c.name)).map((c) => { let a = c.args; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) {} } return (a && (a.path || a.from || a.to)) || '(patch)'; });
    const shellWrites = calls.filter((c) => c.name === 'shell').map((c) => { let a = c.args; if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) {} } return String((a && a.command) || ''); }).filter((cmd) => /(^|[;&|]\s*)(rm|mv|cp|touch|mkdir|tee)\b|>\s*\S/.test(cmd));
    return { steps, tokens, wallMs, stop, tools: calls.map((c) => c.name), writes, shellWrites };
  }

  const SEED = 'alpha\nbeta\n';
  // allowed = the paths an ask may write. Anything else is unrelated work.
  const ASKS = [
    { id: 'list',   text: 'list the files here',                          allowed: [] },
    { id: 'write',  text: 'write hi.txt containing hi',                   allowed: ['hi.txt'] },
    { id: 'read',   text: 'what is the first line of seed.txt?',          allowed: [] },
    { id: 'answer', text: 'what is 17 times 23? answer without using any tools', allowed: [] },
    { id: 'rename', text: 'rename seed.txt to seed2.txt',                 allowed: ['seed.txt', 'seed2.txt'] },
    { id: 'edit',   text: 'in seed.txt, change beta to gamma',            allowed: ['seed.txt'] }, // an exact unique old_string edits unread (2026-09-24), so the floor is 2 again
  ];
  const PRIOR = 'create notes.md with a heading "Notes" and three bullet points about Python';
  const STATES = ['fresh', 'finished', 'errored'];

  async function oneCase(ask, state) {
    await newTask();
    await T().fs.write('seed.txt', SEED);
    try { await T().fs.remove('hi.txt'); } catch (_) {} try { await T().fs.remove('seed2.txt'); } catch (_) {} try { await T().fs.remove('notes.md'); } catch (_) {}
    if (state === 'finished') await sendAndWait(PRIOR);
    if (state === 'errored') await sendAndWait(PRIOR, { abortAfterFirstCall: true });
    const r = await sendAndWait(ask.text);
    const m = await readRecord(r);
    const unrelated = m.writes.filter((p) => !ask.allowed.includes(String(p).replace(/^\.?\//, '')));
    const pass = state === 'fresh' ? (m.steps <= (ask.maxSteps || 2) && unrelated.length === 0) : unrelated.length === 0;
    return { ask: ask.id, state, pass, ...m, unrelated };
  }

  async function run({ asks = ASKS, states = STATES, project = 'battery-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '') } = {}) {
    if (!T()) throw new Error('Anvil test door is closed: set localStorage["anvil-test"]="1" on this origin and reload');
    await newProject(project);
    const rows = []; window.__batteryRows = rows;
    for (const state of states) for (const ask of asks) {
      try { const row = await oneCase(ask, state); rows.push(row); console.info('[battery]', JSON.stringify(row)); }
      catch (e) { const row = { ask: ask.id, state, pass: false, error: String(e && e.message || e) }; rows.push(row); console.warn('[battery]', JSON.stringify(row)); }
    }
    const passed = rows.filter((r) => r.pass).length;
    return { project, passed, total: rows.length, rows };
  }

  window.anvilBattery = { run, oneCase, ASKS, STATES, readRecord, records };
})();
