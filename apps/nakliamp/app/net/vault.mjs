// vault.mjs — sealed storage for the ListenBrainz token and signed network grants (N15).
//
// On naklios.dev every mirrored app shares one origin, so any of them can read and write
// NakliAmp's localStorage. Two things there must not change silently: the network grants
// (the person's consent) and the ListenBrainz token (whose account receives the listens).
//
// The vault holds two keys that WebCrypto creates as non-extractable: an AES-GCM key that
// seals secrets and an HMAC key that signs the grant record. The keys and the sealed
// values live in IndexedDB (`nakliamp-vault`). Another app on the origin can no longer
// read the token by reading a storage key, and a grant record it writes by hand fails the
// signature, so NakliAmp treats those grants as off until the person turns them on again.
//
// Limit, stated plainly: code on the same origin that is written against NakliAmp can
// still open this database and use the keys through WebCrypto, because the browser's
// boundary is the origin. The vault stops silent and generic access (a storage dump, a
// hand-written grant record); only a separate origin stops a deliberate attack.

const DB_NAME = 'nakliamp-vault';
const STORE = 'items';
const ALGO_SEAL = { name: 'AES-GCM', length: 256 };
const ALGO_SIGN = { name: 'HMAC', hash: 'SHA-256' };

const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

/**
 * The IndexedDB backend: `get(name)`, `putIfAbsent(name, value)` (returns what is stored
 * afterwards, so two tabs creating the first key agree on one), `put` and `remove`.
 */
export function indexedDbBackend({ indexedDB = globalThis.indexedDB, name = DB_NAME } = {}) {
  if (!indexedDB) throw new Error('IndexedDB is not available, so the vault cannot keep anything.');
  let dbPromise = null;
  const db = () => {
    dbPromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return dbPromise;
  };
  const tx = async (mode, fn) => {
    const store = (await db()).transaction(STORE, mode).objectStore(STORE);
    return new Promise((resolve, reject) => {
      const request = fn(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    get: key => tx('readonly', store => store.get(key)),
    put: (key, value) => tx('readwrite', store => store.put(value, key)),
    remove: key => tx('readwrite', store => store.delete(key)),
    async putIfAbsent(key, value) {
      const store = (await db()).transaction(STORE, 'readwrite').objectStore(STORE);
      return new Promise((resolve, reject) => {
        const read = store.get(key);
        read.onerror = () => reject(read.error);
        read.onsuccess = () => {
          if (read.result !== undefined) { resolve(read.result); return; }
          const write = store.add(value, key);
          write.onsuccess = () => resolve(value);
          write.onerror = () => reject(write.error);
        };
      });
    },
  };
}

/** An in-memory backend, for tests. */
export function memoryBackend(map = new Map()) {
  return {
    map,
    get: async key => map.get(key),
    put: async (key, value) => { map.set(key, value); },
    remove: async key => { map.delete(key); },
    putIfAbsent: async (key, value) => { if (!map.has(key)) map.set(key, value); return map.get(key); },
  };
}

async function keyFor(backend, subtle, name, make) {
  const stored = await backend.get(name);
  if (stored) return stored;
  return backend.putIfAbsent(name, await make());
}

/**
 * Open the vault. Resolves to `{ seal(name, text), unseal(name), remove(name), sign(text),
 * verify(text, signature) }`; every method is async.
 */
export async function openVault({ backend = null, subtle = globalThis.crypto?.subtle, random = globalThis.crypto } = {}) {
  if (!subtle) throw new Error('WebCrypto is not available, so the vault cannot seal anything.');
  const store = backend ?? indexedDbBackend();
  const sealKey = await keyFor(store, subtle, 'key:seal', () => subtle.generateKey(ALGO_SEAL, false, ['encrypt', 'decrypt']));
  const signKey = await keyFor(store, subtle, 'key:sign', () => subtle.generateKey(ALGO_SIGN, false, ['sign', 'verify']));
  return {
    async seal(name, text) {
      const iv = random.getRandomValues(new Uint8Array(12));
      const data = await subtle.encrypt({ name: 'AES-GCM', iv }, sealKey, enc.encode(String(text)));
      await store.put(`sealed:${name}`, { iv: toB64(iv), data: toB64(data) });
    },
    /** The sealed text, or null when nothing is stored or it does not open with this key. */
    async unseal(name) {
      const item = await store.get(`sealed:${name}`);
      if (!item || typeof item.iv !== 'string' || typeof item.data !== 'string') return null;
      try {
        return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(item.iv) }, sealKey, fromB64(item.data)));
      } catch { return null; }
    },
    remove: name => store.remove(`sealed:${name}`),
    sign: async text => toB64(await subtle.sign('HMAC', signKey, enc.encode(String(text)))),
    async verify(text, signature) {
      if (typeof signature !== 'string' || !signature) return false;
      try { return await subtle.verify('HMAC', signKey, fromB64(signature), enc.encode(String(text))); } catch { return false; }
    },
  };
}

/**
 * A token holder with a synchronous face over the vault: `get()` answers from memory,
 * `set(token)` (an empty token clears) updates memory at once and seals in the background.
 * `ready` resolves once the sealed token has been read; a token set before that wins.
 * `onChange(fn)` hears the load. With no vault the token lasts for this page only.
 */
export function sealedToken(vaultPromise, name = 'listenbrainz-token') {
  let token = '';
  let touched = false;
  const listeners = new Set();
  const persist = value => vaultPromise
    .then(vault => (value ? vault.seal(name, value) : vault.remove(name)))
    .catch(() => { /* no vault: the token lasts for this page */ });
  const ready = vaultPromise
    .then(vault => vault.unseal(name))
    .then(value => { if (!touched && typeof value === 'string') token = value; })
    .catch(() => {})
    .then(() => { for (const fn of listeners) { try { fn(token); } catch { /* listener's own */ } } });
  return {
    ready,
    get: () => token,
    set(value) {
      touched = true;
      token = String(value ?? '');
      return persist(token);
    },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}
