// The NakliOS Browser companion extension: the decisions, as pure functions so node can test them.
// background.js and frame.js import this file; nothing here touches chrome.* directly.
//
// Design: plan/research/2026-11-10-browser-in-naklios-round2.md, section 3. The desktop (the top
// frame of a NakliOS tab) asks to open a site; the extension checks who asked, mints a one-time token
// bound to that tab, and installs session rules that remove the site's framing headers in that tab
// only. frame.html, framed directly by the desktop, checks the token and its ancestors, then frames
// the site. Requests from an extension page with host permission count as same-site, so the site
// gets the person's existing Chrome cookies.

export const DESKTOP_ORIGINS = Object.freeze(['https://naklios.dev']);
// The unpacked dev build also trusts a local serve (scripts/serve-coi.mjs). The store build drops it.
export const DEV_ORIGINS = Object.freeze(['http://127.0.0.1', 'http://localhost']);

// Sign-in pages that refuse frames by reading Sec-Fetch-*; they open in a top-level popup instead.
export const SIGN_IN_HOSTS = Object.freeze([
  { host: 'accounts.google.com' },
  { host: 'www.facebook.com', path: '/login' },
  { host: 'www.instagram.com', path: '/accounts/login' },
  { host: 'login.microsoftonline.com' },
  { host: 'appleid.apple.com' },
]);


/** The origin a desktop origin entry matches, ignoring the port for the dev hosts. */
function originMatches(origin, allowed) {
  let u;
  try { u = new URL(origin); } catch { return false; }
  return allowed.some(a => {
    const w = new URL(a);
    return u.protocol === w.protocol && u.hostname === w.hostname && (w.port === '' ? true : u.port === w.port);
  });
}

/**
 * Only the NakliOS desktop document may open a signed-in frame: the top frame of a tab, at path '/',
 * on a trusted origin. An app frame that sends its own message fails both tests.
 * Limit (2026-11-12 review): apps mirrored same-origin under /apps/<id>/ can run code in the top
 * document, so this check does not stand between them and a signed-in frame. Those apps are
 * first-party code vendored through apps/manifest.json; third-party apps run at an opaque origin and
 * cannot. Moving mirrors to their own origin would close the gap; see plan/2026-11-12-autopilot.md.
 * Returns { ok:true } or { ok:false, reason }.
 */
export function checkDesktopSender(sender, { dev = false } = {}) {
  const allowed = dev ? [...DESKTOP_ORIGINS, ...DEV_ORIGINS] : DESKTOP_ORIGINS;
  if (!sender || !sender.tab || typeof sender.tab.id !== 'number') return { ok: false, reason: 'no-tab' };
  if (sender.frameId !== 0) return { ok: false, reason: 'not-top-frame' };
  let url;
  try { url = new URL(sender.url); } catch { return { ok: false, reason: 'bad-url' }; }
  if (!originMatches(url.origin, allowed)) return { ok: false, reason: 'untrusted-origin' };
  if (sender.origin && sender.origin !== url.origin) return { ok: false, reason: 'origin-mismatch' };
  if (url.pathname !== '/' && url.pathname !== '/index.html') return { ok: false, reason: 'not-desktop-path' };
  return { ok: true, origin: url.origin, tabId: sender.tab.id };
}

/** A site the Browser may open: http(s) only, no credentials in the URL. Returns the parsed URL or null. */
export function parseSiteUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return u;
}

/** The permission pattern Chrome asks the person to grant for a site, e.g. https://github.com/* */
export function originPattern(url) {
  return `${url.protocol}//${url.hostname}/*`;
}

/** True when a URL is a sign-in page that must open in a top-level popup. */
export function isSignInUrl(raw) {
  const u = parseSiteUrl(raw);
  if (!u) return false;
  return SIGN_IN_HOSTS.some(s => u.hostname === s.host && (!s.path || u.pathname === s.path || u.pathname.startsWith(s.path + '/')));
}

/**
 * The ids of the session rules that belong to one tab, read from the rules Chrome holds, so cleanup
 * removes exactly those. Ids cannot be derived from the tab id: Chrome tab ids reach billions, and a rule
 * id must fit a 32-bit integer (a 1.66e9 tab id times 4 was refused live, 2026-11-12).
 */
