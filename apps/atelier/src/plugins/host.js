// Plugins (P59): a plugin is plugins/<name>/plugin.json plus its script. The script runs in a Web Worker whose
// globals are locked down before the plugin's code runs: every global outside an allow-list (ECMAScript
// built-ins plus timers, console, TextEncoder/TextDecoder, atob/btoa, structuredClone) is removed, so it has no
// DOM, no storage (IndexedDB, Cache Storage, OPFS through navigator.storage), no network (fetch,
// XMLHttpRequest, WebSocket, importScripts, FontFace and self.fonts) and no string-to-code route (eval,
// Function constructors, setTimeout with a string). The page CSP's font-src, img-src and default-src add a
// second barrier for the routes that load by URL. Its one outlet is
// atelier.call(command, args), a postMessage bridge to the command bus: only the commands its manifest lists,
// dispatched with door 'plugin', so revision checks, person-only refusals and staging all apply.
// Limit: this is a lockdown of one worker's globals, not a browser security boundary; a page CSP without
// 'unsafe-eval' would add one. The script is also refused when it contains the word `import`, because a
// dynamic import() cannot be removed as a global.

export const PLUGIN_DIR = 'plugins';

// Checks a parsed plugin.json against the manifest; returns an error message or null.
export function checkPlugin(p, manifest) {
  if (!p || p.format !== 'atelier-plugin' || p.version !== 1) return 'plugin.json needs format "atelier-plugin" and version 1';
  if (typeof p.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(p.name)) return 'name is 1 to 41 lowercase letters, digits or dashes';
  if (typeof p.script !== 'string' || !/^[\w.-]+\.js$/.test(p.script)) return 'script names one .js file beside plugin.json';
  if (!Array.isArray(p.commands) || !p.commands.length) return 'commands lists the commands the plugin calls';
  for (const c of p.commands) {
    const t = manifest.tools.find((x) => x.name === c);
    if (!t) return `${c} is not an Atelier command`;
    if (t.personOnly) return `${c} is person-only; a plugin cannot call it`;
    if (c === 'run_plugin') return 'a plugin cannot run plugins';
  }
  return null;
}

export function checkScript(src) {
  if (/\bimport\b/.test(src)) return 'the script uses import; plugins are one file and load nothing';
  if (src.length > 512 * 1024) return 'the script is larger than 512 KB';
  return null;
}

const PRELUDE = `
'use strict';
const __post = self.postMessage.bind(self);
const __pending = new Map(); let __seq = 0;
self.addEventListener('message', (e) => { const m = e.data; if (m && m.type === 'reply' && __pending.has(m.id)) { __pending.get(m.id)(m.reply); __pending.delete(m.id); } });
const __st = self.setTimeout.bind(self); const __si = self.setInterval.bind(self);
(function lock() {
  // Allow-list: every global name on the worker scope and its prototypes (DedicatedWorkerGlobalScope,
  // WorkerGlobalScope, EventTarget) is removed unless listed here. The list is the ECMAScript built-ins
  // plus the few host helpers a plugin needs that cannot reach the network or storage. A new browser
  // global (as FontFace and self.fonts were) is therefore removed by default.
  const allow = new Set(['Object', 'Array', 'Number', 'parseFloat', 'parseInt', 'Infinity', 'NaN', 'undefined', 'Boolean', 'String', 'Symbol',
    'Date', 'Promise', 'RegExp', 'Error', 'AggregateError', 'EvalError', 'RangeError', 'ReferenceError', 'SyntaxError', 'TypeError', 'URIError',
    'SuppressedError', 'globalThis', 'JSON', 'Math', 'Intl', 'ArrayBuffer', 'Atomics', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
    'Uint32Array', 'Int32Array', 'Float16Array', 'Float32Array', 'Float64Array', 'Uint8ClampedArray', 'BigUint64Array', 'BigInt64Array', 'DataView',
    'Map', 'BigInt', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'FinalizationRegistry', 'WeakRef', 'Iterator', 'decodeURI', 'decodeURIComponent',
    'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'isFinite', 'isNaN',
    'self', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'structuredClone', 'console', 'TextEncoder',
    'TextDecoder', 'atob', 'btoa']);
  const names = new Set();
  for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) if (!allow.has(k)) names.add(k);
  for (const k of ['eval', 'Function']) names.add(k);
  for (const k of names) {
    for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) { const d = Object.getOwnPropertyDescriptor(o, k); if (d && d.configurable) { try { delete o[k]; } catch {} } }
    try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  for (const F of [function () {}, async function () {}, function* () {}, async function* () {}]) {
    try { Object.defineProperty(Object.getPrototypeOf(F), 'constructor', { value: undefined, writable: false, configurable: false }); } catch {}
  }
  const noString = (f) => (h, ...rest) => { if (typeof h !== 'function') throw new TypeError('timers take a function'); return f(h, ...rest); };
  Object.defineProperty(self, 'setTimeout', { value: noString(__st), writable: false, configurable: false });
  Object.defineProperty(self, 'setInterval', { value: noString(__si), writable: false, configurable: false });
})();
const atelier = Object.freeze({
  call: (command, args = {}) => new Promise((resolve) => { const id = ++__seq; __pending.set(id, resolve); __post({ type: 'call', id, command, args }); }),
  log: (...a) => __post({ type: 'log', text: a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') }),
});
`;

export function workerSource(script) {
  return `${PRELUDE}\n(async () => {\n${script}\n})().then((r) => __post({ type: 'done', result: r === undefined ? null : r }), (e) => __post({ type: 'error', message: String(e && e.message || e) }));\n`;
}

// Runs a plugin in a Worker. dispatch(command, args) answers the bus envelope. Resolves with
// { state: 'done' | 'failed' | 'timeout', result, error, calls, log }.
export function runPluginWorker(script, plugin, dispatch, { timeoutMs = 60000 } = {}) {
  const url = URL.createObjectURL(new Blob([workerSource(script)], { type: 'application/javascript' }));
  const w = new Worker(url);
  URL.revokeObjectURL(url);
  const calls = []; const log = [];
  return new Promise((resolve) => {
    const finish = (out) => { clearTimeout(timer); w.terminate(); resolve({ ...out, calls, log }); };
    const timer = setTimeout(() => finish({ state: 'timeout', error: `stopped after ${timeoutMs / 1000} s` }), timeoutMs);
    w.addEventListener('error', (e) => { e.preventDefault?.(); finish({ state: 'failed', error: e.message || 'the plugin script failed to load' }); });
    w.addEventListener('message', async (e) => {
      const m = e.data || {};
      if (m.type === 'log') { if (log.length < 200) log.push(String(m.text).slice(0, 500)); return; }
      if (m.type === 'done') return finish({ state: 'done', result: m.result });
      if (m.type === 'error') return finish({ state: 'failed', error: m.message });
      if (m.type !== 'call') return;
      let reply;
      if (!plugin.commands.includes(m.command)) reply = { status: 'person_only', error: { message: `${plugin.name} did not declare ${m.command} in plugin.json` } };
      else { try { reply = await dispatch(m.command, m.args ?? {}); } catch (err) { reply = { status: 'outcome_unknown', error: { message: err.message } }; } }
      calls.push({ command: m.command, status: reply.status });
      w.postMessage({ type: 'reply', id: m.id, reply: JSON.parse(JSON.stringify(reply)) });
    });
  });
}
