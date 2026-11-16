// consent.mjs — per-origin opt-in grants for NakliAmp's network features (T8, T9, I1).
//
// NakliAmp's default is no network: nothing here grants anything on its own. The
// person turns a provider on in Settings, which calls `grant(origin)`; every network
// module calls `assertAllowed(url)` before each request and refuses by name when the
// origin is not granted. Grants live in localStorage (`nakliamp:network`); blocked
// storage means no grants, so the player stays offline.
//
// On a shared origin (naklios.dev) other apps can write that key. With a `vault`
// (app/net/vault.mjs) the record carries an HMAC signature made with a key no page can
// export, and a record whose signature fails is not trusted (N15): its grants stay off
// and are listed as `unconfirmed` until the person turns them on again in the Network
// panel. Until the signature is checked (`ready`), nothing is granted.
//
// No audio ever leaves the page. KNOWN_ORIGINS lists, for each provider, exactly what
// it receives, so the Settings screen can say so before the person turns it on.

export const NETWORK_KEY = 'nakliamp:network';

export class NetworkConsentError extends Error {
  /** `code`: 'not-granted' (the person has not turned this origin on) or 'bad-origin'. */
  constructor(code, message, origin = null) {
    super(`[${code}] ${message}`);
    this.name = 'NetworkConsentError';
    this.code = code;
    this.origin = origin;
  }
}

/** The providers NakliAmp knows, what each one receives, and the parity row it serves. */
export const KNOWN_ORIGINS = Object.freeze([
  Object.freeze({
    origin: 'https://musicbrainz.org', label: 'MusicBrainz', row: 'T8',
    purpose: 'Look up album, artist, track numbers and year for a release.',
    sends: 'The artist, album and track title text you search for, and the release id you pick.',
  }),
  Object.freeze({
    origin: 'https://coverartarchive.org', label: 'Cover Art Archive', row: 'T8',
    purpose: 'Fetch the front cover of a MusicBrainz release.',
    sends: 'The MusicBrainz release id. The archive answers with a redirect to archive.org, which receives the same id.',
    alsoContacts: Object.freeze(['https://archive.org', 'https://*.archive.org']),
  }),
  Object.freeze({
    origin: 'https://lrclib.net', label: 'LRCLIB', row: 'T9',
    purpose: 'Fetch synced or plain lyrics for a track that has none.',
    sends: 'The track title, artist, album and length in seconds.',
  }),
  Object.freeze({
    origin: 'https://api.listenbrainz.org', label: 'ListenBrainz', row: 'I1',
    purpose: 'Record what you listen to on your ListenBrainz profile (scrobbling).',
    sends: 'Your ListenBrainz token, and for each listen: artist, title, album, track number, length and the time you played it.',
  }),
]);

const knownByOrigin = new Map(KNOWN_ORIGINS.map(k => [k.origin, k]));

/**
 * The origin of a URL or origin string, normalised (`https://host[:port]`).
 * Only https origins, and http on localhost or 127.0.0.1, are accepted, because an
 * HTTPS page cannot reach any other http origin.
 */