export function ruleIdsFor(rules, tabId) {
  return rules.filter(r => r.condition?.tabIds?.includes(tabId)).map(r => r.id);
}

/** The `n` smallest positive rule ids that no rule in `rules` uses. */
export function freeRuleIds(rules, n) {
  const used = new Set(rules.map(r => r.id));
  const out = [];
  for (let id = 1; out.length < n; id++) if (!used.has(id)) out.push(id);
  return out;
}

/**
 * The session rules for one NakliOS tab: remove X-Frame-Options and CSP from sub-frame responses that
 * carry a framing header, in that tab only, except frames the desktop itself starts (its app windows).
 * `desktopHost` is the desktop's hostname (naklios.dev, or 127.0.0.1 for a dev serve).
 * `nested` adds the acceptance-demo rule: the inner desktop's own app frames may load too.
 */
export function buildSessionRules(tabId, desktopHost, { nested = false, ids = [1, 2] } = {}) {
  const [mainId, nestId] = ids;
  const strip = {
    type: 'modifyHeaders',
    responseHeaders: [
      { header: 'x-frame-options', operation: 'remove' },
      { header: 'content-security-policy', operation: 'remove' },
    ],
  };
  const rules = [{
    id: mainId,
    priority: 1,
    action: strip,
    condition: {
      tabIds: [tabId],
      resourceTypes: ['sub_frame'],
      // The desktop's own app frames keep their headers. A full-tab extension page (layout C) has no
      // desktop, so it passes null and nothing is excluded.
      ...(desktopHost ? { excludedInitiatorDomains: [desktopHost] } : {}),
      responseHeaders: [
        { header: 'x-frame-options' },
        { header: 'content-security-policy', values: ['*frame-ancestors*'] },
      ],
    },
  }];
  if (nested) {
    // NakliOS inside the NakliOS Browser: the inner desktop opens its own app frames, whose initiator is
    // the desktop's host, so the main rule's exclusion would leave them refused. It lives only while a
    // window that shows the desktop is open (background.js tracks that per window).
    rules.push({
      id: nestId,
      priority: 1,
      action: strip,
      condition: { tabIds: [tabId], resourceTypes: ['sub_frame'], requestDomains: [desktopHost] },
    });
  }
  return rules;
}

/**
 * One-time tokens bound to a tab and a URL. The store is a plain object (chrome.storage.session holds
 * it in the extension); the functions return the new store rather than mutating it.
 */
export const TOKEN_TTL_MS = 60_000;

export function mintToken(store, { tabId, url, random, now }) {
  const token = random();
  return { token, store: { ...store, [token]: { tabId, url, expires: now + TOKEN_TTL_MS } } };
}

/** Redeem a token: valid only once, only in its own tab, only before it expires. */
export function redeemToken(store, token, { tabId, now }) {
  const entry = store && store[token];
  const rest = { ...store };
  delete rest[token];
  if (!entry) return { ok: false, reason: 'unknown-token', store: rest };
  if (entry.expires < now) return { ok: false, reason: 'expired', store: rest };
  if (entry.tabId !== tabId) return { ok: false, reason: 'wrong-tab', store: rest };
  return { ok: true, url: entry.url, store: rest };
}

/** Drop expired tokens. */
export function pruneTokens(store, now) {
  return Object.fromEntries(Object.entries(store || {}).filter(([, e]) => e.expires >= now));
}

/**
 * frame.html runs only when its single ancestor is a trusted desktop: the desktop frames it directly.
 * An app iframe that frames frame.html adds a second ancestor and fails.
 */
export function checkAncestors(ancestorOrigins, { dev = false } = {}) {
  const list = Array.from(ancestorOrigins || []);
  const allowed = dev ? [...DESKTOP_ORIGINS, ...DEV_ORIGINS] : DESKTOP_ORIGINS;
  if (list.length !== 1) return { ok: false, reason: list.length === 0 ? 'not-framed' : 'too-deep' };
  if (!originMatches(list[0], allowed)) return { ok: false, reason: 'untrusted-parent' };
  return { ok: true };
}

/** The history line for a signed-in open: host and time, never the full address. */
export function historyEntry(url, now) {
  const u = parseSiteUrl(url);
  return { host: u ? u.hostname : 'invalid', at: new Date(now).toISOString() };
}
