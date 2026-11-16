// The outside door (plan/2026-11-16-codemode-rail-bridge-plan.md, slice 2): programs on this computer (a shell, Emacs,
// native Lua, a bot) reach the same rail catalog as apps and scripts, through the loopback relay `naklios-door`
// (tools/naklios-door). A browser tab cannot accept connections, so the host dials out to the relay over WebSocket.
//
// Authority stays here; the relay only forwards, and nothing secret ever crosses it.
// - Pairing is an ECDH P-256 exchange. Both sides derive the same 32-byte key with HKDF and the same 8-character code
//   from both public keys. The person allows the program only if the host dialog shows the code the program printed,
//   and the program asks the person to confirm the same in the terminal before it keeps the key. A relay that swaps
//   keys produces two different codes; a process posing as the host never gets the real dialog shown.
// - The host keeps each key as a non-extractable CryptoKey (IndexedDB), so no script on this origin can read it.
// - Each request carries a time, a single-use nonce and an HMAC-SHA256 over the operation, time, nonce and exact
//   payload. Used nonces persist across tabs and reloads. Each answer carries an HMAC over the nonce and the reply.
//
// Same-origin mirrors (naklios.dev/apps/<id>/) share this origin and its storage, so they are inside this boundary
// already. Every call names its caller `door:<client>`, goes through the host's command path (which refuses every
// destructive command for a door caller), and is one History event. Three verbs only: search, describe, call.

export const DOOR_CLIENTS_KEY = 'nakliOS.doorClients.v3'; // { [client]: { pairedAt } }; keys live in the key store
export const DOOR_NONCES_KEY = 'nakliOS.door.nonces';     // { [nonce]: first seen (ms) }, pruned
export const DOOR_ENABLED_KEY = 'nakliOS.door.enabled';   // '1' when the person turned the door on
export const DOOR_PORT = 7461;
export const DOOR_URL = `ws://127.0.0.1:${DOOR_PORT}/host`;
export const CLOCK_SKEW_MS = 30000;
export const PAIR_TIMEOUT_MS = 120000;
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
const CLIENT = /^[a-z][a-z0-9-]{0,31}$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SEARCH_MAX = 20;
const PAYLOAD_MAX = 1 << 20;
const enc = new TextEncoder();

const b64u = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return out; };
const brief = c => ({ name: c.name, description: c.description, scope: c.scope ?? null, destructive: !!c.destructive, app: c.app ?? null });

// The pairing code both sides show: 8 characters from SHA-256 over a label and both public keys.
export async function pairingCode(crypto, pubC, pubH) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', concat(enc.encode('naklios-door v1 code'), pubC, pubH)));
  const chars = Array.from(h.slice(0, 8), b => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return chars.slice(0, 4) + '-' + chars.slice(4);
}

