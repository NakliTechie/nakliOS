// The NakliOS Browser: a host window for light browsing. It shows sites inside the desktop without the
// person's sign-ins (a credentialless frame, no cookies), through the companion extension in extension/ (design: plan/research/2026-11-10-browser-in-naklios-round2.md).
//
// The window is host code on purpose: the extension only answers the top frame of the desktop
// (frameId 0, path '/'), and frame.html only runs when the desktop frames it directly. Without the
// extension, or inside a nested desktop, an address opens in a new tab, as NakliOS did before.
//
// deps (from index.html):
//   makeWindow(opts) → the window element (with a .nw-body)
//   record(host, output) → appends one History event (host only, never the address)
//   notify(text) → a short message to the person

export const EXTENSION_HELP = 'Load the NakliOS Browser extension once (chrome://extensions → Developer mode → Load unpacked → the extension folder of the nakliOS repo) to show sites inside this window.';

/** What the person typed, as an address: adds https:// when no scheme is given. Returns a URL string or null. */
export function normaliseAddress(input) {
  const raw = String(input || '').trim();
  if (!raw || /\s/.test(raw)) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
  if (u.username || u.password) return null;
  return u.href;
}

/** True when this document is a desktop inside another desktop (the acceptance demo). */
export const isNested = (win = globalThis.window) => !!win && win.top !== win;

/**
 * Finds the companion extension: its content script answers a ping with its id. Resolves
 * { id, version } or null within `timeoutMs`.
 */
export function detectExtension({ win = window, timeoutMs = 800 } = {}) {
  if (isNested(win)) return Promise.resolve(null);
  return new Promise(resolve => {
    const done = value => { win.removeEventListener('message', on); clearTimeout(timer); resolve(value); };
    const on = e => {
      if (e.source !== win || e.origin !== win.location.origin) return;
      const d = e.data;
      if (d && d.type === 'nakli-browser:extension' && typeof d.id === 'string' && /^[a-p]{32}$/.test(d.id)) done({ id: d.id, version: String(d.version || '') });
    };
    win.addEventListener('message', on);
    const timer = setTimeout(() => done(null), timeoutMs);
    win.postMessage({ type: 'nakli-browser:ping' }, win.location.origin);
  });
}

function send(ext, msg, timeoutMs = 4000) {
  return new Promise(resolve => {
    const runtime = globalThis.chrome && globalThis.chrome.runtime;
    if (!runtime || typeof runtime.sendMessage !== 'function') return resolve({ ok: false, error: 'no-runtime' });
    const timer = setTimeout(() => resolve({ ok: false, error: 'timeout' }), timeoutMs);
    try {
      runtime.sendMessage(ext.id, msg, reply => {
        clearTimeout(timer);
        const err = runtime.lastError;
        resolve(err ? { ok: false, error: err.message } : (reply || { ok: false, error: 'no-reply' }));
      });
    } catch (e) { clearTimeout(timer); resolve({ ok: false, error: String(e.message || e) }); }
  });
}

const STYLE = `
.nb-bar{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--line,#0002);background:var(--panel,#f4f4f6)}
.nb-bar button{font:inherit;min-width:30px;height:28px;border-radius:6px;border:1px solid var(--line,#0002);background:var(--body,#fff);color:inherit;cursor:pointer}
.nb-bar button:disabled{opacity:.4;cursor:default}
.nb-bar input{flex:1;min-width:0;height:28px;border-radius:6px;border:1px solid var(--line,#0003);padding:0 8px;font:inherit;background:var(--body,#fff);color:inherit}
.nb-status{font-size:12px;opacity:.75;white-space:nowrap}
.nb-view{position:relative;flex:1;min-height:0}
.nb-view iframe{border:0;width:100%;height:100%;display:block;background:#fff}
.nb-note{padding:24px;max-width:36rem;line-height:1.5}
.nb-wrap{display:flex;flex-direction:column;height:100%}
`;

function ensureStyle(doc) {
  if (doc.getElementById('nb-style')) return;
  const s = doc.createElement('style');
  s.id = 'nb-style';
  s.textContent = STYLE;
  doc.head.appendChild(s);
}

/**
 * Opens (or focuses) the Browser window, optionally at `url`.
 * Returns { ok, mode: 'frame' | 'tab' | 'window', reason? }.
 */
export async function openBrowser(deps, { url = '', windowId = 'browser' } = {}) {
  const { makeWindow, record = () => {}, notify = () => {} } = deps;
  const target = url ? normaliseAddress(url) : null;
  if (url && !target) { notify('That is not a web address.'); return { ok: false, reason: 'bad-url' }; }
  // A desktop inside the Browser opens nothing deeper: depth one is by design.
  if (isNested()) {
    if (target) window.open(target, '_blank', 'noopener');
    return { ok: true, mode: 'tab', reason: 'nested' };
  }
  const doc = document;
  ensureStyle(doc);
  const win = makeWindow({ id: windowId, title: 'Browser', width: 980, height: 680 });
  if (!win._browser) win._browser = build(win, deps, windowId);
  if (target) await win._browser.go(target);
  return { ok: true, mode: win._browser.mode() };
}

