// The NakliOS Browser: the companion extension's decisions (extension/lib.mjs) and the host window's
// address handling (sys/browser/window.mjs). Pure functions only; the live behaviour needs the
// extension loaded in Chrome and is checked there.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  checkDesktopSender, parseSiteUrl, originPattern, buildSessionRules, ruleIdsFor, freeRuleIds,
  mintToken, redeemToken, pruneTokens, checkAncestors, historyEntry, TOKEN_TTL_MS,
} from '../extension/lib.mjs';
import { normaliseAddress } from '../sys/browser/window.mjs';
import * as lib from '../extension/lib.mjs';
import * as win from '../sys/browser/window.mjs';

const tab = id => ({ id });
// Only the desktop: top frame, path '/', trusted origin.
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 0, url: 'https://naklios.dev/', origin: 'https://naklios.dev' }).ok, true);
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 0, url: 'https://naklios.dev/index.html?x=1' }).ok, true);
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 3, url: 'https://naklios.dev/apps/notes/' }).reason, 'not-top-frame', 'a mirrored app frame is refused');
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 0, url: 'https://naklios.dev/apps/notes/' }).reason, 'not-desktop-path', 'a mirrored app opened top-level is refused');
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 0, url: 'https://naklios.dev.evil.example/' }).reason, 'untrusted-origin');
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 0, url: 'http://naklios.dev/' }).reason, 'untrusted-origin', 'plain http is not the desktop');
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 0, url: 'https://naklios.dev/', origin: 'https://other.example' }).reason, 'origin-mismatch');
assert.equal(checkDesktopSender({ frameId: 0, url: 'https://naklios.dev/' }).reason, 'no-tab');
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 0, url: 'http://127.0.0.1:8964/' }).reason, 'untrusted-origin', 'a local serve is trusted only by the dev build');
assert.equal(checkDesktopSender({ tab: tab(7), frameId: 0, url: 'http://127.0.0.1:8964/' }, { dev: true }).ok, true);

// Addresses.
assert.equal(parseSiteUrl('javascript:alert(1)'), null);
assert.equal(parseSiteUrl('https://user:pw@github.com/'), null, 'no credentials in the URL');
assert.equal(originPattern(parseSiteUrl('https://github.com/a/b?c')), 'https://github.com/*');
assert.equal(normaliseAddress('github.com'), 'https://github.com/');
// Light browsing (2026-11-13): no sign-in handling is left to call.
assert.equal(lib.isSignInUrl, undefined, 'no sign-in popup list');
assert.equal(win.shouldOpenFull, undefined, 'no Full tab');
assert.equal(normaliseAddress('  https://github.com/x  '), 'https://github.com/x');
assert.equal(normaliseAddress('hello world'), null);
assert.equal(normaliseAddress('ftp://x.example'), null);
assert.equal(normaliseAddress('intranet'), null, 'a bare word is not an address');

// Session rules: one tab, sub-frames only, the desktop's own frames excluded.
const rules = buildSessionRules(7, 'naklios.dev');
assert.equal(rules.length, 1);
assert.deepEqual(rules[0].condition.tabIds, [7]);
assert.deepEqual(rules[0].condition.resourceTypes, ['sub_frame']);
assert.deepEqual(rules[0].condition.excludedInitiatorDomains, ['naklios.dev']);
assert.ok(rules[0].condition.responseHeaders.length > 0, 'fires only on responses that carry a framing header');
assert.deepEqual(rules[0].action.responseHeaders.map(h => h.header).sort(), ['content-security-policy', 'x-frame-options']);
assert.deepEqual(ruleIdsFor(rules, 7), rules.map(r => r.id));
assert.deepEqual(ruleIdsFor(rules, 8), [], 'another tab owns none of these rules');
// Real Chrome tab ids reach billions (1660080632 seen live); rule ids must stay 32-bit integers.
const bigTab = 1660080632;
const big = buildSessionRules(bigTab, 'naklios.dev', { nested: true, ids: freeRuleIds(rules, 2) });
assert.ok(big.every(r => Number.isInteger(r.id) && r.id > 0 && r.id <= 2 ** 31 - 1), 'rule ids fit a 32-bit integer for any tab id');
assert.equal(new Set([...rules, ...big].map(r => r.id)).size, rules.length + big.length, 'rule ids never collide across tabs');
assert.deepEqual(freeRuleIds([{ id: 1 }, { id: 3 }], 2), [2, 4]);
const nested = buildSessionRules(7, 'naklios.dev', { nested: true });
assert.equal(nested.length, 2);
assert.deepEqual(nested[1].condition.requestDomains, ['naklios.dev']);

