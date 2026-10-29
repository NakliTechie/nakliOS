// Guards the NakliOS dialog promise contract.
//
// `_nakliosDialog` returns a promise that callers await and, in one case,
// CACHE: aiEnsurePermission stores the pending permission prompt in
// `aiHost.permissionPrompts` and deletes it only in `.finally()`. So a promise
// that never settles is not a stalled dialog — it is a permanently poisoned
// cache entry, handed to every later AI request for that app. Observed
// 2026-09-03 driving Anvil: the agent sat at "running" forever, "Stopping…"
// never completed, and nothing surfaced. The dialog had left the DOM without
// firing `close`.
//
// The invariant: the promise settles exactly once, on every path — including
// removal from the DOM. This test extracts the real function from index.html
// and runs it against a minimal DOM, so it checks behaviour, not just text.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// The caching caller still exists — this is why settlement is load-bearing.
assert.match(host, /aiHost\.permissionPrompts\.set\(promptKey, prompt\)/,
  'the permission prompt is still cached (so a hung promise would still poison it)');
assert.match(host, /\.finally\(\(\) => aiHost\.permissionPrompts\.delete\(promptKey\)\)/,
  'the cache entry is released only when the promise settles');
// While the prompt waits on the person, the app is told so (status 'permission'), including when
// it joins a prompt already open; an app's own deadline pauses on it.
assert.match(host, /try \{ onWait\?\.\(\); \} catch \(_\) \{\}\n  if \(aiHost\.permissionPrompts\.has\(promptKey\)\)/,
  'onWait runs for a new prompt and for one already open');
assert.match(host, /aiEmit\(provisional, \{ event:'status', status:'permission' \}\)/,
  'aiHostSubmit emits the permission status');

// Extract _nakliosDialog and run it for real.
const src = host.match(/function _nakliosDialog\(\{[\s\S]*?\n\}/);
assert.ok(src, '_nakliosDialog found in index.html');

function fakeDom(){
  const listeners = new Map();
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(), className: '', innerHTML: '', returnValue: '',
      children: [], parentNode: null, isConnected: false, open: false, attrs: {},
      setAttribute(k, v){ this.attrs[k] = String(v); },
      appendChild(c){ this.children.push(c); c.parentNode = this; c.isConnected = true; observers.forEach(o => o()); return c; },
      remove(){ if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; this.isConnected = false; observers.forEach(o => o()); },
      addEventListener(type, fn){ (listeners.get(this) || listeners.set(this, {}).get(this))[type] = fn; },
      showModal(){ this.open = true; },
      close(v){ this.open = false; this.returnValue = v == null ? this.returnValue : v; const h = (listeners.get(this) || {}).close; if (h) h(); },
      querySelectorAll(){ return []; },
    };
    listeners.set(el, {});
    return el;
  };
  const observers = [];
  const body = make('body');
  body.isConnected = true;
  return {
    body,
    document: { createElement: make, body },
    MutationObserver: class { constructor(cb){ this.cb = cb; } observe(){ observers.push(this.cb); } disconnect(){ const i = observers.indexOf(this.cb); if (i >= 0) observers.splice(i, 1); } },
  };
}

function loadDialog(dom){
  const factory = new Function('document', 'MutationObserver', `
    function _dlgEscape(s){ return String(s); }
    let _nakliosDialogCounter = 0;
    ${src[0]}
    return _nakliosDialog;
  `);
  return factory(dom.document, dom.MutationObserver);
}

const buttons = [{ value: 'cancel', label: 'Not now' }, { value: 'ok', label: 'Allow', primary: true }];

// 1. The normal path: a button closes it and the value comes back.
{
  const dom = fakeDom();
  const dialog = loadDialog(dom);
  const p = dialog({ title: 'Allow AI?', body: 'x', buttons });
  const dlg = dom.body.children[0];
  dlg.close('ok');
  assert.equal(await p, 'ok', 'a closed dialog resolves with its returnValue');
}

// 2. Escape / no returnValue → 'cancel', never a hang.
{
  const dom = fakeDom();
  const dialog = loadDialog(dom);
  const p = dialog({ title: 'Allow AI?', body: 'x', buttons });
  dom.body.children[0].close();
  assert.equal(await p, 'cancel', 'a dialog closed with no value resolves as cancel');
}

// 3. THE REGRESSION: removed from the DOM without ever firing `close`.
{
  const dom = fakeDom();
  const dialog = loadDialog(dom);
  const p = dialog({ title: 'Allow AI?', body: 'x', buttons });
  dom.body.children[0].remove();
  const settled = await Promise.race([p, new Promise(r => setTimeout(() => r('__HUNG__'), 300))]);
  assert.notEqual(settled, '__HUNG__',
    'a dialog removed from the DOM must still settle — otherwise it poisons permissionPrompts forever');
  assert.equal(settled, 'cancel', 'removal is treated as a cancel');
}

// 4. Settles exactly once: a close after removal must not double-resolve.
{
  const dom = fakeDom();
  const dialog = loadDialog(dom);
  const p = dialog({ title: 'Allow AI?', body: 'x', buttons });
  const dlg = dom.body.children[0];
  dlg.remove();
  dlg.close('ok');
  assert.equal(await p, 'cancel', 'the first settlement wins; a later close cannot change it');
}

console.log('host-dialog-settles: the dialog promise settles exactly once on every path');