function build(win, deps, windowId) {
  const { record = () => {}, notify = () => {} } = deps;
  const body = win.querySelector('.nw-body');
  body.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'nb-wrap';
  wrap.innerHTML = `
    <div class="nb-bar" role="toolbar" aria-label="Browser">
      <button type="button" data-act="back" aria-label="Back" disabled>←</button>
      <button type="button" data-act="forward" aria-label="Forward" disabled>→</button>
      <button type="button" data-act="reload" aria-label="Reload">↻</button>
      <input type="url" aria-label="Address" placeholder="Type an address, for example github.com" spellcheck="false" autocomplete="off">
      <button type="button" data-act="go">Go</button>
      <span class="nb-status" aria-live="polite"></span>
      <button type="button" data-act="tab" title="Sites show here without your sign-in. Open this one in a normal Chrome tab to use your account.">Open in Chrome</button>
    </div>
    <div class="nb-view"><div class="nb-note"></div></div>`;
  body.appendChild(wrap);
  const input = wrap.querySelector('input');
  const status = wrap.querySelector('.nb-status');
  const view = wrap.querySelector('.nb-view');
  const btn = act => wrap.querySelector(`[data-act="${act}"]`);
  let ext = null, frame = null, mode = 'window';

  const note = text => { view.innerHTML = '<div class="nb-note"></div>'; view.firstChild.textContent = text; frame = null; };
  note('Type an address to read a site here. Sites show without your sign-in; use Open in Chrome for your accounts.');

  const extReady = detectExtension().then(found => {
    ext = found;
    status.textContent = ext ? '' : 'extension not installed';
    if (!ext) note(EXTENSION_HELP);
    return ext;
  });

  const onMessage = e => {
    if (!frame || e.source !== frame.contentWindow || !ext || e.origin !== `chrome-extension://${ext.id}`) return;
    const m = e.data || {};
    if (m.type === 'nakli-browser:location') {
      input.value = m.url;
      btn('back').disabled = !m.canBack;
      btn('forward').disabled = !m.canForward;
      status.textContent = 'not signed in';
    } else if (m.type === 'nakli-browser:needs-open') {
      go(m.url, { fresh: true });
    } else if (m.type === 'nakli-browser:error') {
      status.textContent = m.error;
    }
  };
  window.addEventListener('message', onMessage);

  async function go(raw, { fresh = false } = {}) {
    const target = normaliseAddress(raw);
    if (!target) { notify('That is not a web address.'); return; }
    input.value = target;
    await extReady;
    if (!ext) {
      mode = 'tab';
      window.open(target, '_blank', 'noopener');
      note(`Opened ${new URL(target).hostname} in a new tab. ${EXTENSION_HELP}`);
      return;
    }
    // The same host in this window: the frame navigates without a new token.
    if (!fresh && frame && frame.dataset.host === new URL(target).hostname) {
      frame.contentWindow.postMessage({ type: 'nakli-browser:navigate', url: target }, `chrome-extension://${ext.id}`);
      return;
    }
    const r = await send(ext, { type: 'nakli-browser:open', url: target, windowId });
    if (!r.ok) { status.textContent = r.error; note(`The extension refused this open (${r.error}).`); return; }
    mode = 'frame';
    view.innerHTML = '';
    frame = document.createElement('iframe');
    frame.dataset.host = new URL(target).hostname;
    frame.setAttribute('allow', 'clipboard-write; fullscreen');
    frame.setAttribute('title', `Browser: ${frame.dataset.host}`);
    frame.src = `${r.frame}#t=${encodeURIComponent(r.token)}`;
    view.appendChild(frame);
    status.textContent = r.needsPermission ? 'asks Chrome for this site' : '';
    try { record(frame.dataset.host, { opened: true, needsPermission: !!r.needsPermission }); } catch (_) {}
  }

  const post = type => { if (frame && ext) frame.contentWindow.postMessage({ type }, `chrome-extension://${ext.id}`); };
  btn('back').onclick = () => post('nakli-browser:back');
  btn('forward').onclick = () => post('nakli-browser:forward');
  btn('reload').onclick = () => post('nakli-browser:reload');
  btn('go').onclick = () => go(input.value);
  btn('tab').onclick = () => { const u = normaliseAddress(input.value); if (u) window.open(u, '_blank', 'noopener'); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(input.value); });

  const prevClose = win._beforeClose;
  win._beforeClose = () => {
    try { prevClose?.(); } catch (_) {}
    window.removeEventListener('message', onMessage);
    if (ext) send(ext, { type: 'nakli-browser:closed', windowId });
  };
  return {
    go,
    back: () => post('nakli-browser:back'),
    forward: () => post('nakli-browser:forward'),
    reload: () => post('nakli-browser:reload'),
    mode: () => mode,
    state: () => ({ url: input.value, status: status.textContent, mode, extension: ext ? { version: ext.version } : null }),
  };
}

/** Settings → Browser: the extension's state and the sites it may reach, with a remove button each. */
export async function browserSettings() {
  const ext = await detectExtension();
  if (!ext) return { installed: false, sites: [] };
  const r = await send(ext, { type: 'nakli-browser:sites' });
  return { installed: true, version: ext.version, sites: r.ok ? r.sites : [], error: r.ok ? null : r.error,
    forget: pattern => send(ext, { type: 'nakli-browser:forget', pattern }) };
}
