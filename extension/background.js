// Service worker for the NakliOS Browser companion. Every decision lives in lib.mjs (node-tested);
// this file wires those decisions to chrome.* events.
import {
  checkDesktopSender, parseSiteUrl, originPattern, buildSessionRules, ruleIdsFor,
  mintToken, redeemToken, pruneTokens, historyEntry, isSignInUrl,
} from './lib.mjs';

const DEV = chrome.runtime.getManifest().name.includes('(dev)');
const HISTORY_MAX = 200;

// Every read-modify-write of session state runs through this one chain, so two quick opens (Enter,
// then Go) cannot overwrite each other's token.
let chain = Promise.resolve();
const locked = fn => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
const getTokens = async () => (await chrome.storage.session.get('tokens')).tokens || {};
const setTokens = tokens => chrome.storage.session.set({ tokens });
// Tabs that hold an open Browser window, with the desktop host each one trusts and its open windows.
const getTabs = async () => (await chrome.storage.session.get('tabs')).tabs || {};
const setTabs = tabs => chrome.storage.session.set({ tabs });
// Open frames: session id (the redeemed token) -> { tabId, frameId } of that frame.html.
const getFrames = async () => (await chrome.storage.session.get('frames')).frames || {};
const setFrames = frames => chrome.storage.session.set({ frames });
// Sign-in popups: popup window id -> session id, so the frame reloads when the popup closes.
const getPopups = async () => (await chrome.storage.session.get('popups')).popups || {};
const setPopups = popups => chrome.storage.session.set({ popups });

async function sessionForChild(tabId, parentFrameId) {
  const frames = await getFrames();
  return Object.entries(frames).find(([, f]) => f.tabId === tabId && f.frameId === parentFrameId)?.[0] || null;
}

function randomToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' })[c]);
}

async function installRules(tabId, desktopHost, nested) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: ruleIdsFor(tabId),
    addRules: buildSessionRules(tabId, desktopHost, { nested }),
  });
}

async function removeRules(tabId) {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ruleIdsFor(tabId) });
  const tabs = await getTabs();
  if (tabs[tabId]) { delete tabs[tabId]; await setTabs(tabs); }
  const frames = await getFrames();
  const kept = Object.fromEntries(Object.entries(frames).filter(([, f]) => f.tabId !== tabId));
  if (Object.keys(kept).length !== Object.keys(frames).length) await setFrames(kept);
}

async function recordOpen(url) {
  const { history = [] } = await chrome.storage.local.get('history');
  history.push(historyEntry(url, Date.now()));
  await chrome.storage.local.set({ history: history.slice(-HISTORY_MAX) });
}

async function handle(msg, sender) {
  const who = checkDesktopSender(sender, { dev: DEV });
  if (!who.ok) return { ok: false, error: who.reason };
  const tabId = who.tabId;
  const desktopHost = new URL(who.origin).hostname;
  switch (msg && msg.type) {
    case 'nakli-browser:hello':
      return { ok: true, version: chrome.runtime.getManifest().version, dev: DEV };
    case 'nakli-browser:open': {
      const url = parseSiteUrl(msg.url);
      if (!url) return { ok: false, error: 'bad-url' };
      const pattern = originPattern(url);
      const granted = await chrome.permissions.contains({ origins: [pattern] });
      const tabs = await getTabs();
      tabs[tabId] = { desktopHost, windows: Array.from(new Set([...(tabs[tabId]?.windows || []), msg.windowId || 'browser'])), nested: !!(tabs[tabId]?.nested || msg.nested) };
      await setTabs(tabs);
      await installRules(tabId, desktopHost, tabs[tabId].nested);
      const minted = mintToken(pruneTokens(await getTokens(), Date.now()), { tabId, url: url.href, random: randomToken, now: Date.now() });
      await setTokens(minted.store);
      return { ok: true, token: minted.token, needsPermission: !granted, pattern, frame: chrome.runtime.getURL('frame.html') };
    }
    case 'nakli-browser:closed': {
      const tabs = await getTabs();
      const entry = tabs[tabId];
      if (!entry) return { ok: true };
      entry.windows = entry.windows.filter(w => w !== (msg.windowId || 'browser'));
      if (entry.windows.length === 0) await removeRules(tabId);
      else { tabs[tabId] = entry; await setTabs(tabs); }
      return { ok: true };
    }
    case 'nakli-browser:sites': {
      const all = await chrome.permissions.getAll();
      return { ok: true, sites: (all.origins || []).filter(o => o !== '<all_urls>') };
    }
    case 'nakli-browser:forget': {
      if (typeof msg.pattern !== 'string') return { ok: false, error: 'bad-pattern' };
      const removed = await chrome.permissions.remove({ origins: [msg.pattern] });
      return { ok: true, removed };
    }
    case 'nakli-browser:history': {
      const { history = [] } = await chrome.storage.local.get('history');
      return { ok: true, history };
    }
    default:
      return { ok: false, error: 'unknown-message' };
  }
}

chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  locked(() => handle(msg, sender)).then(reply, e => reply({ ok: false, error: String(e && e.message || e) }));
  return true; // reply asynchronously
});

// Messages from frame.html (inside the extension): redeem the token for the URL to frame.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  locked(async () => {
    if (sender.id !== chrome.runtime.id || !sender.tab) return { ok: false, error: 'not-extension-frame' };
    if (msg && msg.type === 'frame:redeem') {
      const out = redeemToken(await getTokens(), msg.token, { tabId: sender.tab.id, now: Date.now() });
      await setTokens(out.store);
      if (!out.ok) return { ok: false, error: out.reason };
      const frames = await getFrames();
      frames[msg.token] = { tabId: sender.tab.id, frameId: sender.frameId };
      await setFrames(frames);
      const url = parseSiteUrl(out.url);
      const granted = await chrome.permissions.contains({ origins: [originPattern(url)] });
      if (granted) await recordOpen(out.url);
      return { ok: true, url: out.url, granted, pattern: originPattern(url) };
    }
    if (msg && msg.type === 'frame:open-full') {
      // Layout C: the whole tab is an extension page, so third-party cookie blocking does not apply.
      const url = parseSiteUrl(msg.url);
      if (!url) return { ok: false, error: 'bad-url' };
      if (!(await chrome.permissions.contains({ origins: [originPattern(url)] }))) return { ok: false, error: 'no-permission' };
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`page.html?u=${encodeURIComponent(url.href)}`) });
      return { ok: true, tabId: tab.id };
    }
    if (msg && msg.type === 'page:ready') {
      // page.html asks for the header rules in its own tab. Only extension pages reach onMessage, and
      // the tab must be showing page.html itself.
      if (!sender.url || !sender.url.startsWith(chrome.runtime.getURL('page.html'))) return { ok: false, error: 'not-page' };
      await installRules(sender.tab.id, null, false);
      const tabs = await getTabs();
      tabs[sender.tab.id] = { desktopHost: null, windows: ['page'], nested: false };
      await setTabs(tabs);
      return { ok: true };
    }
    if (msg && msg.type === 'frame:cookie-count') {
      const url = parseSiteUrl(msg.url);
      if (!url) return { ok: false, error: 'bad-url' };
      // The count only, never a value: enough to tell signed in from signed out.
      const cookies = await chrome.cookies.getAll({ url: url.origin });
      return { ok: true, count: cookies.length };
    }
    return { ok: false, error: 'unknown-message' };
  }).then(reply, e => reply({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// The rules live only as long as the desktop that asked for them.
chrome.tabs.onRemoved.addListener(tabId => { locked(() => removeRules(tabId)); });
chrome.webNavigation.onCommitted.addListener(d => {
  if (d.frameId === 0) locked(async () => { const tabs = await getTabs(); if (tabs[d.tabId]) await removeRules(d.tabId); });
});

// The site's own navigations: tell its frame.html the new address (for the toolbar and its history).
chrome.webNavigation.onCommitted.addListener(d => locked(async () => {
  if (d.frameId === 0) return;
  const sid = await sessionForChild(d.tabId, d.parentFrameId);
  if (!sid) return;
  if (isSignInUrl(d.url)) return signInPopup(d); // a redirect landed on a sign-in page
  chrome.runtime.sendMessage({ type: 'bg:committed', sessionId: sid, url: d.url }).catch(() => {});
}));

// Sign-in pages refuse frames; open them in a top-level popup, then reload the frame when it closes.
// A site usually reaches the sign-in host through a redirect, which onBeforeNavigate does not show, so
// the committed (refused) URL and the error URL are checked too. One popup per session at a time.
async function signInPopup(d) {
  if (d.frameId === 0 || !isSignInUrl(d.url)) return;
  const sid = await sessionForChild(d.tabId, d.parentFrameId);
  if (!sid) return;
  const open = await getPopups();
  if (Object.values(open).includes(sid)) return;
  const win = await chrome.windows.create({ url: d.url, type: 'popup', width: 520, height: 720, focused: true });
  const popups = await getPopups();
  popups[win.id] = sid;
  await setPopups(popups);
  chrome.runtime.sendMessage({ type: 'bg:signin-opened', sessionId: sid, url: d.url }).catch(() => {});
}
chrome.webNavigation.onBeforeNavigate.addListener(d => locked(() => signInPopup(d)));
chrome.webNavigation.onErrorOccurred.addListener(d => locked(() => signInPopup(d)));
chrome.windows.onRemoved.addListener(windowId => locked(async () => {
  const popups = await getPopups();
  const sid = popups[windowId];
  if (!sid) return;
  delete popups[windowId];
  await setPopups(popups);
  chrome.runtime.sendMessage({ type: 'bg:signin-closed', sessionId: sid }).catch(() => {});
}));
