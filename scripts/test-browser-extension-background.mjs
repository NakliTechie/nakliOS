// The Browser extension's background flow, run in node against a stand-in `chrome`: the desktop's
// open → rules installed for that tab → frame.html redeems the token once → the window closes →
// rules gone. Also: a mirrored app is refused, tab close and desktop navigation remove the rules,
// and a sign-in navigation inside the site opens a popup. The live version needs the extension in
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
const popups = [];
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
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => { rules = rules.filter(r => !removeRuleIds.includes(r.id)).concat(addRules); },
  },
  permissions: {
    contains: async ({ origins }) => origins.every(o => granted.has(o)),
    getAll: async () => ({ origins: [...granted] }),
    remove: async ({ origins }) => { origins.forEach(o => granted.delete(o)); return true; },
  },
  cookies: { getAll: async () => [{ name: 'a' }, { name: 'b' }] },
  tabs: { onRemoved: ev() },
  webNavigation: { onCommitted: ev(), onBeforeNavigate: ev() },
  windows: { create: async o => { popups.push(o); return { id: 900 + popups.length }; }, onRemoved: ev() },
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
const desktop = { tab: { id: 7 }, frameId: 0, url: 'http://127.0.0.1:8966/', origin: 'http://127.0.0.1:8966' };
const frameSender = { id: chrome.runtime.id, tab: { id: 7 }, frameId: 4 };

// A mirrored app cannot open a signed-in frame.
assert.equal((await external({ type: 'nakli-browser:open', url: 'https://github.com/' }, { ...desktop, frameId: 2, url: 'http://127.0.0.1:8966/apps/notes/' })).error, 'not-top-frame');
assert.equal(rules.length, 0);

// The desktop opens GitHub: rules for tab 7, a token, the frame URL.
const hello = await external({ type: 'nakli-browser:hello' }, desktop);
assert.equal(hello.ok, true);
assert.equal(hello.dev, true);
const open = await external({ type: 'nakli-browser:open', url: 'https://github.com/', windowId: 'browser' }, desktop);
assert.equal(open.ok, true);
assert.equal(open.needsPermission, false);
assert.match(open.frame, /frame\.html$/);
assert.equal(rules.length, 1);
assert.deepEqual(rules[0].condition.tabIds, [7]);
assert.deepEqual(rules[0].condition.excludedInitiatorDomains, ['127.0.0.1']);

// frame.html in another tab cannot use the token; in its own tab it can, once.
assert.equal((await internal({ type: 'frame:redeem', token: open.token }, { ...frameSender, tab: { id: 8 } })).error, 'wrong-tab');
const open2 = await external({ type: 'nakli-browser:open', url: 'https://github.com/', windowId: 'browser' }, desktop);
const redeemed = await internal({ type: 'frame:redeem', token: open2.token }, frameSender);
assert.equal(redeemed.ok, true);
assert.equal(redeemed.url, 'https://github.com/');
assert.equal((await internal({ type: 'frame:redeem', token: open2.token }, frameSender)).error, 'unknown-token');
assert.equal((await internal({ type: 'frame:cookie-count', url: 'https://github.com/' }, frameSender)).count, 2, 'a count, never values');
assert.equal((await internal({ type: 'frame:redeem', token: 'x' }, { ...frameSender, id: 'someone-else' })).error, 'not-extension-frame');

// The site navigates: its frame hears the new address. A sign-in page opens in a popup instead.
broadcasts.length = 0;
await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 7, frameId: 9, parentFrameId: 4, url: 'https://github.com/NakliTechie' }));
assert.deepEqual(broadcasts.map(b => b.type), ['bg:committed']);
assert.equal(broadcasts[0].sessionId, open2.token);
await Promise.all(chrome.webNavigation.onBeforeNavigate.fire({ tabId: 7, frameId: 9, parentFrameId: 4, url: 'https://accounts.google.com/v3/signin' }));
assert.equal(popups.length, 1);
assert.equal(popups[0].type, 'popup');
await Promise.all(chrome.windows.onRemoved.fire(901));
assert.ok(broadcasts.some(b => b.type === 'bg:signin-closed'), 'the frame reloads when the popup closes');
// An unrelated frame in the tab is ignored.
broadcasts.length = 0;
await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 7, frameId: 12, parentFrameId: 0, url: 'https://elsewhere.example/' }));
assert.equal(broadcasts.length, 0);

// History keeps the host only.
assert.ok(localStore.history.length >= 1);
assert.deepEqual(Object.keys(localStore.history[0]), ['host', 'at']);

// Closing the window removes the rules; so do a tab close and a desktop navigation.
assert.equal((await external({ type: 'nakli-browser:closed', windowId: 'browser' }, desktop)).ok, true);
assert.equal(rules.length, 0, 'rules gone with the window');
await external({ type: 'nakli-browser:open', url: 'https://github.com/' }, desktop);
assert.equal(rules.length, 1);
await Promise.all(chrome.tabs.onRemoved.fire(7));
await new Promise(r => setTimeout(r, 10));
assert.equal(rules.length, 0, 'rules gone with the tab');
await external({ type: 'nakli-browser:open', url: 'https://github.com/' }, desktop);
await Promise.all(chrome.webNavigation.onCommitted.fire({ tabId: 7, frameId: 0, url: 'http://127.0.0.1:8966/' }));
await new Promise(r => setTimeout(r, 10));
assert.equal(rules.length, 0, 'rules gone when the desktop reloads or navigates');

// A site without permission: the frame asks; Settings lists and forgets sites.
const other = await external({ type: 'nakli-browser:open', url: 'https://example.com/' }, desktop);
assert.equal(other.needsPermission, true);
assert.equal(other.pattern, 'https://example.com/*');
assert.deepEqual((await external({ type: 'nakli-browser:sites' }, desktop)).sites, ['https://github.com/*']);
assert.equal((await external({ type: 'nakli-browser:forget', pattern: 'https://github.com/*' }, desktop)).removed, true);
assert.deepEqual((await external({ type: 'nakli-browser:sites' }, desktop)).sites, []);
console.log('browser-extension-background: open, token, rules, navigation, sign-in popup, history, cleanup and settings pass');