// Tokens: once, in their own tab, before they expire.
let n = 0;
const random = () => `tok${++n}`;
let { token, store } = mintToken({}, { tabId: 7, url: 'https://github.com/', random, now: 1000 });
assert.equal(redeemToken(store, token, { tabId: 8, now: 1001 }).reason, 'wrong-tab');
({ token, store } = mintToken({}, { tabId: 7, url: 'https://github.com/', random, now: 1000 }));
const first = redeemToken(store, token, { tabId: 7, now: 1001 });
assert.equal(first.ok, true);
assert.equal(first.url, 'https://github.com/');
assert.equal(redeemToken(first.store, token, { tabId: 7, now: 1002 }).reason, 'unknown-token', 'a token works once');
({ token, store } = mintToken({}, { tabId: 7, url: 'https://github.com/', random, now: 1000 }));
assert.equal(redeemToken(store, token, { tabId: 7, now: 1000 + TOKEN_TTL_MS + 1 }).reason, 'expired');
assert.deepEqual(Object.keys(pruneTokens({ a: { expires: 5 }, b: { expires: 50 } }, 10)), ['b']);

// frame.html runs only when the desktop frames it directly.
assert.equal(checkAncestors(['https://naklios.dev']).ok, true);
assert.equal(checkAncestors(['https://naklios.dev', 'https://naklios.dev']).reason, 'too-deep', 'an app iframe that frames frame.html is refused');
assert.equal(checkAncestors([]).reason, 'not-framed');
assert.equal(checkAncestors(['https://evil.example']).reason, 'untrusted-parent');
assert.equal(checkAncestors(['http://127.0.0.1:8964'], { dev: true }).ok, true);

// History keeps the host only.
assert.deepEqual(Object.keys(historyEntry('https://github.com/secret/path?q=1', 0)), ['host', 'at']);
assert.equal(historyEntry('https://github.com/secret/path?q=1', 0).host, 'github.com');

// The manifest: no blanket host permission at install, the dev build named as such, no inline script.
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.ok(!(manifest.host_permissions || []).length, 'host access is asked per site at first use');
assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
assert.ok(!manifest.permissions.includes('declarativeNetRequest'), 'the with-host-access variant shows no install warning');
const exposed = manifest.web_accessible_resources.flatMap(w => w.resources);
assert.ok(!manifest.permissions.includes('cookies'), 'light browsing reads no cookies');
assert.deepEqual(exposed.sort(), ['frame.css', 'frame.html', 'frame.js', 'lib.mjs']);
await assert.rejects(readFile(new URL('../extension/page.html', import.meta.url)), 'the Full tab page is gone');
const frameHtml = await readFile(new URL('../extension/frame.html', import.meta.url), 'utf8');
assert.match(frameHtml, /<iframe id="site"[^>]*\bcredentialless\b/, 'the site frame sends no cookies');
assert.ok(!/publickey-credentials/.test(frameHtml), 'no passkeys inside the window');
const winSrc = await readFile(new URL('../sys/browser/window.mjs', import.meta.url), 'utf8');
assert.ok(/data-act="tab"[^>]*>Open in Chrome</.test(winSrc), 'the window offers Open in Chrome');
assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/.test(frameHtml), 'MV3 pages carry no inline script');
// The deployed site never ships the extension.
assert.match(await readFile(new URL('../.assetsignore', import.meta.url), 'utf8'), /^extension\/$/m);
console.log('browser-extension: sender check, tokens, session rules, ancestors, addresses, history and manifest pass');

// The store build: no local hosts, no plain-http sites, no blanket host permission, the same files.
const storeManifest = JSON.parse(await readFile(new URL('../extension/manifest.store.json', import.meta.url), 'utf8'));
const storeText = JSON.stringify(storeManifest);
assert.ok(!/127\.0\.0\.1|localhost/.test(storeText), 'the store build trusts no local host');
assert.ok(!/<all_urls>/.test(storeText) && !(storeManifest.host_permissions || []).length, 'no host access at install');
assert.deepEqual(storeManifest.optional_host_permissions, ['https://*/*']);
assert.ok(!storeManifest.name.includes('(dev)'), 'the store build is not the dev build');
assert.deepEqual(storeManifest.permissions, manifest.permissions, 'the store build asks for what the dev build asks for');
assert.equal(storeManifest.version, manifest.version);
console.log('browser-extension: the store manifest trusts naklios.dev only');