// Keys as non-extractable CryptoKeys. memoryKeyStore for tests; idbKeyStore in the browser.
export function memoryKeyStore() {
  const m = new Map();
  return { get: async c => m.get(c) || null, put: async (c, k) => { m.set(c, k); }, delete: async c => { m.delete(c); } };
}
export function idbKeyStore(indexedDB = globalThis.indexedDB, name = 'naklios-door') {
  const db = new Promise((resolve, reject) => {
    const open = indexedDB.open(name, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('keys');
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  const tx = async (mode, fn) => { const d = await db; return new Promise((resolve, reject) => {
    const t = d.transaction('keys', mode); const req = fn(t.objectStore('keys'));
    t.oncomplete = () => resolve(req?.result ?? null); t.onerror = () => reject(t.error); }); };
  return { get: c => tx('readonly', s => s.get(c)), put: (c, k) => tx('readwrite', s => s.put(k, c)), delete: c => tx('readwrite', s => s.delete(c)) };
}

/**
 * @param {{
 *   storage: { getItem(k: string): string | null, setItem(k: string, v: string): void },
 *   keys: { get(c: string): Promise<CryptoKey|null>, put(c: string, k: CryptoKey): Promise<void>, delete(c: string): Promise<void> },
 *   confirmPair: (client: string, code: string, signal: AbortSignal) => Promise<boolean>,
 *   search: (query: string) => Promise<Array<any>>,
 *   call: (client: string, name: string, input: object, options: { ask: boolean, cancelled: () => boolean }) => Promise<any>,
 *   record?: (event: { client: string, op: string, command?: string, code: string | null }) => Promise<void> | void,
 *   onRevoke?: (client: string) => void,
 *   crypto?: Crypto, now?: () => number, pairTimeoutMs?: number,
 * }} deps
 */
export function createDoor({ storage, keys, confirmPair, search, call, record = () => {}, onRevoke = () => {}, crypto = globalThis.crypto, now = Date.now, pairTimeoutMs = PAIR_TIMEOUT_MS }) {
  const readJSON = (k, fallback) => { try { return JSON.parse(storage.getItem(k) || 'null') || fallback; } catch (_) { return fallback; } };
  const writeJSON = (k, v) => { try { storage.setItem(k, JSON.stringify(v)); } catch (_) {} };
  const clients = () => readJSON(DOOR_CLIENTS_KEY, {});
  const abandoned = new Set();           // relay request ids whose program stopped waiting
  const pendings = new Map();            // pairing id → { id, client, code, key, expires, answering }, at most 4
  let dialogOpen = false;                // one pairing dialog on screen at a time
  const sign = async (key, text) => hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
  // History trouble never turns a done change into an error; the answer says the event is missing instead.
  const record_ = async event => { try { await record(event); return true; } catch (_) { return false; } };

  // Step 1: the program sends its public key; the host answers with its own and remembers the derived key and code.
  // Nothing is stored and no dialog opens yet; the program prints the code first.
  async function pairStart(client, pub) {
    if (typeof client !== 'string' || !CLIENT.test(client)) return { ok: false, code: 'EINVAL', message: 'client must be 1-32 lowercase letters, digits or hyphens, starting with a letter' };
    if (clients()[client]) return { ok: false, code: 'EEXIST', message: `a program named "${client}" is already allowed; revoke it in Settings → AI first` };
    // Pairings are kept by id, so a new one never removes another program's; stale ones (no dialog within two minutes)
    // are dropped first. A process that floods pair-start fills four slots for two minutes and shows nothing.
    for (const [k, v] of pendings) if (!v.answering && v.expires <= now()) pendings.delete(k);
    if (pendings.size >= 4) return { ok: false, code: 'EBUSY', message: 'too many pairings in progress; try again in two minutes' };
    let pubC;
    try { pubC = unb64u(String(pub)); } catch (_) { return { ok: false, code: 'EINVAL', message: 'pub must be a base64url P-256 public key' }; }
    if (pubC.length !== 65 || pubC[0] !== 4) return { ok: false, code: 'EINVAL', message: 'pub must be an uncompressed P-256 public key' };
    let theirs;
    try { theirs = await crypto.subtle.importKey('raw', pubC, { name: 'ECDH', namedCurve: 'P-256' }, false, []); }
    catch (_) { return { ok: false, code: 'EINVAL', message: 'pub is not a valid P-256 point' }; }
    const mine = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    const pubH = new Uint8Array(await crypto.subtle.exportKey('raw', mine.publicKey));
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirs }, mine.privateKey, 256);
    const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: concat(pubC, pubH), info: enc.encode('naklios-door v1 key') },
      ikm, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign']);
    const id = b64u(crypto.getRandomValues(new Uint8Array(16)));
    pendings.set(id, { id, client, code: await pairingCode(crypto, pubC, pubH), key, expires: now() + pairTimeoutMs, answering: null });
    return { ok: true, pairing: id, pub: b64u(pubH) };
  }

  // Step 2: the host shows the code and asks. On Allow it keeps the key and answers signed with it, which proves to the
  // program that the side it paired with derived the same key.
  async function pairFinish(id, requestId) {
    const p = typeof id === 'string' ? pendings.get(id) : null;
    if (!p || (!p.answering && p.expires <= now())) return { reply: { ok: false, code: 'EINVAL', message: 'no such pairing in progress; start again' } };
    if (p.answering) return p.answering;
    if (dialogOpen) return { reply: { ok: false, code: 'EBUSY', message: 'another program is waiting for the person to answer; try again after it' } };
    dialogOpen = true;
    p.answering = (async () => {
      // The dialog gets two minutes; on timeout the host closes it, so a stale Allow is never left on screen.
      p.expires = now() + pairTimeoutMs;
      const stop = new AbortController();
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => { stop.abort(); resolve('timeout'); }, pairTimeoutMs); });
      const answer = await Promise.race([confirmPair(p.client, p.code, stop.signal), timeout]).finally(() => { clearTimeout(timer); dialogOpen = false; pendings.delete(p.id); });
      // The program left (disconnected or timed out) before the person answered: keep nothing, so the name stays free.
      if (answer === true && abandoned.has(requestId)) { abandoned.delete(requestId); return { reply: { ok: false, code: 'ETIMEOUT', message: 'the program stopped waiting before the person answered; nothing was kept' } }; }
      if (answer !== true) { await record_({ client: p.client, op: 'pair', code: 'EDENIED' }); return { reply: { ok: false, code: 'EDENIED', message: 'the person did not allow this program' } }; }
      if (clients()[p.client]) return { reply: { ok: false, code: 'EEXIST', message: `a program named "${p.client}" is already allowed` } };
      await keys.put(p.client, p.key);
      const all = clients(); all[p.client] = { pairedAt: now() }; writeJSON(DOOR_CLIENTS_KEY, all);
      await record_({ client: p.client, op: 'pair', code: null });
      const payload = JSON.stringify({ ok: true, client: p.client });
      return { reply: null, payload, mac: await sign(p.key, `pair\n${p.id}\n${payload}`) };
    })();
    return p.answering;
  }

  // Single-use nonces, shared by every tab of this origin and kept across reloads for twice the time window.
  function useNonce(nonce) {
    const t = now(), seen = readJSON(DOOR_NONCES_KEY, {});
    for (const [n, at] of Object.entries(seen)) if (t - at > 2 * CLOCK_SKEW_MS) delete seen[n];
    if (seen[nonce]) return false;
    seen[nonce] = t; writeJSON(DOOR_NONCES_KEY, seen);
    return true;
  }

  async function authenticate(op, b) {
    const { client, ts, nonce, payload, mac } = b;
    if (typeof client !== 'string' || !CLIENT.test(client) || typeof payload !== 'string' || payload.length > PAYLOAD_MAX ||
        !Number.isSafeInteger(ts) || typeof nonce !== 'string' || !NONCE.test(nonce) || typeof mac !== 'string') return { error: { ok: false, code: 'EAUTH', message: 'malformed signed request' } };
    const key = clients()[client] ? await keys.get(client) : null;
    if (!key) return { error: { ok: false, code: 'EAUTH', message: 'unknown or revoked program; pair again with `naklios-door pair <name>`' } };
    if (Math.abs(now() - ts) > CLOCK_SKEW_MS) return { error: { ok: false, code: 'EAUTH', message: 'request time is outside the 30-second window' } };
    if (await sign(key, `${op}\n${ts}\n${nonce}\n${payload}`) !== mac) return { error: { ok: false, code: 'EAUTH', message: 'bad signature' } };
    if (!useNonce(nonce)) return { error: { ok: false, code: 'EAUTH', message: 'request replayed' } };
    return { key, client, nonce, payload };
  }

  async function run(op, client, body, isAbandoned) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    if (op === 'search') {
      if (b.query !== undefined && typeof b.query !== 'string') return { ok: false, code: 'EINVAL', message: 'query must be a string' };
      return { ok: true, results: (await search(b.query || '')).slice(0, SEARCH_MAX).map(brief) };
    }
    if (typeof b.name !== 'string' || !b.name) return { ok: false, code: 'EINVAL', message: 'name must be a command name from search' };
    if (op === 'describe') {
      const hit = (await search(b.name)).find(c => c.name === b.name);
      return hit ? { ok: true, command: { ...brief(hit), input: hit.input ?? null } } : { ok: false, code: 'ENOENT', message: 'no app command named ' + b.name };
    }
    if (b.input !== undefined && (typeof b.input !== 'object' || b.input === null || Array.isArray(b.input))) return { ok: false, code: 'EINVAL', message: 'input must be an object' };
    const out = await call(client, b.name, b.input || {}, { ask: b.ask === true, cancelled: isAbandoned });
    const recorded = await record_({ client, op: 'call', command: b.name, code: out?.ok === false ? (out.code || 'EFAIL') : null });
    let reply = out?.staged ? { ok: false, code: 'ESTAGED', message: 'staged for the person to review; it has not happened' }
      : out && typeof out === 'object' ? out : { ok: false, code: 'EFAIL', message: b.name + ' did not answer' };
    if (!recorded) reply = { ...reply, historyRecorded: false };
    return reply;
  }

  // One relay request → one answer `{ payload, mac? }`. Never throws. Answers without a mac are unverified refusals.
  async function handle(request) {
    const { id, op, body } = request && typeof request === 'object' ? request : {};
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const plain = reply => ({ payload: JSON.stringify(reply) });
    try {
      if (op === 'pair-start') return plain(await pairStart(b.client, b.pub));
      if (op === 'pair') { const r = await pairFinish(b.pairing, id); return r.reply ? plain(r.reply) : { payload: r.payload, mac: r.mac }; }
      if (!['search', 'describe', 'call'].includes(op)) return plain({ ok: false, code: 'EINVAL', message: 'unknown operation' });
      const auth = await authenticate(op, b);
      if (auth.error) return plain(auth.error);
      let inner; try { inner = JSON.parse(auth.payload); } catch (_) { return plain({ ok: false, code: 'EINVAL', message: 'payload must be JSON' }); }
      let reply;
      try { reply = await run(op, auth.client, inner, () => abandoned.has(id)); }
      catch (error) { reply = { ok: false, code: 'EFAIL', message: String(error?.message || error).slice(0, 2000) }; }
      finally { abandoned.delete(id); }
      const payload = JSON.stringify(reply);
      return { payload, mac: await sign(auth.key, `reply\n${auth.nonce}\n${payload}`) };
    } catch (error) {
      return plain({ ok: false, code: 'EFAIL', message: String(error?.message || error).slice(0, 2000) });
    }
  }
  // The relay says a program stopped waiting (it disconnected or timed out): its call starts nothing.
  function abandon(id) { if (typeof id === 'string') { abandoned.add(id); if (abandoned.size > 1024) abandoned.delete(abandoned.values().next().value); } }

  // Settings → AI: one row per paired program, newest first; revoke forgets its key and its consent.
  const list = () => Object.entries(clients()).map(([client, v]) => ({ client, pairedAt: v?.pairedAt || null })).sort((a, b) => (b.pairedAt || 0) - (a.pairedAt || 0));
  async function revoke(client) { const all = clients(); delete all[client]; writeJSON(DOOR_CLIENTS_KEY, all); await keys.delete(client); onRevoke(client); }

  return { handle, abandon, list, revoke };
}

