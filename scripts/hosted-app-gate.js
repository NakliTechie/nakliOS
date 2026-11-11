// Hosted acceptance gate for one mirrored app inside the real NakliOS host (docs/app-contract.md,
// "Minimum acceptance gate"; how to run it: docs/app-loading.md, "Onboarding a new app").
// Evaluate in the host page, in a FOREGROUND tab of the logged-in Chrome over the CDP daemon, after
//   window.__gateCfg = { id, write: { name, input, input2? }, read?: { name, input }, readExpect? }
// It uses the browser's private file system as a stand-in Folder named gate-<id>; delete it after.
// Results land in window.__gate. It covers gate items 3, 6, 7 and 8 plus load and the rail; items 2
// (Folder vs Crate), 4 (disconnect) and 9 (AI) need their own runs.
(async () => {
  const cfg = window.__gateCfg; const id = cfg.id;
  const out = { id, status: 'running', checks: {} };
  window.__gate = out;
  const ok = (k, pass, note) => { out.checks[k] = { pass, note }; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (t, l, ms = 30000) => { for (const e = Date.now() + ms; Date.now() < e; await sleep(100)) { try { const v = await t(); if (v) return v; } catch {} } throw new Error('timed out: ' + l); };
  const list = async (dir, p = '') => { const rows = []; for await (const [n, h] of dir.entries()) { if (h.kind === 'directory') rows.push(...await list(h, p + n + '/')); else rows.push(p + n); } return rows; };
  try {
    state.fsHandle = await (await navigator.storage.getDirectory()).getDirectoryHandle(`gate-${id}`, { create: true });
    state.appPermissions[id] = { backend: 'fsa', granted: true };
    broadcastCapabilities();
    const app = APPS.find(a => a.id === id);
    openApp(app);
    let frame = await wait(() => openWindows[id]?.querySelector('iframe'), 'window');
    const nak = await wait(() => frame.contentWindow?.naklios, 'SDK in frame');
    const dialogs = [];
    for (const k of ['alert', 'confirm', 'prompt']) frame.contentWindow[k] = (...a) => { dialogs.push(k + ': ' + String(a[0]).slice(0, 60)); return k === 'confirm' ? false : null; };
    const errors = []; frame.contentWindow.addEventListener('error', e => errors.push(String(e.message).slice(0, 120)));
    await wait(() => nak.capabilities?.fs, 'fs capability', 15000).catch(() => null);
    ok('load: same-origin window, no sandbox, fs granted', frame.getAttribute('sandbox') === null && !!nak.capabilities?.fs, `src ${frame.getAttribute('src')}, backend ${nak.capabilities?.fsBackend}`);
    await wait(() => frame.contentDocument?.readyState === 'complete', 'frame loaded');
    await sleep(1500);
    const bg = () => getComputedStyle(frame.contentDocument.body).backgroundColor;
    const bg1 = bg();
    // Theme: switch the host theme and see the app repaint.
    const before = state.theme || THEMES[0].id; const other = THEMES.find(t => t.id !== before).id;
    applyTheme(other);
    await sleep(1200); const bg2 = bg();
    applyTheme(before);
    await sleep(800);
    ok('theme: app repaints when the host theme changes (gate 8)', bg1 !== bg2, `${before} ${bg1} -> ${other} ${bg2}`);
    // Rail.
    const { catalog, face } = await hostAgentReady;
    const manifest = await (await fetch(`./apps/${id}/commands.json`, { cache: 'reload' })).json();
    await wait(() => catalog.describeCommand(`${id}.${manifest.commands[0].name}`), 'rail registration', 20000).catch(() => null);
    const missing = manifest.commands.map(c => c.name).filter(n => !catalog.describeCommand(`${id}.${n}`));
    ok('rail: every manifest command registered', missing.length === 0, `${manifest.commands.length - missing.length} of ${manifest.commands.length}${missing.length ? '; missing ' + missing.slice(0, 4).join(', ') : ''}`);
    let r; try { r = await face.invoke(`${id}.${cfg.write.name}`, cfg.write.input); } catch (e) { r = { error: String(e.message || e) }; }
    ok('rail: a write command runs', !!(r && r.ok !== false && !r.error), JSON.stringify(r).slice(0, 160));
    // Save: the change reaches storage, inside the app namespace.
    await sleep(4000);
    // The host keeps its own state.json at the Folder root; it is not the app's file.
    const files = (await list(state.fsHandle)).filter(f => f !== 'state.json');
    ok('save: the change is written to storage (gate 3)', files.length > 0, files.slice(0, 6).join(', '));
    ok('namespace: every file sits under apps/' + id + '/ (gate 6)', files.length > 0 && files.every(f => f.startsWith(`apps/${id}/`)), files.filter(f => !f.startsWith(`apps/${id}/`)).slice(0, 3).join(', '));
    // Immediate close after a second change, then reopen: the change survives (gate 3).
    try { await face.invoke(`${id}.${cfg.write.name}`, cfg.write.input2 || cfg.write.input); } catch {}
    const snap = JSON.stringify(await Promise.all(files.map(async f => { const parts = f.split('/'); let d = state.fsHandle; for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p); return (await (await d.getFileHandle(parts.at(-1))).getFile()).size; })));
    closeWindow(openWindows[id]);
    await wait(() => !openWindows[id], 'window closed', 15000).catch(() => null);
    await sleep(1500);
    const files2 = (await list(state.fsHandle)).filter(f => f !== 'state.json');
    const sizes2 = JSON.stringify(await Promise.all(files.map(async f => { try { const parts = f.split('/'); let d = state.fsHandle; for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p); return (await (await d.getFileHandle(parts.at(-1))).getFile()).size; } catch { return -1; } })));
    ok('close: a change made just before an immediate close is saved (gate 3)', sizes2 !== snap || files2.length > files.length, `sizes before close ${snap}, after ${sizes2}`);
    openApp(APPS.find(a => a.id === id));
    frame = await wait(() => openWindows[id]?.querySelector('iframe'), 'reopen');
    await wait(() => frame.contentWindow?.naklios?.capabilities?.fs, 'reopen fs', 15000).catch(() => null);
    await sleep(3000);
    let readBack; const readCmd = cfg.read; if (readCmd) { try { readBack = await face.invoke(`${id}.${readCmd.name}`, readCmd.input); } catch (e) { readBack = { error: String(e.message || e) }; } }
    ok('reopen: the saved work comes back', readCmd ? !!readBack && !readBack.error && (!cfg.readExpect || JSON.stringify(readBack).includes(cfg.readExpect)) : null, JSON.stringify(readBack).slice(0, 200));
    ok('dialogs: no native alert/confirm/prompt during the run (gate 7)', dialogs.length === 0, dialogs.join('; '));
    ok('errors: no uncaught error in the app window', errors.length === 0, errors.slice(0, 3).join('; '));
    out.files = await list(state.fsHandle);
    out.status = 'done';
  } catch (e) { out.error = String(e && e.message || e); out.status = 'done'; }
  return JSON.stringify(out);
})()
