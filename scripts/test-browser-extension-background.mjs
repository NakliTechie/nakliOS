// The Browser extension's background flow, run in node against a stand-in `chrome`: the desktop's
// open → rules installed for that tab → frame.html redeems the token once → the window closes →
// rules gone. Also: a mirrored app is refused, tab close and desktop navigation remove the rules,
// and the removed sign-in messages (cookie count, Full tab) answer unknown-message. The live version needs the extension in
// Chrome; this pins the wiring between lib.mjs and chrome.* so a refactor cannot drop a step.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ev = () => { const fns = []; return { addListener: f => fns.push(f), fire: (...a) => fns.map(f => f(...a)) }; };
const sessionStore = {}, localStore = {};
let rules = [];
const granted = new Set(['https://github.com/*']);
const broadcasts = [];
globalThis.chrome = {
  runtime: {
    id: 'abcdefghijklmnopabcdefghijklmnop',
    getManifest: () => ({ name: 'NakliOS Browser (dev)', version: '0.1.0' }),
    getURL: p => `chrome-extension://abcdefghijklmnopabcdefghijklmnop/${p}`,
    onMessageExternal: ev(), onMessage: ev(),
    sendMessage: async m => { broadcasts.push(m); },
  },
  storage: {
    session: { get: async k => ({ [k]: sessionStore[k] }), set: async o => Object.assign(sessionStore, structuredClone(o)) },
    local: { get: async k => ({ [k]: localStore[k] }), set: async o => Object.assign(localStore, structuredClone(o)) },
  },
  declarativeNetRequest: {
    getSessionRules: async () => structuredClone(rules),
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
      // Chrome refuses a rule id that is not a positive 32-bit integer, or one already in use.
      for (const id of [...removeRuleIds, ...addRules.map(r => r.id)]) {
        if (!Number.isInteger(id) || id < 1 || id > 2 ** 31 - 1) throw new Error(`Invalid type: expected integer, found number (${id})`);
      }
      const kept = rules.filter(r => !removeRuleIds.includes(r.id));
      if (addRules.some(a => kept.some(r => r.id === a.id))) throw new Error('Rule id already in use');
      rules = kept.concat(addRules);
    },
  },
  permissions: {
    contains: async ({ origins }) => origins.every(o => granted.has(o)),
    getAll: async () => ({ origins: [...granted] }),
    remove: async ({ origins }) => { origins.forEach(o => granted.delete(o)); return true; },
  },
  tabs: { onRemoved: ev() },
  webNavigation: { onCommitted: ev(), onBeforeNavigate: ev(), onErrorOccurred: ev() },
};

// Load background.js as a module with its lib import pointed at the real file.
const dir = await mkdtemp(join(tmpdir(), 'nb-bg-'));
try {
  const src = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'))
    .replace("from './lib.mjs'", `from '${new URL('../extension/lib.mjs', import.meta.url).href}'`);
  const file = join(dir, 'background.mjs');
  await writeFile(file, src);
  await import(pathToFileURL(file).href);
} finally { await rm(dir, { recursive: true, force: true }); }

const external = (msg, sender) => new Promise(r => chrome.runtime.onMessageExternal.fire(msg, sender, r));
const internal = (msg, sender) => new Promise(r => chrome.runtime.onMessage.fire(msg, sender, r));
const desktop = { tab: { id: 1660080632 }, frameId: 0, url: 'http://127.0.0.1:8966/', origin: 'http://127.0.0.1:8966' };
const frameSender = { id: chrome.runtime.id, tab: { id: 1660080632 }, frameId: 4 };

// A mirrored app cannot open a signed-in frame.
assert.equal((await external({ type: 'nakli-browser:open', url: 'https://github.com/' }, { ...desktop, frameId: 2, url: 'http://127.0.0.1:8966/apps/notes/' })).error, 'not-top-frame');
assert.equal(rules.length, 0);

// The desktop opens GitHub: rules for tab 1660080632 (a real Chrome tab id is this large), a token, the frame URL.
const hello = await external({ type: 'nakli-browser:hello' }, desktop);
assert.equal(hello.ok, true);
assert.equal(hello.dev, true);
const open = await external({ type: 'nakli-browser:open', url: 'https://github.com/', windowId: 'browser' }, desktop);
assert.equal(open.ok, true);
assert.equal(open.needsPermission, false);
assert.match(open.frame, /frame\.html$/);
assert.equal(rules.length, 1);
assert.deepEqual(rules[0].condition.tabIds, [1660080632]);
assert.deepEqual(rules[0].condition.excludedInitiatorDomains, ['127.0.0.1']);