// The host's connection to the relay. Each message is a request `{ id, op, body }` answered with `{ id, reply }`, or
// `{ abandon: id }`. While another NakliOS tab holds the relay this one waits (state 'busy') and retries slowly.
// `WebSocketImpl` is injectable for tests.
export function connectDoor(door, { url = DOOR_URL, WebSocketImpl = globalThis.WebSocket, onState = () => {}, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let socket = null, stopped = false, delay = 1000, timer = null;
  const open = () => {
    if (stopped) return;
    let opened = false;
    try { socket = new WebSocketImpl(url); } catch (_) { schedule(); return; }
    socket.onopen = () => { opened = true; delay = 1000; onState('connected'); };
    socket.onmessage = async event => {
      let msg; try { msg = JSON.parse(String(event.data)); } catch (_) { return; }
      if (typeof msg?.abandon === 'string') { door.abandon(msg.abandon); return; }
      if (!msg || typeof msg.id !== 'string') return;
      const reply = await door.handle(msg);
      try { socket?.send(JSON.stringify({ id: msg.id, reply })); } catch (_) {}
    };
    socket.onclose = event => {
      if (stopped) return; // stop() already reported 'off'; a late close must not report 'waiting'
      socket = null;
      // 4001: the relay already has a NakliOS tab. Wait long, so two tabs never take turns knocking each other off.
      const busy = event?.code === 4001;
      onState(busy ? 'busy' : 'waiting');
      if (busy) delay = 30000; else if (opened) delay = 1000;
      schedule();
    };
    socket.onerror = () => {};
  };
  const schedule = () => { if (stopped) return; timer = setTimeoutFn(open, delay); delay = Math.min(delay * 2, 30000); };
  open();
  return { stop() { stopped = true; clearTimeoutFn(timer); try { socket?.close(); } catch (_) {} socket = null; onState('off'); } };
}
