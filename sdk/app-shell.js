/*
 * app-shell.js — the NakliOS app shell, layer 1. @naklios-app-shell-version 1 (spec: docs/specs/app-shell-001.md).
 *
 * One title row (AutoSave, Quick Access: Save, Undo, Redo; the document name, its unsaved dot and where it is
 * saved; an app slot), the File page (New, Open with Recent, Save, Save as, Export, Print), one save and open
 * model, and the core keymap. Apps inline this file between markers, the way they inline the SDK:
 *
 *   /* naklios-app-shell:begin ver=N sha256=… *\/  …  /* naklios-app-shell:end *\/
 *
 * and refresh it with `node scripts/vendor-naklios-sdk.mjs --name app-shell`.
 *
 * The shell never edits a document. The app hands it blank(), serialize() and load(); the shell decides where the
 * bytes go. A document always has a home: NakliOS storage when hosted, this browser (OPFS) standalone, a file on
 * this computer after "This computer…", or a location the app supplies (an existing folder). The file is created on
 * the first change, so an untouched new document leaves nothing behind.
 *
 * CSS goes through a constructed stylesheet (adoptedStyleSheets), so a hash-only style-src CSP needs nothing new.
 * Colours, font and spacing read --shell-* custom properties, which each app maps to its own tokens.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.naklishell) return;

  var VERSION = 1;
  var isMac = /mac|iphone|ipad|ipod/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent);
  var MOD = isMac ? 'Cmd' : 'Ctrl';
  var nak = function () { return window.naklios; };
  var hostedFs = function () { var n = nak(); return !!(n && n.capabilities && n.capabilities.hosted && n.capabilities.fs && n.fs); };

  // ---------------------------------------------------------------- keymap (spec section 5.1)
  // keys: 'Mod' is Cmd on a Mac and Ctrl elsewhere; 'Ctrl' is Ctrl everywhere. Letters and digits match on
  // event.code, so Alt on a Mac (which changes event.key) still matches.
  var CORE_KEYS = [
    { name: 'file.save', keys: ['Mod+S'], label: 'Save' },
    { name: 'file.save_as', keys: ['Mod+Shift+S'], label: 'Save as' },
    { name: 'file.open', keys: ['Mod+O'], label: 'Open' },
    { name: 'file.new', keys: ['Mod+Alt+N', 'Mod+N'], label: 'New' },
    { name: 'file.print', keys: ['Mod+P'], label: 'Print' },
    { name: 'edit.undo', keys: ['Mod+Z'], label: 'Undo' },
    { name: 'edit.redo', keys: ['Mod+Y', 'Mod+Shift+Z'], label: 'Redo' },
    { name: 'edit.find', keys: ['Mod+F'], label: 'Find' },
    { name: 'edit.replace', keys: [isMac ? 'Ctrl+H' : 'Mod+H'], label: 'Replace' },
    { name: 'app.palette', keys: ['Mod+Shift+P', 'Alt+Q'], label: 'Search commands' },
    { name: 'app.help', keys: ['F1'], label: 'Help' },
  ];
  var FILE_COMMANDS = { 'file.save': 1, 'file.save_as': 1, 'file.open': 1, 'file.new': 1, 'file.print': 1 };

  function parseKey(spec) {
    var parts = spec.split('+'), k = { mod: false, ctrl: false, shift: false, alt: false, key: parts.pop() };
    parts.forEach(function (p) { if (p === 'Mod') k.mod = true; else if (p === 'Ctrl') k.ctrl = true; else if (p === 'Shift') k.shift = true; else if (p === 'Alt') k.alt = true; });
    return k;
  }
  function keyMatches(spec, e) {
    var k = parseKey(spec);
    var wantMeta = isMac && k.mod, wantCtrl = (!isMac && k.mod) || k.ctrl;
    if (!!e.metaKey !== wantMeta || !!e.ctrlKey !== wantCtrl || !!e.shiftKey !== k.shift || !!e.altKey !== k.alt) return false;
    if (/^[A-Z]$/.test(k.key)) return e.code === 'Key' + k.key;
    if (/^[0-9]$/.test(k.key)) return e.code === 'Digit' + k.key;
    return e.key === k.key;
  }
  function keyLabel(spec) {
    return spec.split('+').map(function (p) { return p === 'Mod' ? MOD : (isMac && p === 'Alt' ? 'Option' : p); }).join('+');
  }
  function shortcutOf(name) { var c = CORE_KEYS.filter(function (x) { return x.name === name; })[0]; return c ? c.keys[0] : ''; }
  function tip(label, name) { var s = shortcutOf(name); return s ? label + ' (' + keyLabel(s) + ')' : label; }

  // ---------------------------------------------------------------- small DOM helper (no innerHTML with styles)
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (a) {
      var v = attrs[a];
      if (v == null || v === false) return;
      if (a === 'text') el.textContent = v;
      else if (a.slice(0, 2) === 'on') el.addEventListener(a.slice(2), v);
      else el.setAttribute(a, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c != null) el.append(c); });
    return el;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(d) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); s.append(p);
    return s;
  }
  var ICON = {
    save: 'M3 2h8l3 3v9H2V2h1zm1 1v4h7V3H4zm1 1h2v2H5V4zM4 9v4h8V9H4z',
    undo: 'M5 4 1.5 7.5 5 11V8.5h5a2.5 2.5 0 0 1 0 5H8v1.5h2a4 4 0 0 0 0-8H5V4z',
    redo: 'M11 4l3.5 3.5L11 11V8.5H6a2.5 2.5 0 0 0 0 5h2v1.5H6a4 4 0 0 1 0-8h5V4z',
    help: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm0 10.2a.9.9 0 1 1 0 1.8.9.9 0 0 1 0-1.8zM8 3.8c1.5 0 2.6.9 2.6 2.2 0 1-.6 1.5-1.2 1.9-.5.3-.7.5-.7 1v.4H7.3v-.5c0-.9.4-1.4 1.1-1.8.5-.3.8-.5.8-.9 0-.5-.5-.8-1.1-.8-.7 0-1.2.4-1.3 1H5.4C5.5 4.8 6.5 3.8 8 3.8z',
    back: 'M7 3 2 8l5 5V9h7V7H7V3z',
  };

  // ---------------------------------------------------------------- styles
  var CSS = [
    ':root{--shell-title-h:36px}',
    '.nsh-title{position:relative;z-index:40;display:flex;align-items:center;gap:4px;height:var(--shell-title-h);padding:0 8px;box-sizing:border-box;',
    'background:var(--shell-chrome,var(--shell-canvas,#fff));color:var(--shell-ink,#1d1d1f);border-bottom:1px solid var(--shell-line,rgba(0,0,0,.12));',
    'font:13px/1.2 var(--shell-font,system-ui,-apple-system,"Segoe UI",sans-serif);user-select:none;flex:none}',
    '.nsh-title button,.nsh-bs button{font:inherit;color:inherit}',
    '.nsh-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:28px;height:28px;padding:0 6px;border:0;border-radius:6px;background:transparent;cursor:pointer}',
    '.nsh-btn:hover:not(:disabled){background:var(--shell-hover,rgba(0,0,0,.06))}',
    '.nsh-btn:focus-visible,.nsh-name:focus-visible,.nsh-bs :focus-visible,.nsh-dlg :focus-visible{outline:2px solid var(--shell-accent,#2563eb);outline-offset:1px}',
    '.nsh-btn:disabled{opacity:.38;cursor:default}',
    '.nsh-btn svg{fill:currentColor}',
    '.nsh-file{font-weight:600;padding:0 10px;background:var(--shell-accent,#2563eb);color:var(--shell-on-accent,#fff)!important}',
    '.nsh-file:hover{filter:brightness(1.08);background:var(--shell-accent,#2563eb)!important}',
    '.nsh-auto{display:inline-flex;align-items:center;gap:6px;padding:0 6px;color:var(--shell-muted,rgba(0,0,0,.6));cursor:pointer}',
    '.nsh-auto input{margin:0;accent-color:var(--shell-accent,#2563eb)}',
    '.nsh-sep{width:1px;height:18px;margin:0 4px;background:var(--shell-line,rgba(0,0,0,.12))}',
    '.nsh-mid{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;gap:8px}',
    '.nsh-name{max-width:40ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;border-radius:6px;background:transparent;padding:4px 6px;font-weight:600;cursor:text}',
    '.nsh-name:hover{background:var(--shell-hover,rgba(0,0,0,.06))}',
    '.nsh-name-input{font:inherit;font-weight:600;width:28ch;padding:3px 6px;border:1px solid var(--shell-accent,#2563eb);border-radius:6px;background:var(--shell-canvas,#fff);color:inherit}',
    '.nsh-dot{width:8px;height:8px;border-radius:50%;background:var(--shell-accent,#2563eb);flex:none}',
    '.nsh-dot[hidden]{display:none}',
    '.nsh-where{color:var(--shell-muted,rgba(0,0,0,.6));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34ch}',
    '.nsh-where.nsh-err{color:var(--shell-danger,#b42318)}',
    '.nsh-slot{display:flex;align-items:center;gap:4px}',
    '@media (max-width:600px){.nsh-where,.nsh-auto span{display:none}.nsh-name{max-width:16ch}}',
    // File page (Backstage)
    '.nsh-bs{position:fixed;left:0;right:0;bottom:0;top:var(--shell-title-h);z-index:1000;display:flex;background:var(--shell-canvas,#fff);color:var(--shell-ink,#1d1d1f);',
    'font:14px/1.4 var(--shell-font,system-ui,-apple-system,"Segoe UI",sans-serif)}',
    '.nsh-bs[hidden]{display:none}',
    '.nsh-bs-nav{flex:none;width:200px;display:flex;flex-direction:column;gap:2px;padding:12px 8px;background:var(--shell-accent,#2563eb);color:var(--shell-on-accent,#fff)}',
    '.nsh-bs-nav button{display:flex;align-items:center;gap:10px;height:36px;padding:0 12px;border:0;border-radius:6px;background:transparent;cursor:pointer;text-align:left}',
    '.nsh-bs-nav button:hover{background:rgba(255,255,255,.14)}',
    '.nsh-bs-nav button[aria-current="page"]{background:rgba(255,255,255,.24);font-weight:600}',
    '.nsh-bs-nav svg{fill:currentColor}',
    '.nsh-bs-nav kbd{margin-left:auto;font:inherit;font-size:11px;opacity:.75}',
    '.nsh-bs-page{flex:1;min-width:0;overflow:auto;padding:28px 40px}',
    '.nsh-bs-page h2{margin:0 0 16px;font-size:24px;font-weight:600}',
    '.nsh-bs-page h3{margin:24px 0 8px;font-size:13px;font-weight:600;color:var(--shell-muted,rgba(0,0,0,.6))}',
    '.nsh-list{display:flex;flex-direction:column;max-width:720px}',
    '.nsh-row{display:flex;align-items:baseline;gap:12px;width:100%;min-height:40px;padding:8px 12px;border:0;border-radius:6px;background:transparent;cursor:pointer;text-align:left}',
    '.nsh-row:hover{background:var(--shell-hover,rgba(0,0,0,.06))}',
    '.nsh-row b{font-weight:600}',
    '.nsh-row small{margin-left:auto;color:var(--shell-muted,rgba(0,0,0,.6));white-space:nowrap}',
    '.nsh-empty{color:var(--shell-muted,rgba(0,0,0,.6));padding:8px 12px}',
    '.nsh-tiles{display:flex;flex-wrap:wrap;gap:12px}',
    '.nsh-tile{width:150px;height:96px;display:flex;align-items:flex-end;padding:10px;border:1px solid var(--shell-line,rgba(0,0,0,.12));border-radius:8px;background:var(--shell-canvas,#fff);cursor:pointer;text-align:left}',
    '.nsh-tile:hover{border-color:var(--shell-accent,#2563eb)}',
    '.nsh-cmd{display:inline-flex;align-items:center;height:32px;padding:0 14px;border:1px solid var(--shell-line,rgba(0,0,0,.18));border-radius:6px;background:var(--shell-canvas,#fff);cursor:pointer}',
    '.nsh-cmd:hover{background:var(--shell-hover,rgba(0,0,0,.06))}',
    '.nsh-primary{background:var(--shell-accent,#2563eb);border-color:var(--shell-accent,#2563eb);color:var(--shell-on-accent,#fff)}',
    '.nsh-primary:hover{filter:brightness(1.08);background:var(--shell-accent,#2563eb)}',
    '@media (max-width:600px){.nsh-bs{flex-direction:column}.nsh-bs-nav{width:auto;flex-direction:row;overflow:auto}.nsh-bs-nav kbd{display:none}.nsh-bs-page{padding:16px}}',
    // dialogs
    '.nsh-dlg{border:1px solid var(--shell-line,rgba(0,0,0,.12));border-radius:10px;padding:20px;min-width:320px;max-width:min(480px,92vw);background:var(--shell-canvas,#fff);color:var(--shell-ink,#1d1d1f);',
    'font:14px/1.4 var(--shell-font,system-ui,-apple-system,"Segoe UI",sans-serif)}',
    '.nsh-dlg::backdrop{background:rgba(0,0,0,.28)}',
    '.nsh-dlg h2{margin:0 0 12px;font-size:16px;font-weight:600}',
    '.nsh-dlg p{margin:0 0 12px}',
    '.nsh-dlg label{display:block;margin:0 0 12px}',
    '.nsh-dlg input[type=text]{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;font:inherit;border:1px solid var(--shell-line,rgba(0,0,0,.24));border-radius:6px;background:var(--shell-canvas,#fff);color:inherit}',
    '.nsh-dlg fieldset{border:0;margin:0 0 12px;padding:0}',
    '.nsh-dlg legend{padding:0;margin-bottom:4px;font-weight:600}',
    '.nsh-dlg fieldset label{display:flex;gap:8px;align-items:center;margin:4px 0}',
    '.nsh-dlg .nsh-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
    '@media print{.nsh-title,.nsh-bs{display:none!important}}',
  ].join('\n');

  function installCss() {
    try {
      var sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
    } catch (_) {
      document.head.append(h('style', { text: CSS }));
    }
  }

  // ---------------------------------------------------------------- storage: NakliOS, this browser, this computer
  function toBytes(data) {
    if (typeof data === 'string') return Promise.resolve(data);
    if (data instanceof Uint8Array) return Promise.resolve(data);
    if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
    if (data && typeof data.arrayBuffer === 'function') {
      if (/^text\/|json/.test(data.type || '')) return data.text();
      return data.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    }
    return Promise.resolve(String(data));
  }
  function toBlob(data, type) {
    if (data instanceof Blob) return data;
    return new Blob([data], { type: type || 'application/octet-stream' });
  }
  function fileNameOf(p) { return String(p).split('/').pop(); }
  function listNames(entries) {
    return (entries || []).map(function (e) { return typeof e === 'string' ? e : (e.path || e.name || ''); }).filter(Boolean);
  }

  var NakliStore = {
    id: 'naklios', label: 'NakliOS storage',
    available: hostedFs,
    list: function (folder) { return nak().fs.list(folder).then(listNames).catch(function () { return []; }); },
    read: function (path, binary) {
      var fs = nak().fs;
      if (binary && fs.readBinary) {
        return fs.readBinary(path).then(function (r) {
          var bytes = r && (r.bytes || r.data) ? (r.bytes || r.data) : r;
          return new File([bytes], fileNameOf(path));
        });
      }
      return fs.read(path).then(function (t) { return new File([typeof t === 'string' ? t : (t && t.data) || ''], fileNameOf(path)); });
    },
    write: function (path, data) { return toBytes(data).then(function (b) { return nak().fs.write(path, b); }); },
    remove: function (path) { return nak().fs.delete(path); },
  };

  function opfsDir(appId, folder, create) {
    return navigator.storage.getDirectory().then(function (root) {
      return root.getDirectoryHandle('naklishell-' + appId, { create: create });
    }).then(function (d) {
      return folder ? d.getDirectoryHandle(folder, { create: create }) : d;
    });
  }
  function makeBrowserStore(appId) {
    return {
      id: 'browser', label: 'This browser',
      available: function () { return !!(navigator.storage && navigator.storage.getDirectory) && !hostedFs(); },
      list: function (folder) {
        return opfsDir(appId, folder, false).then(function (d) {
          var out = [], it = d.values();
          function step() { return it.next().then(function (r) { if (r.done) return out; if (r.value.kind === 'file') out.push(folder + '/' + r.value.name); return step(); }); }
          return step();
        }).catch(function () { return []; });
      },
      read: function (path) {
        var parts = path.split('/'), name = parts.pop();
        return opfsDir(appId, parts.join('/'), false).then(function (d) { return d.getFileHandle(name); }).then(function (fh) { return fh.getFile(); });
      },
      write: function (path, data) {
        var parts = path.split('/'), name = parts.pop();
        return opfsDir(appId, parts.join('/'), true).then(function (d) { return d.getFileHandle(name, { create: true }); })
          .then(function (fh) { return fh.createWritable(); })
          .then(function (w) { return w.write(toBlob(data)).then(function () { return w.close(); }); });
      },
      remove: function (path) {
        var parts = path.split('/'), name = parts.pop();
        return opfsDir(appId, parts.join('/'), false).then(function (d) { return d.removeEntry(name); });
      },
    };
  }

  var canPickSave = function () {
    if (typeof window.showSaveFilePicker !== 'function') return false;
    try { return window.top === window; } catch (_) { return false; }
  };
  var canPickOpen = function () {
    if (typeof window.showOpenFilePicker !== 'function') return false;
    try { return window.top === window; } catch (_) { return false; }
  };
  function ensurePermission(handle) {
    if (!handle.queryPermission) return Promise.resolve(true);
    return handle.queryPermission({ mode: 'readwrite' }).then(function (p) {
      if (p === 'granted') return true;
      return handle.requestPermission({ mode: 'readwrite' }).then(function (q) { return q === 'granted'; });
    });
  }
  function download(name, blob) {
    var a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }

  // ---------------------------------------------------------------- Recent (IndexedDB, per app)
  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('naklishell', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('recent'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var r = db.transaction('recent').objectStore('recent').get(key);
        r.onsuccess = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); };
      });
    });
  }
  function idbPut(key, value) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('recent', 'readwrite'); tx.objectStore('recent').put(value, key);
        tx.oncomplete = function () { resolve(); }; tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ---------------------------------------------------------------- the shell
  function mount(opts) {
    if (!opts || !opts.app || !opts.doc) throw new Error('naklishell.mount needs { app, doc }');
    var app = Object.assign({ folder: 'documents', binary: false, docNoun: 'document' }, opts.app);
    if (!app.id || !app.name || !app.ext) throw new Error('naklishell.mount: app needs id, name and ext');
    var doc = opts.doc;
    var commands = opts.commands || {};
    var browserStore = makeBrowserStore(app.id);
    var extraStores = (opts.locations || []).slice();
    var recentKey = 'recent:' + app.id;
    var autoKey = 'naklishell:autosave:' + app.id;
    var listeners = [];

    var st = {
      name: '', home: null, dirty: false, gen: 0, savedGen: 0, saving: null, savedAt: null,
      error: '', autosave: true, note: '',
    };
    try { st.autosave = localStorage.getItem(autoKey) !== 'off'; } catch (_) {}
    if (typeof opts.autosave === 'boolean') st.autosave = opts.autosave; // a test run or an app setting; not stored

    // A location with replaces: 'browser' stands in for the built-in browser store (an app's existing library).
    function replaced(id) { return extraStores.some(function (x) { try { return x.replaces === id && x.available(); } catch (_) { return false; } }); }
    function stores() { return [NakliStore, browserStore].concat(extraStores).filter(function (s) { if (replaced(s.id)) return false; try { return s.available(); } catch (_) { return false; } }); }
    function storeById(id) { return [NakliStore, browserStore].concat(extraStores).filter(function (s) { return s.id === id; })[0]; }
    function defaultStore() {
      if (hostedFs()) return NakliStore;
      var sub = extraStores.filter(function (x) { try { return x.replaces === 'browser' && x.available(); } catch (_) { return false; } })[0];
      return sub || browserStore;
    }
    function baseName(n) { return String(n || '').replace(new RegExp(app.ext.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'), ''); }
    function cleanName(n) { return String(n || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120); }
    function untitled() { return 'Untitled ' + app.docNoun; }

    // ---- title row
    var autoBox = h('input', { type: 'checkbox', 'aria-label': 'AutoSave' });
    autoBox.checked = st.autosave;
    autoBox.addEventListener('change', function () {
      st.autosave = autoBox.checked;
      try { localStorage.setItem(autoKey, st.autosave ? 'on' : 'off'); } catch (_) {}
      if (st.autosave && st.dirty) save().catch(function () {});
      render();
    });
    var fileBtn = h('button', { class: 'nsh-btn nsh-file', type: 'button', title: 'File: New, Open, Save as, Export, Print', 'aria-haspopup': 'true', text: 'File', onclick: function () { showBackstage('open'); } });
    var saveBtn = h('button', { class: 'nsh-btn', type: 'button', title: tip('Save', 'file.save'), 'aria-label': 'Save', onclick: function () { runCmd('file.save'); } }, [icon(ICON.save)]);
    var undoBtn = h('button', { class: 'nsh-btn', type: 'button', title: tip('Undo', 'edit.undo'), 'aria-label': 'Undo', onclick: function () { runCmd('edit.undo'); } }, [icon(ICON.undo)]);
    var redoBtn = h('button', { class: 'nsh-btn', type: 'button', title: tip('Redo', 'edit.redo'), 'aria-label': 'Redo', onclick: function () { runCmd('edit.redo'); } }, [icon(ICON.redo)]);
    var nameBtn = h('button', { class: 'nsh-name', type: 'button', title: 'Rename', onclick: startRename });
    var dot = h('span', { class: 'nsh-dot', title: 'Unsaved changes', role: 'img', 'aria-label': 'Unsaved changes' });
    var where = h('span', { class: 'nsh-where', 'aria-live': 'polite' });
    var slot = h('div', { class: 'nsh-slot' });
    var helpBtn = commands['app.help'] ? h('button', { class: 'nsh-btn', type: 'button', title: tip('Help and shortcuts', 'app.help'), 'aria-label': 'Help', onclick: function () { runCmd('app.help'); } }, [icon(ICON.help)]) : null;
    var title = h('header', { class: 'nsh-title', role: 'banner', 'aria-label': app.name + ' title bar' }, [
      fileBtn,
      h('label', { class: 'nsh-auto', title: 'AutoSave: save every change to where this ' + app.docNoun + ' lives' }, [autoBox, h('span', { text: 'AutoSave' })]),
      h('span', { class: 'nsh-sep' }),
      saveBtn, undoBtn, redoBtn,
      h('div', { class: 'nsh-mid' }, [nameBtn, dot, where]),
      slot, helpBtn,
    ]);
    if (opts.slot) [].concat(opts.slot).forEach(function (n) { slot.append(n); });
    if (!commands['edit.undo']) undoBtn.hidden = true;
    if (!commands['edit.redo']) redoBtn.hidden = true;

    function startRename() {
      var input = h('input', { class: 'nsh-name-input', type: 'text', 'aria-label': 'Name', value: st.name });
      var done = false;
      function finish(commit) {
        if (done) return; done = true;
        input.replaceWith(nameBtn);
        if (commit) rename(input.value).catch(function (e) { setError(e); });
        nameBtn.focus();
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
        e.stopPropagation();
      });
      input.addEventListener('blur', function () { finish(true); });
      nameBtn.replaceWith(input); input.focus(); input.select();
    }

    function timeText(d) { return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''; }
    function whereText() {
      if (st.error) return (st.errorKind === 'open' ? 'Could not open: ' : st.errorKind === 'export' ? 'Could not export: ' : 'Not saved: ') + st.error;
      if (st.saving) return 'Saving…';
      if (st.note) return st.note;
      if (!st.home) return 'Not saved yet';
      var label = st.home.kind === 'computer' ? 'this computer (' + st.home.fileName + ')' : (storeById(st.home.kind) || { label: st.home.kind }).label;
      if (st.dirty) return st.autosave ? 'Saving soon to ' + label : 'Changes not saved to ' + label;
      return st.savedAt ? 'Saved to ' + label + ', ' + timeText(st.savedAt) : 'In ' + label;
    }
    function render() {
      nameBtn.textContent = st.name;
      nameBtn.title = 'Rename ' + st.name;
      dot.hidden = !st.dirty;
      where.textContent = whereText();
      where.classList.toggle('nsh-err', !!st.error);
      var full = (st.dirty ? '● ' : '') + st.name + ' — ' + app.name;
      document.title = full;
      try { var n = nak(); if (n && n.title) n.title(full); } catch (_) {}
      if (typeof opts.state === 'function') {
        try { var s = opts.state() || {}; if ('canUndo' in s) undoBtn.disabled = !s.canUndo; if ('canRedo' in s) redoBtn.disabled = !s.canRedo; } catch (_) {}
      }
      listeners.forEach(function (fn) { try { fn(api.info()); } catch (_) {} });
    }
    function setError(e, kind) {
      if (e && e.name === 'AbortError') return;
      st.error = (e && e.message) || String(e);
      st.errorKind = kind || 'save';
      render();
    }

    // ---- saving
    // A location may keep its own folder (location.folder); '' means its top level.
    function folderOf(kind) { var s0 = storeById(kind); return s0 && typeof s0.folder === 'string' ? s0.folder : app.folder; }
    function pathFor(name, kind) { var f = folderOf(kind || (st.home && st.home.kind) || defaultStore().id); return (f ? f + '/' : '') + name + app.ext; }
    // reason: 'save' (the person or an agent asked), 'autosave' (a timer or the host's close flush), 'save_as'.
    function writeHome(home, reason) {
      return Promise.resolve(doc.serialize({ reason: reason || 'save' })).then(function (data) {
        if (home.kind === 'computer') {
          return ensurePermission(home.handle).then(function (ok) {
            if (!ok) throw new Error('this browser no longer has permission to write ' + home.fileName);
            return home.handle.createWritable().then(function (w) { return w.write(toBlob(data, app.mime)).then(function () { return w.close(); }); });
          });
        }
        var store = storeById(home.kind);
        if (!store) throw new Error('the location "' + home.kind + '" is not available here');
        return store.write(home.path, data);
      });
    }
    var timer = null;
    function scheduleAutosave() {
      clearTimeout(timer); timer = null;
      if (!st.autosave) return;
      timer = setTimeout(function () { timer = null; save('autosave').catch(function () {}); }, 1000);
    }
    // A free name in a store's folder: "Name", then "Name 2", "Name 3"…
    function freeName(store, name) {
      return Promise.resolve(store.list(folderOf(store.id))).catch(function () { return []; }).then(function (paths) {
        var taken = {};
        paths.forEach(function (p) { taken[fileNameOf(p).toLowerCase()] = true; });
        var n = name, i = 2;
        while (taken[(n + app.ext).toLowerCase()]) n = name + ' ' + i++;
        return n;
      });
    }
    function exists(store, path) {
      return Promise.resolve(store.list(folderOf(store.id))).catch(function () { return []; }).then(function (paths) {
        var want = fileNameOf(path).toLowerCase();
        return paths.some(function (p) { return fileNameOf(p).toLowerCase() === want; });
      });
    }
    // Save to the home now. A document with no home gets one in the default store, under a name not yet taken.
    function save(reason) {
      clearTimeout(timer); timer = null;
      if (st.saving) return st.saving.then(function () { return st.dirty || reason !== 'autosave' ? save(reason) : undefined; });
      if (!st.home) {
        var store = defaultStore();
        st.saving = freeName(store, st.name).then(function (n) {
          st.name = n; st.home = { kind: store.id, path: pathFor(n, store.id) };
        }).finally(function () { st.saving = null; });
        return st.saving.then(function () { return save(reason); });
      }
      var g = st.gen, home = st.home;
      st.error = ''; st.errorKind = ''; st.note = '';
      st.saving = writeHome(home, reason).then(function () {
        if (g > st.savedGen) st.savedGen = g;
        st.dirty = st.gen > st.savedGen;
        st.savedAt = new Date();
        reportDirty();
        addRecent();
      }, function (e) { setError(e); throw e; }).finally(function () {
        st.saving = null; render();
        if (st.dirty && !st.error) scheduleAutosave();
      });
      render();
      return st.saving;
    }
    // Save as: ask for a name and a location; the copy becomes the home.
    // preset { name, kind, replace, quiet }: with quiet and a name (an agent call), no dialog runs; kind defaults to the
    // default store, 'computer' is refused (it needs a person's picker), and a name clash fails unless replace is true.
    function saveAs(preset) {
      var quiet = !!(preset && preset.quiet && preset.name);
      if (quiet && preset.kind === 'computer') return Promise.reject(new Error('saving to this computer needs a person to pick the file'));
      var ask = quiet ? Promise.resolve({ name: preset.name, kind: preset.kind || (st.home && st.home.kind !== 'computer' ? st.home.kind : defaultStore().id) }) : dialogSaveAs(preset);
      return ask.then(function (choice) {
        if (!choice) return false;
        var name = cleanName(choice.name) || st.name;
        if (choice.kind === 'computer') {
          var suggested = name + app.ext;
          if (!canPickSave()) {
            return Promise.resolve(doc.serialize({ reason: 'save_as' })).then(function (data) {
              download(suggested, toBlob(data, app.mime));
              st.note = 'Downloaded a copy (' + suggested + ')'; render();
              return true;
            });
          }
          return window.showSaveFilePicker({ suggestedName: suggested, types: app.mime ? [{ description: app.name + ' ' + app.docNoun, accept: (function () { var o = {}; o[app.mime] = [app.ext.slice(app.ext.lastIndexOf('.'))]; return o; })() }] : undefined })
            .then(function (handle) {
              st.name = baseName(handle.name) || name;
              st.home = { kind: 'computer', handle: handle, fileName: handle.name };
              st.gen++;
              return save().then(function () { return true; });
            }, function (e) { if (e && e.name === 'AbortError') return false; throw e; });
        }
        if (replaced(choice.kind)) choice.kind = extraStores.filter(function (x) { return x.replaces === choice.kind; })[0].id;
        var target = { kind: choice.kind, path: pathFor(name, choice.kind) };
        var same = st.home && st.home.kind === target.kind && st.home.path === target.path;
        var store = storeById(choice.kind);
        if (!store || !store.available()) return Promise.reject(new Error('the location "' + choice.kind + '" is not available here'));
        return (same ? Promise.resolve(false) : exists(store, target.path)).then(function (clash) {
          if (!clash) return 'replace';
          if (quiet) { if (preset.replace) return 'replace'; throw new Error('"' + name + '" already exists in ' + store.label + '; pass replace: true to overwrite it'); }
          return dialog({ title: 'Replace "' + name + '"?', body: 'A ' + app.docNoun + ' with this name is already in ' + store.label + '. Replacing it overwrites it.',
            buttons: [{ value: 'cancel', label: 'Cancel' }, { value: 'replace', label: 'Replace', primary: true }] });
        }).then(function (v) {
          if (v !== 'replace') return false;
          st.name = name; st.home = target; st.gen++;
          return save('save_as').then(function () { return true; });
        });
      }).catch(function (e) { setError(e); if (quiet) throw e; return false; });
    }
    function rename(newName) {
      var name = cleanName(newName);
      if (!name || name === st.name) return Promise.resolve();
      var old = st.home;
      st.name = name;
      if (!old || old.kind === 'computer') { if (old) st.note = 'Renamed here; the file on this computer keeps its name'; render(); return Promise.resolve(); }
      st.home = { kind: old.kind, path: pathFor(name, old.kind) };
      st.gen++;
      if (typeof doc.rename === 'function') { try { doc.rename(name); } catch (_) {} }
      return save().then(function () {
        var store = storeById(old.kind);
        if (store && store.remove && old.path !== st.home.path) return store.remove(old.path).catch(function () {});
      });
    }
    function reportDirty() {
      // The SDK's autosave saver reports unsaved state to the host and flushes on hide and close.
      if (saver) { if (st.dirty) saver.markDirty(); }
    }
    var saver = null;
    try {
      var n0 = nak();
      if (n0 && n0.fs && typeof n0.fs.autosave === 'function') {
        // On hide and close the SDK flushes this saver; a document with a home is then saved even with AutoSave off.
        saver = n0.fs.autosave({ delay: 1000, save: function () { return st.dirty && (st.autosave || st.home) ? save('autosave') : Promise.resolve(); } });
      }
    } catch (_) { saver = null; }
    window.addEventListener('beforeunload', function (e) {
      if (!st.dirty || (st.autosave && st.home)) return;
      if (saver) return; // the SDK guards the close
      e.preventDefault(); e.returnValue = '';
    });

    // ---- Recent
    function recentEntry() {
      var h0 = st.home; if (!h0) return null;
      return { id: h0.kind + ':' + (h0.path || h0.fileName), name: st.name, kind: h0.kind, path: h0.path || null, handle: h0.handle || null, fileName: h0.fileName || null, at: Date.now() };
    }
    function getRecent() { return idbGet(recentKey).then(function (v) { return Array.isArray(v) ? v : []; }).catch(function () { return memRecent; }); }
    var memRecent = [];
    function addRecent() {
      var e = recentEntry(); if (!e) return;
      getRecent().then(function (list) {
        list = [e].concat(list.filter(function (x) { return x.id !== e.id; })).slice(0, 12);
        memRecent = list;
        return idbPut(recentKey, list);
      }).catch(function () {});
    }

    // ---- unsaved-changes guard before New and Open
    function settle() {
      if (!st.dirty) return Promise.resolve(true);
      if (st.autosave && st.home) return save().then(function () { return true; }, function () { return askUnsaved(); });
      return askUnsaved();
    }
    function askUnsaved() {
      return dialog({
        title: 'Save changes to "' + st.name + '"?',
        body: 'If you don\'t save, your changes since the last save are lost.',
        buttons: [{ value: 'cancel', label: 'Cancel' }, { value: 'discard', label: 'Don\'t save' }, { value: 'save', label: 'Save', primary: true }],
      }).then(function (v) {
        if (v === 'discard') return true;
        if (v === 'save') return (st.home ? save().then(function () { return true; }) : saveAs()).catch(function () { return false; });
        return false;
      });
    }

    // ---- New, Open, Export, Print
    function newDoc(template) {
      return settle().then(function (ok) {
        if (!ok) return false;
        return Promise.resolve(template && template.make ? template.make() : doc.blank()).then(function () {
          setDocument({ name: cleanName(template && (template.name || template.label)) || untitled(), home: null });
          return true;
        });
      }).catch(function (e) { setError(e); return false; });
    }
    function setDocument(o) {
      clearTimeout(timer); timer = null;
      st.name = o.name; st.home = o.home; st.gen = 0; st.savedGen = 0; st.dirty = false; st.error = ''; st.note = '';
      st.savedAt = o.home ? new Date() : null;
      hideBackstage();
      render();
      if (o.home) addRecent();
    }
    function homeFor(file, kind, path, handle) {
      var ext = app.ext.toLowerCase(), lower = file.name.toLowerCase();
      var native = lower.slice(-ext.length) === ext;
      if (!native) return null; // an import: the document gets a home on its first save, under its own name
      if (kind === 'computer') return handle ? { kind: 'computer', handle: handle, fileName: file.name } : null;
      return { kind: kind, path: path };
    }
    function openFile(file, kind, path, handle) {
      return settle().then(function (ok) {
        if (!ok) return false;
        var home = homeFor(file, kind, path, handle);
        var native = file.name.toLowerCase().slice(-app.ext.length) === app.ext.toLowerCase();
        var name = cleanName(native ? baseName(file.name) : file.name.replace(/\.[^.]+$/, '')) || untitled();
        return Promise.resolve(doc.load(file, { kind: kind, path: path || null, native: native })).then(function () {
          setDocument({ name: name, home: home });
          return true;
        });
      }).catch(function (e) { setError(e, 'open'); return false; });
    }
    function openFromStore(store, path) {
      return store.read(path, app.binary).then(function (file) { return openFile(file, store.id, path); });
    }
    function openRecent(e) {
      if (e.kind === 'computer') {
        return ensurePermission(e.handle).then(function (ok) {
          if (!ok) throw new Error('permission to open ' + e.fileName + ' was refused');
          return e.handle.getFile();
        }).then(function (f) { return openFile(f, 'computer', null, e.handle); }).catch(function (err) { setError(err, 'open'); return false; });
      }
      var store = storeById(e.kind);
      if (!store || !store.available()) { setError(new Error(e.name + ' is in ' + (store ? store.label : e.kind) + ', which is not available here'), 'open'); return Promise.resolve(false); }
      return openFromStore(store, e.path).catch(function (err) { setError(err, 'open'); return false; });
    }
    function browseComputer() {
      var accept = app.opens || [app.ext];
      if (canPickOpen()) {
        var types = [{ description: app.name + ' files', accept: { 'application/octet-stream': accept.map(function (x) { return x.slice(x.lastIndexOf('.')); }) } }];
        return window.showOpenFilePicker({ types: types, excludeAcceptAllOption: false }).then(function (hs) {
          return hs[0].getFile().then(function (f) { return openFile(f, 'computer', null, hs[0]); });
        }, function (e) { if (e && e.name === 'AbortError') return false; throw e; }).catch(function (e) { setError(e, 'open'); return false; });
      }
      return new Promise(function (resolve) {
        var el = h('input', { type: 'file', accept: accept.join(',') });
        el.onchange = function () { var f = el.files && el.files[0]; resolve(f ? openFile(f, 'computer', null, null) : false); };
        el.oncancel = function () { resolve(false); };
        el.click();
      });
    }
    // quiet (an agent call): no picker; hosted, the copy goes to <folder-of-store>/exports/, else a download.
    function exportAs(fmt, quiet) {
      return Promise.resolve(fmt.make()).then(function (data) {
        if (data == null) return null; // the app handled it (a print dialog, say)
        var name = st.name + fmt.ext;
        if (quiet) {
          if (hostedFs()) { var path = 'exports/' + name; return NakliStore.write(path, data).then(function () { return 'NakliOS storage (' + path + ')'; }); }
          download(name, toBlob(data)); return 'Downloads (' + name + ')';
        }
        if (canPickSave()) {
          return window.showSaveFilePicker({ suggestedName: name }).then(function (hd) {
            return hd.createWritable().then(function (w) { return w.write(toBlob(data)).then(function () { return w.close(); }); });
          }, function (e) { if (e && e.name === 'AbortError') return; throw e; });
        }
        download(name, toBlob(data));
      }).then(function (where) { if (!quiet) hideBackstage(); return where; }, function (e) { setError(e, 'export'); if (quiet) throw e; });
    }
    function print() { hideBackstage(); return Promise.resolve(doc.print ? doc.print() : window.print()); }

    // ---- File page (Backstage)
    var bsNav = h('nav', { class: 'nsh-bs-nav', 'aria-label': 'File' });
    var bsPage = h('section', { class: 'nsh-bs-page', 'aria-live': 'polite' });
    var bs = h('div', { class: 'nsh-bs', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'File', hidden: true }, [bsNav, bsPage]);
    var bsReturn = null;
    var PAGES = [
      { id: 'back', label: 'Back', icon: ICON.back, run: function () { hideBackstage(); } },
      { id: 'new', label: 'New', key: 'file.new' },
      { id: 'open', label: 'Open', key: 'file.open' },
      { id: 'save', label: 'Save', key: 'file.save', run: function () { hideBackstage(); runCmd('file.save'); } },
      { id: 'save_as', label: 'Save as', key: 'file.save_as', run: function () { hideBackstage(); saveAs(); } },
      { id: 'export', label: 'Export' },
      { id: 'print', label: 'Print', key: 'file.print', run: function () { print(); } },
    ];
    function buildNav(current) {
      bsNav.textContent = '';
      PAGES.forEach(function (p) {
        if (p.id === 'export' && !(doc.exports && doc.exports.length)) return;
        if (p.id === 'print' && !doc.print) return;
        var b = h('button', { type: 'button', 'aria-current': p.id === current ? 'page' : null, title: p.key ? tip(p.label, p.key) : p.label, onclick: function () { if (p.run) p.run(); else showBackstage(p.id); } },
          [p.icon ? icon(p.icon) : null, h('span', { text: p.label }), p.key ? h('kbd', { text: keyLabel(shortcutOf(p.key)) }) : null]);
        bsNav.append(b);
      });
    }
    function row(nameText, detail, onclick) {
      return h('button', { class: 'nsh-row', type: 'button', onclick: onclick }, [h('b', { text: nameText }), detail ? h('small', { text: detail }) : null]);
    }
    function pageNew() {
      bsPage.append(h('h2', { text: 'New' }));
      var tiles = h('div', { class: 'nsh-tiles' }, [h('button', { class: 'nsh-tile', type: 'button', onclick: function () { newDoc(); } }, [h('b', { text: 'Blank ' + app.docNoun })])]);
      (doc.templates || []).forEach(function (t) { tiles.append(h('button', { class: 'nsh-tile', type: 'button', onclick: function () { newDoc(t); } }, [h('span', { text: t.label })])); });
      bsPage.append(tiles);
    }
    function pageOpen() {
      bsPage.append(h('h2', { text: 'Open' }));
      var recentList = h('div', { class: 'nsh-list' }, [h('div', { class: 'nsh-empty', text: 'Loading…' })]);
      bsPage.append(h('h3', { text: 'Recent' }), recentList);
      getRecent().then(function (list) {
        recentList.textContent = '';
        var shown = list.filter(function (e) { if (e.kind === 'computer') return !!e.handle; var s = storeById(e.kind); return s && s.available(); });
        if (!shown.length) recentList.append(h('div', { class: 'nsh-empty', text: 'Nothing opened yet.' }));
        shown.forEach(function (e) {
          var placeLabel = e.kind === 'computer' ? 'This computer' : storeById(e.kind).label;
          recentList.append(row(e.name, placeLabel + ' · ' + new Date(e.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }), function () { openRecent(e); }));
        });
      });
      stores().forEach(function (store) {
        var list = h('div', { class: 'nsh-list' }, [h('div', { class: 'nsh-empty', text: 'Loading…' })]);
        bsPage.append(h('h3', { text: store.label }), list);
        var folder = folderOf(store.id);
        Promise.resolve(store.list(folder)).then(function (paths) {
          list.textContent = '';
          var exts = (app.opens || [app.ext]).map(function (x) { return x.toLowerCase(); });
          var files = paths.filter(function (p) { var l = p.toLowerCase(); return exts.some(function (x) { return l.slice(-x.length) === x; }); });
          if (!files.length) list.append(h('div', { class: 'nsh-empty', text: 'No ' + app.docNoun + 's here yet.' }));
          files.forEach(function (p) {
            var full = p.indexOf('/') >= 0 || !folder ? p : folder + '/' + p;
            list.append(row(baseName(fileNameOf(p)), '', function () { openFromStore(store, full).catch(function (err) { setError(err, 'open'); }); }));
          });
        }).catch(function () { list.textContent = ''; list.append(h('div', { class: 'nsh-empty', text: 'Could not list ' + store.label + '.' })); });
      });
      bsPage.append(h('h3', { text: 'This computer' }), h('button', { class: 'nsh-cmd', type: 'button', onclick: browseComputer, text: 'Browse this computer…' }));
    }
    function pageExport() {
      bsPage.append(h('h2', { text: 'Export' }), h('p', { text: 'Export writes a copy. The ' + app.docNoun + ' stays where it is.' }));
      var list = h('div', { class: 'nsh-list' });
      (doc.exports || []).forEach(function (f) { list.append(row(f.label, f.ext || '', function () { exportAs(f); })); });
      bsPage.append(list);
    }
    function showBackstage(page) {
      if (bs.hidden) bsReturn = document.activeElement;
      bs.hidden = false;
      buildNav(page);
      bsPage.textContent = '';
      if (page === 'new') pageNew();
      else if (page === 'export') pageExport();
      else pageOpen();
      var cur = bsNav.querySelector('[aria-current="page"]') || bsNav.querySelector('button');
      if (cur) cur.focus();
    }
    function hideBackstage() {
      if (bs.hidden) return;
      bs.hidden = true;
      if (bsReturn && bsReturn.focus) try { bsReturn.focus(); } catch (_) {}
      bsReturn = null;
    }
    bs.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hideBackstage(); } });

    // ---- dialogs
    function dialog(o) {
      return new Promise(function (resolve) {
        var back = document.activeElement;
        var form = h('form', { method: 'dialog' });
        var d = h('dialog', { class: 'nsh-dlg', 'aria-label': o.title }, [form]);
        form.append(h('h2', { text: o.title }));
        if (o.body) form.append(h('p', { text: o.body }));
        (o.fields || []).forEach(function (f) { form.append(f); });
        var btns = h('div', { class: 'nsh-btns' });
        o.buttons.forEach(function (b) { btns.append(h('button', { class: 'nsh-cmd' + (b.primary ? ' nsh-primary' : ''), value: b.value, type: b.primary ? 'submit' : 'button', text: b.label, onclick: b.primary ? null : function () { d.close(b.value); } })); });
        form.append(btns);
        form.addEventListener('submit', function (e) { e.preventDefault(); var p = o.buttons.filter(function (b) { return b.primary; })[0]; d.close(p ? p.value : ''); });
        d.addEventListener('cancel', function () { d.returnValue = 'cancel'; });
        d.addEventListener('close', function () { var v = d.returnValue; d.remove(); if (back && back.focus) try { back.focus(); } catch (_) {} resolve(v); });
        document.body.append(d);
        d.showModal();
        var first = form.querySelector('input[type=text]') || form.querySelector('.nsh-primary');
        if (first) { first.focus(); if (first.select) first.select(); }
      });
    }
    function dialogSaveAs(preset) {
      var nameInput = h('input', { type: 'text', name: 'name', value: (preset && preset.name) || st.name, required: true, autocomplete: 'off' });
      var places = stores().map(function (s) { return { id: s.id, label: s.label }; });
      places.push({ id: 'computer', label: canPickSave() ? 'This computer…' : 'This computer (download a copy)' });
      var current = (preset && preset.kind) || (st.home && st.home.kind) || defaultStore().id;
      if (!places.some(function (p) { return p.id === current; })) current = places[0].id;
      var fs = h('fieldset', null, [h('legend', { text: 'Save in' })]);
      places.forEach(function (p) {
        var r = h('input', { type: 'radio', name: 'where', value: p.id });
        r.checked = p.id === current;
        fs.append(h('label', null, [r, h('span', { text: p.label })]));
      });
      return dialog({
        title: 'Save as',
        fields: [h('label', null, [h('span', { text: 'Name' }), nameInput]), fs],
        buttons: [{ value: 'cancel', label: 'Cancel' }, { value: 'save', label: 'Save', primary: true }],
      }).then(function (v) {
        if (v !== 'save') return null;
        var picked = fs.querySelector('input:checked');
        return { name: nameInput.value, kind: picked ? picked.value : current };
      });
    }

    // ---- commands and keys
    function runCmd(name, args) {
      switch (name) {
        case 'file.save': return save('save').catch(function (e) { if (args && args.rethrow) throw e; });
        case 'file.save_as': return saveAs(args);
        case 'file.open': showBackstage('open'); return Promise.resolve(true);
        case 'file.new': showBackstage('new'); return Promise.resolve(true);
        case 'file.print': return print();
        default:
          if (typeof commands[name] === 'function') return Promise.resolve(commands[name](args));
          return Promise.resolve(false);
      }
    }
    function onKey(e) {
      if (e.defaultPrevented || e.isComposing) return;
      for (var i = 0; i < CORE_KEYS.length; i++) {
        var c = CORE_KEYS[i];
        if (!c.keys.some(function (k) { return keyMatches(k, e); })) continue;
        if (!FILE_COMMANDS[c.name] && typeof commands[c.name] !== 'function') return; // the app handles it itself
        if (!FILE_COMMANDS[c.name]) {
          // An app handler may decline (return false), for example native undo inside a plain text field.
          var r = commands[c.name]({ event: e });
          if (r === false) return;
        } else if (c.name === 'file.print' && !doc.print) {
          return; // the browser's own print
        } else {
          runCmd(c.name);
        }
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    }
    window.addEventListener('keydown', onKey, true);

    // ---- mount
    var host = opts.mount || document.body;
    host.insertBefore(title, host.firstChild);
    document.body.append(bs);
    st.name = cleanName(opts.name) || untitled();
    if (opts.home) st.home = opts.home;
    render();
    try { var n1 = nak(); if (n1 && n1.onCapabilitiesChange) n1.onCapabilitiesChange(function () { render(); }); } catch (_) {}

    var api = {
      version: VERSION,
      // Call after every change to the document: unsaved dot, AutoSave timer.
      changed: function () {
        st.gen++; st.dirty = true; st.note = '';
        reportDirty();
        scheduleAutosave();
        render();
      },
      // Call after a selection or history change, so Undo and Redo dim correctly.
      refresh: function () { render(); },
      save: function () { return runCmd('file.save'); },
      saveAs: saveAs,
      open: function () { return runCmd('file.open'); },
      newDocument: newDoc,
      openFile: function (file) { return openFile(file, 'computer', null, null); },
      run: runCmd,
      showFile: showBackstage,
      closeFile: hideBackstage,
      rename: rename,
      // Adopt a document the app already has (its boot state): name and, optionally, a home.
      adopt: function (o) { setDocument({ name: cleanName(o && o.name) || untitled(), home: (o && o.home) || null }); },
      // Show a short note where the save state goes (cleared by the next change or save).
      note: function (text) { st.note = String(text || ''); render(); },
      // Recent entries (newest first) and reopening one, for an app that reopens the last document at boot.
      recent: function () { return getRecent(); },
      openRecent: function (entry) { return openRecent(entry); },
      exportAs: function (id, quiet) { var f = (doc.exports || []).filter(function (x) { return x.id === id; })[0]; return f ? exportAs(f, quiet) : Promise.reject(new Error('no export format "' + id + '"')); },
      onChange: function (fn) { listeners.push(fn); return function () { listeners = listeners.filter(function (f) { return f !== fn; }); }; },
      info: function () {
        var hm = st.home;
        return { name: st.name, dirty: st.dirty, saving: !!st.saving, error: st.error, autosave: st.autosave, savedAt: st.savedAt,
          home: hm ? { kind: hm.kind, path: hm.path || null, fileName: hm.fileName || null, handle: hm.handle || null } : null, status: whereText() };
      },
      element: title,
      // The rail commands for the file layer, ready to merge into an app's registration (spec 6.3).
      commands: function () {
        var out = [
          { name: 'file.save', description: 'Save the ' + app.docNoun + ' where it lives (NakliOS storage when hosted). A new ' + app.docNoun + ' is saved under its name in NakliOS storage, or in this browser when not hosted.', scope: 'write', input: { type: 'object', properties: {} } },
          { name: 'file.save_as', description: 'Save under a new name; the copy becomes the ' + app.docNoun + ' you are editing. kind is naklios (hosted) or browser (standalone), default where it is now. A name already taken fails unless replace is true. Saving to this computer needs a person (File > Save as).', scope: 'write', input: { type: 'object', properties: { name: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['naklios', 'browser'] }, replace: { type: 'boolean' } }, required: ['name'] } },
          { name: 'file.open', description: 'Show the Open page: Recent, then the ' + app.docNoun + 's in storage, then Browse this computer.', scope: 'read', input: { type: 'object', properties: {} } },
          { name: 'file.new', description: 'Show the New page (blank or a template).', scope: 'write', input: { type: 'object', properties: {} } },
          { name: 'file.info', description: 'The current ' + app.docNoun + "'s name, where it is saved, and whether it has unsaved changes.", scope: 'read', input: { type: 'object', properties: {} } },
        ];
        if (doc.exports && doc.exports.length) out.push({ name: 'file.export', description: 'Export a copy in another format; the ' + app.docNoun + ' stays where it is. Hosted, the copy goes to NakliOS storage under exports/; otherwise it downloads.', scope: 'write', input: { type: 'object', properties: { format: { type: 'string', enum: doc.exports.map(function (f) { return f.id; }) } }, required: ['format'] } });
        if (doc.print) out.push({ name: 'file.print', description: 'Print the ' + app.docNoun + '.', scope: 'read', input: { type: 'object', properties: {} } });
        return out.map(function (c) {
          c.shortcut = shortcutOf(c.name) || undefined;
          c.handler = c.name === 'file.info' ? function () { return api.info(); }
            : c.name === 'file.save_as' ? function (a) { var x = a || {}; return saveAs({ name: x.name, kind: x.kind, replace: !!x.replace, quiet: true }).then(function () { return api.info(); }); }
            : c.name === 'file.export' ? function (a) { return api.exportAs((a || {}).format, true).then(function (where) { return { exported: where }; }); }
            : c.name === 'file.save' ? function () { return runCmd('file.save', { rethrow: true }).then(function () { return api.info(); }); }
            : function () { return runCmd(c.name); };
          return c;
        });
      },
    };
    return api;
  }

  window.naklishell = { version: VERSION, mount: mount, keys: CORE_KEYS.slice(), keyLabel: keyLabel, isMac: isMac };
  try { installCss(); } catch (_) {}
})();