// frame.html in another tab cannot use the token; in its own tab it can, once.
assert.equal((await internal({ type: 'frame:redeem', token: open.token }, { ...frameSender, tab: { id: 8 } })).error, 'wrong-tab');
const open2 = await external({ type: 'nakli-browser:open', url: 'https://github.com/', windowId: 'browser' }, desktop);
const redeemed = await internal({ type: 'frame:redeem', token: open2.token }, frameSender);
assert.equal(redeemed.ok, true);
assert.equal(redeemed.url, 'https://github.com/');
assert.equal((await internal({ type: 'frame:redeem', token: open2.token }, frameSender)).error, 'unknown-token');
for (const type of ['frame:cookie-count', 'frame:open-full', 'page:ready']) assert.equal((await internal({ type, url: 'https://github.com/' }, frameSender)).error, 'unknown-message', `${type} is gone`);
assert.equal((await internal({ type: 'frame:redeem', token: 'x' }, { ...frameSender, id: 'someone-else' })).error, 'not-extension-frame');

// The site navigates: its frame hears the new address, sign-in pages included (no popup any more).
broadcasts.length = 0;
await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 1660080632, frameId: 9, parentFrameId: 4, url: 'https://github.com/NakliTechie' }));
assert.deepEqual(broadcasts.map(b => b.type), ['bg:committed']);
assert.equal(broadcasts[0].sessionId, open2.token);
broadcasts.length = 0;
await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 1660080632, frameId: 9, parentFrameId: 4, url: 'https://accounts.google.com/v3/signin' }));
assert.deepEqual(broadcasts.map(b => b.type), ['bg:committed'], 'a sign-in page is an ordinary navigation');
// An unrelated frame in the tab is ignored.
broadcasts.length = 0;
await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 1660080632, frameId: 12, parentFrameId: 0, url: 'https://elsewhere.example/' }));
assert.equal(broadcasts.length, 0);

// History keeps the host only.
assert.ok(localStore.history.length >= 1);
assert.deepEqual(Object.keys(localStore.history[0]), ['host', 'at']);

// Closing the window removes the rules; so do a tab close and a desktop navigation.
assert.equal((await external({ type: 'nakli-browser:closed', windowId: 'browser' }, desktop)).ok, true);
assert.equal(rules.length, 0, 'rules gone with the window');
await external({ type: 'nakli-browser:open', url: 'https://github.com/' }, desktop);
assert.equal(rules.length, 1);
await Promise.all(chrome.tabs.onRemoved.fire(1660080632));
await new Promise(r => setTimeout(r, 10));
assert.equal(rules.length, 0, 'rules gone with the tab');
await external({ type: 'nakli-browser:open', url: 'https://github.com/' }, desktop);
await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 1660080632, frameId: 0, url: 'http://127.0.0.1:8966/' }));
await new Promise(r => setTimeout(r, 10));
assert.equal(rules.length, 0, 'rules gone when the desktop reloads or navigates');

// A site without permission: the frame asks; Settings lists and forgets sites.
const other = await external({ type: 'nakli-browser:open', url: 'https://example.com/' }, desktop);
assert.equal(other.needsPermission, true);
assert.equal(other.pattern, 'https://example.com/*');
assert.deepEqual((await external({ type: 'nakli-browser:sites' }, desktop)).sites, ['https://github.com/*']);
assert.equal((await external({ type: 'nakli-browser:forget', pattern: 'https://github.com/*' }, desktop)).removed, true);
assert.deepEqual((await external({ type: 'nakli-browser:sites' }, desktop)).sites, []);
// Review fixes (2026-11-12): two quick opens both keep valid tokens; History gets one line per open (on redeem).
granted.add('https://github.com/*');
const [q1, q2] = await Promise.all([
  external({ type: 'nakli-browser:open', url: 'https://github.com/' }, desktop),
  external({ type: 'nakli-browser:open', url: 'https://github.com/' }, desktop),
]);
const before = localStore.history.length;
assert.equal((await internal({ type: 'frame:redeem', token: q1.token }, frameSender)).ok, true, 'the first of two quick opens is still valid');
assert.equal((await internal({ type: 'frame:redeem', token: q2.token }, { ...frameSender, frameId: 5 })).ok, true, 'and so is the second');
assert.equal(localStore.history.length, before + 2, 'one History line per redeemed open');

// The nested demo: opening the desktop's own host adds the second rule for that window only.
await external({ type: 'nakli-browser:closed', windowId: 'browser' }, desktop);
await external({ type: 'nakli-browser:open', url: 'https://github.com/', windowId: 'browser' }, desktop);
assert.equal(rules.filter(r => r.condition.tabIds[0] === 1660080632).length, 1);
await external({ type: 'nakli-browser:open', url: 'http://127.0.0.1:8966/', windowId: 'demo' }, desktop);
const nestRule = rules.find(r => r.condition.tabIds[0] === 1660080632 && r.condition.requestDomains);
assert.deepEqual(nestRule.condition.requestDomains, ['127.0.0.1'], 'the nested rule names the desktop host');
await external({ type: 'nakli-browser:closed', windowId: 'demo' }, desktop);
assert.equal(rules.filter(r => r.condition.tabIds[0] === 1660080632).length, 1, 'the nested rule goes with the demo window');
await external({ type: 'nakli-browser:closed', windowId: 'browser' }, desktop);
assert.equal(rules.filter(r => r.condition.tabIds[0] === 1660080632).length, 0);

console.log('browser-extension-background: open, token, rules, navigation, history, cleanup and settings pass; no sign-in paths');