export function originOf(urlOrOrigin) {
  let url;
  try { url = new URL(String(urlOrOrigin)); } catch {
    throw new NetworkConsentError('bad-origin', `${String(urlOrOrigin)} is not a web address.`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new NetworkConsentError('bad-origin', `${url.origin} is not https, so this page cannot reach it.`, url.origin);
  }
  return url.origin;
}

const storedGrants = parsed => (parsed && typeof parsed === 'object' && parsed.grants && typeof parsed.grants === 'object' ? parsed.grants : {});

/** The stored record: `{ grants, sig }`, with every origin checked. */
function readRecord(storage) {
  try {
    const raw = storage?.getItem(NETWORK_KEY);
    if (!raw) return { grants: {}, sig: null };
    const parsed = JSON.parse(raw);
    const out = {};
    for (const [origin, value] of Object.entries(storedGrants(parsed))) {
      try { if (originOf(origin) === origin) out[origin] = { grantedAt: Number(value?.grantedAt) || 0 }; } catch { /* drop */ }
    }
    return { grants: out, sig: typeof parsed?.sig === 'string' ? parsed.sig : null };
  } catch { return { grants: {}, sig: null }; }
}

/** The text the signature covers: the granted origins and their times, sorted. */
export const grantsText = grants => JSON.stringify(Object.keys(grants).sort().map(origin => [origin, grants[origin].grantedAt]));

/**
 * `createConsent({ storage, now })` returns the grant store. `storage` defaults to
 * localStorage; pass an in-memory object in tests.
 */
export function createConsent({ storage = globalThis.localStorage, now = () => Date.now(), vault = null } = {}) {
  const stored = readRecord(storage);
  let grants = vault ? {} : stored.grants;
  let unconfirmed = {};
  const changed = new Set(); // origins the person changed before the signature was checked
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(api.list()); } catch { /* a listener's error is its own */ } } };

  const write = record => {
    try { storage?.setItem(NETWORK_KEY, JSON.stringify(record)); } catch { /* blocked storage: grants last for this page only */ }
  };
  let saving = Promise.resolve();
  const save = () => {
    const snapshot = grants;
    if (!vault) write({ version: 1, grants: snapshot });
    else {
      saving = saving
        .then(() => Promise.resolve(vault))
        .then(v => v.sign(grantsText(snapshot)))
        .then(sig => write({ version: 2, grants: snapshot, sig }), () => { /* no vault: grants last for this page only */ });
    }
    notify();
  };

  const ready = !vault ? Promise.resolve() : Promise.resolve(vault)
    .then(v => v.verify(grantsText(stored.grants), stored.sig))
    .catch(() => false)
    .then(ok => {
      const fresh = { ...grants };
      const doubt = {};
      for (const [origin, value] of Object.entries(stored.grants)) {
        if (changed.has(origin)) continue;
        if (ok) fresh[origin] = value;
        else if (knownByOrigin.has(origin)) doubt[origin] = value;
      }
      grants = fresh;
      unconfirmed = doubt;
      notify();
    });

  const api = {
    /** Every origin with its grant state, known providers first. */
    list() {
      const rows = KNOWN_ORIGINS.map(k => ({
        ...k, granted: !!grants[k.origin], grantedAt: grants[k.origin]?.grantedAt ?? null,
        unconfirmed: !grants[k.origin] && !!unconfirmed[k.origin],
      }));
      for (const origin of Object.keys(grants)) {
        if (!knownByOrigin.has(origin)) rows.push({ origin, label: origin, row: null, purpose: 'An origin you added.', sends: 'What the feature that uses it sends.', granted: true, grantedAt: grants[origin].grantedAt });
      }
      return rows;
    },
    known: () => KNOWN_ORIGINS,
    isAllowed(urlOrOrigin) {
      try { return !!grants[originOf(urlOrOrigin)]; } catch { return false; }
    },
    grant(urlOrOrigin) {
      const origin = originOf(urlOrOrigin);
      changed.add(origin);
      if (unconfirmed[origin]) { const { [origin]: _confirmed, ...rest } = unconfirmed; unconfirmed = rest; }
      if (!grants[origin]) { grants = { ...grants, [origin]: { grantedAt: now() } }; save(); }
      return origin;
    },
    revoke(urlOrOrigin) {
      const origin = originOf(urlOrOrigin);
      changed.add(origin);
      if (unconfirmed[origin]) { const { [origin]: _gone, ...rest } = unconfirmed; unconfirmed = rest; save(); }
      if (grants[origin]) { const { [origin]: _gone, ...rest } = grants; grants = rest; save(); }
      return origin;
    },
    /** Resolves once a vault-signed record has been checked (at once without a vault). */
    ready,
    /** Resolves once the last change is written (signed) to storage. */
    saved: () => saving,
    /** Throws NetworkConsentError('not-granted') unless the person turned this origin on. */
    assertAllowed(urlOrOrigin) {
      const origin = originOf(urlOrOrigin);
      if (!grants[origin]) {
        const label = knownByOrigin.get(origin)?.label ?? origin;
        if (unconfirmed[origin]) throw new NetworkConsentError('not-granted', `${label} (${origin}) was turned on outside NakliAmp's Network panel, so it stays off. Turn it on there to confirm.`, origin);
        throw new NetworkConsentError('not-granted', `${label} (${origin}) is off. Turn it on in Settings, Network to use it.`, origin);
      }
      return origin;
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return api;
}

/**
 * A fetch that checks consent first and never sends cookies or a referrer.
 * Every network module wraps its injected `fetch` with this.
 */
export function consentedFetch(fetchFn, consent) {
  if (typeof fetchFn !== 'function') throw new TypeError('consentedFetch needs a fetch function');
  if (!consent || typeof consent.assertAllowed !== 'function') throw new TypeError('consentedFetch needs a consent object');
  return (url, init = {}) => {
    consent.assertAllowed(url);
    return fetchFn(String(url), { credentials: 'omit', referrerPolicy: 'no-referrer', ...init });
  };
}
