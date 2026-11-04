#!/usr/bin/env node
// "Unlock once for all tabs" (index.html, crateShare): the real block runs in two simulated tabs joined by a
// stand-in BroadcastChannel. An unlocked tab hands its passphrase to a tab that asks; a wrong passphrase leaves the
// asker locked; Lock in one tab locks the other; the switch off stops sharing; nothing touches web storage.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function crateLock({ broadcast = true } = {}){');
const end = html.indexOf('// crateDisconnect', start);
assert.ok(start > 0 && end > start, 'the crateLock + crateShare block exists');
const block = html.slice(start, end);
assert.match(html, /crateRememberPass\(passphrase\);\n  if \(typeof broadcastCapabilities === 'function'\) broadcastCapabilities\(\);\n  return crate;/,
  'every successful unlock remembers the passphrase');
assert.match(html, /if \(!haveBlob \|\| !state\.crateShareUnlock \|\| state\.crate\) return;\n    try \{ crateShare\.channel\?\.postMessage\(\{ type:'ask' \}\); \} catch \(_\)\{\}/,
  'a tab that boots locked asks the others');
assert.ok(!/sessionStorage\.setItem|localStorage\.setItem\([^)]*pass/i.test(block), 'the passphrase is never written to web storage');

// A BroadcastChannel bus: a message reaches every OTHER channel with the same name, asynchronously.
const bus = new Set();
class FakeChannel {
  constructor(name) { this.name = name; this.listeners = []; bus.add(this); }
  addEventListener(type, fn) { if (type === 'message') this.listeners.push(fn); }
  postMessage(data) { for (const c of bus) if (c !== this && c.name === this.name) setImmediate(() => c.listeners.forEach((fn) => fn({ data: structuredClone(data) }))); }
}
const RIGHT = 'correct horse';
function tab(name, { unlocked = false, share = true } = {}) {
  const state = { crate: unlocked ? { close() {} } : null, crateLocked: !unlocked, crateShareUnlock: share };
  const log = [];
  const ctx = {
    state, BroadcastChannel: FakeChannel, String, console,
    broadcastCapabilities: () => {}, renderTopbarChips: () => {},
    crateLoadCredsBlob: async () => new Uint8Array([1]),
    crateUnlock: async (blob, pass) => {
      log.push(['unlock', pass]);
      if (pass !== RIGHT) throw new Error('wrong passphrase');
      state.crate = { close() {} }; state.crateLocked = false; ctx.crateRememberPass(pass);
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${block}\nthis.crateLock = crateLock; this.crateShare = crateShare; this.crateRememberPass = crateRememberPass;`, ctx);
  if (unlocked) ctx.crateRememberPass(RIGHT);
  return { name, state, log, ctx, ask: () => ctx.crateShare.channel.postMessage({ type: 'ask' }) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const a = tab('A', { unlocked: true });
const b = tab('B');
b.ask(); await tick();
assert.equal(!!b.state.crate, true, 'a new tab unlocks from an unlocked one');
assert.deepEqual(b.log, [['unlock', RIGHT]]);
assert.equal(b.ctx.crateShare.pass, RIGHT, 'and can share it onward');

b.ctx.crateLock(); await tick();
assert.equal(a.state.crate, null, 'Lock in one tab locks the other');
assert.equal(a.ctx.crateShare.pass, null, 'and forgets the passphrase there');
assert.equal(b.ctx.crateShare.pass, null);

bus.clear();
const c = tab('C', { unlocked: true }); c.ctx.crateShare.pass = 'something else';
const d = tab('D');
d.ask(); await tick();
assert.equal(d.state.crate, null, 'a passphrase for a different Crate leaves the tab locked');

bus.clear();
const e = tab('E', { unlocked: true, share: false });
const f = tab('F');
f.ask(); await tick();
assert.equal(f.log.length, 0, 'with the switch off, an unlocked tab shares nothing');
assert.equal(e.ctx.crateShare.pass, null, 'and does not keep the passphrase');

console.log('crate unlock shared across tabs — ask, share, wrong-crate, lock-all, switch-off: PASS');
