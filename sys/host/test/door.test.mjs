// Conformance: the outside door (sys/host/door.mjs). Pairing is an ECDH exchange with a code both sides derive; the
// key never crosses the relay; requests are signed, time-bound and single-use (across tabs); answers are signed;
// abandon stops a call; revoke takes effect at the next request; the connection backs off when another tab holds it.
//
//   node sys/host/test/door.test.mjs

import assert from 'node:assert/strict';
import { createHmac, randomBytes, webcrypto } from 'node:crypto';
import { createDoor, connectDoor, memoryKeyStore, pairingCode, DOOR_CLIENTS_KEY, DOOR_NONCES_KEY } from '../door.mjs';

const subtle = webcrypto.subtle;
const hmac = (key, text) => createHmac('sha256', key).update(text).digest('hex');
const b64u = b => Buffer.from(b).toString('base64url');

function setup({ answers = [], clock = { t: Date.now() }, store = new Map(), keys = memoryKeyStore(), pairTimeoutMs } = {}) {
  const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  const asked = [], calls = [], history = [], revoked = [];
  const catalog = [
    { name: 'notes.list.read', description: 'Read a list', input: { type: 'object', required: ['list'] }, scope: 'app:read', destructive: false, app: 'notes' },
    { name: 'notes.note.trash', description: 'Trash a note', input: { type: 'object' }, scope: 'app:write', destructive: true, app: 'notes' },
  ];
  const door = createDoor({
    storage, keys, now: () => clock.t, pairTimeoutMs,
    confirmPair: async (client, code) => { asked.push([client, code]); const a = answers.shift(); return typeof a === 'function' ? a() : (a ?? false); },
    search: async q => catalog.filter(c => !q || c.name.includes(q) || c.description.toLowerCase().includes(q)),
    call: async (client, name, input, options) => { calls.push({ client, name, input, options, cancelledAtCall: options.cancelled() }); return { ok: true, result: { items: ['milk'] } }; },
    record: e => { history.push(e); },
    onRevoke: c => revoked.push(c),
  });
  const request = (op, client, key, inner, { ts = clock.t, nonce = randomBytes(18).toString('base64url'), id = 'r' + Math.random() } = {}) => {
    const payload = JSON.stringify(inner);
    return { id, op, body: { client, ts, nonce, payload, mac: hmac(key, `${op}\n${ts}\n${nonce}\n${payload}`) } };
  };
  const verify = (key, req, answer) => answer.mac === undefined ? null
    : (answer.mac === hmac(key, `reply\n${req.body.nonce}\n${answer.payload}`) ? JSON.parse(answer.payload) : 'BAD');
  return { door, store, keys, asked, calls, history, revoked, clock, request, verify };
}

// What the CLI does: ECDH, HKDF, the code, then step 2 with the signature check. Returns the raw key and the code.
async function pairProgram(t, client = 'cli') {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pubC = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const start = JSON.parse((await t.door.handle({ op: 'pair-start', body: { client, pub: b64u(pubC) } })).payload);
  if (!start.ok) return { start };
  const pubH = Buffer.from(start.pub, 'base64url');
  const theirs = await subtle.importKey('raw', pubH, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: theirs }, pair.privateKey, 256);
  const ikm = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const key = Buffer.from(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: Buffer.concat([pubC, pubH]), info: new TextEncoder().encode('naklios-door v1 key') }, ikm, 256));
  const code = await pairingCode(webcrypto, pubC, pubH);
  const answer = await t.door.handle({ op: 'pair', body: { pairing: start.pairing } });
  const finish = JSON.parse(answer.payload);
  const signedOK = answer.mac === hmac(key, `pair\n${start.pairing}\n${answer.payload}`);
  return { start, finish, key, code, signedOK, pubC, pubH };
}

// The code vector the Go CLI also checks (tools/naklios-door/relay_test.go TestPairingCodeVector).
{
  const c = new Uint8Array(65).fill(1); c[0] = 4;
  const h = new Uint8Array(65).fill(2); h[0] = 4;
  assert.equal(await pairingCode(webcrypto, c, h), 'U7ES-8S2H');
}

// Pairing: the dialog shows the code the program derived; the answer is signed with the agreed key; nothing secret
// is in any answer; the key is kept as a non-extractable CryptoKey; a decline keeps nothing; no re-pairing over a name.
{
  const t = setup({ answers: [true, true] });
  const p = await pairProgram(t);
  assert.equal(p.finish.ok, true);
  assert.equal(p.signedOK, true, 'the pairing answer is signed with the key both sides derived');
  assert.deepEqual(t.asked, [['cli', p.code]], 'the dialog shows the code the program printed');
  assert.ok(!JSON.stringify(p.start).includes(b64u(p.key)) && !JSON.stringify(p.finish).includes(b64u(p.key)), 'the key never appears in an answer');
  const stored = await t.keys.get('cli');
  assert.equal(stored.extractable, false, 'the host cannot export the key');
  assert.ok(!t.store.get(DOOR_CLIENTS_KEY).includes(b64u(p.key)), 'nothing secret in localStorage');
  assert.equal((await pairProgram(t)).start.code, 'EEXIST', 'a second pairing cannot replace a working one');

  const denied = setup({ answers: [false] });
  const d = await pairProgram(denied, 'lua');
  assert.equal(d.finish.code, 'EDENIED');
  assert.equal(await denied.keys.get('lua'), null);
  for (const body of [{ client: 'Bad Name', pub: 'x' }, { client: 'ok', pub: 'not-a-key' }, { client: 'ok', pub: b64u(new Uint8Array(65)) }])
    assert.equal(JSON.parse((await t.door.handle({ op: 'pair-start', body })).payload).code, 'EINVAL');
  assert.equal(JSON.parse((await t.door.handle({ op: 'pair', body: { pairing: 'nope' } })).payload).code, 'EINVAL');
}

// Pairings are kept by id (a new one never removes another's), at most 4; one dialog at a time; an unanswered
// dialog times out and frees its slot.
{
  const t = setup({ answers: [() => new Promise(() => {})], pairTimeoutMs: 50 });
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const startOf = async client => JSON.parse((await t.door.handle({ op: 'pair-start', body: { client, pub } })).payload);
  const one = await startOf('one'), two = await startOf('two');
  assert.notEqual(one.pairing, two.pairing, 'a second pairing keeps the first');
  await startOf('three'); await startOf('four');
  assert.equal((await startOf('five')).code, 'EBUSY', 'at most four pairings at once');
  const finishing = t.door.handle({ op: 'pair', body: { pairing: one.pairing } });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(JSON.parse((await t.door.handle({ op: 'pair', body: { pairing: two.pairing } })).payload).code, 'EBUSY', 'one dialog at a time');
  assert.equal(JSON.parse((await finishing).payload).code, 'EDENIED', 'an unanswered dialog counts as not allowed');
  assert.equal(JSON.parse((await t.door.handle({ op: 'pair', body: { pairing: one.pairing } })).payload).code, 'EINVAL', 'a finished pairing is gone');
  await new Promise(r => setTimeout(r, 60));
  assert.equal((await startOf('six')).ok, true, 'stale pairings that never reached a dialog are dropped');
}

// Signed calls; abandon; History.
{
  const t = setup({ answers: [true] });
  const { key } = await pairProgram(t);
  const q = t.request('search', 'cli', key, { query: 'notes' });
  assert.deepEqual(t.verify(key, q, await t.door.handle(q)).results.map(c => c.name), ['notes.list.read', 'notes.note.trash']);
  const d = t.request('describe', 'cli', key, { name: 'notes.list.read' });
  assert.deepEqual(t.verify(key, d, await t.door.handle(d)).command.input.required, ['list']);
  const r = t.request('call', 'cli', key, { name: 'notes.list.read', input: { list: 'shopping' } });
  assert.deepEqual(t.verify(key, r, await t.door.handle(r)), { ok: true, result: { items: ['milk'] } });
  assert.equal(t.calls[0].client, 'cli');
  assert.equal(t.calls[0].options.ask, false);
  assert.equal(t.calls[0].cancelledAtCall, false);
  const late = t.request('call', 'cli', key, { name: 'notes.list.read', input: {}, ask: true }, { id: 'gone' });
  t.door.abandon('gone');
  await t.door.handle(late);
  assert.equal(t.calls[1].cancelledAtCall, true, 'an abandoned request reaches the host as cancelled');
  assert.equal(t.calls[1].options.ask, true);
  assert.deepEqual(t.history.map(e => [e.op, e.command ?? null, e.code]), [['pair', null, null], ['call', 'notes.list.read', null], ['call', 'notes.list.read', null]]);
}

// Authentication: wrong key, replay (also across tabs and reloads), stale time, tampering, unknown client.
{
  const store = new Map(), keys = memoryKeyStore(), clock = { t: Date.now() };
  const t = setup({ answers: [true], store, keys, clock });
  const { key } = await pairProgram(t);
  const code = async (door, req) => { const a = await door.handle(req); assert.equal(a.mac, undefined, 'a refusal before authentication is unsigned'); return JSON.parse(a.payload).code; };
  assert.equal(await code(t.door, t.request('search', 'cli', randomBytes(32), {})), 'EAUTH', 'a key that is not the program\'s');
  const once = t.request('search', 'cli', key, {});
  assert.ok(t.verify(key, once, await t.door.handle(once)).ok);
  assert.equal(await code(t.door, once), 'EAUTH', 'a replayed request');
  const otherTab = setup({ store, keys, clock });
  assert.equal(await code(otherTab.door, once), 'EAUTH', 'a replay to another tab (or after a reload) fails too');
  assert.ok(Object.keys(JSON.parse(store.get(DOOR_NONCES_KEY))).includes(once.body.nonce));
  assert.equal(await code(t.door, t.request('search', 'cli', key, {}, { ts: clock.t - 31000 })), 'EAUTH', 'outside the 30-second window');
  const tampered = t.request('call', 'cli', key, { name: 'notes.list.read', input: {} });
  tampered.body.payload = JSON.stringify({ name: 'notes.note.trash', input: {} });
  assert.equal(await code(t.door, tampered), 'EAUTH', 'a payload changed on the way');
  assert.equal(await code(t.door, t.request('search', 'emacs', key, {})), 'EAUTH', 'an unknown program');
  assert.equal(await code(t.door, { op: 'search', body: {} }), 'EAUTH');
  assert.equal(await code(t.door, { op: 'delete', body: {} }), 'EINVAL');
  // Old nonces are pruned after twice the window.
  clock.t += 61000;
  const fresh = t.request('search', 'cli', key, {});
  assert.ok(t.verify(key, fresh, await t.door.handle(fresh)).ok);
  assert.equal(JSON.parse(store.get(DOOR_NONCES_KEY))[once.body.nonce], undefined);
  // Revoke forgets the key and the consent.
  assert.deepEqual(t.door.list().map(r => r.client), ['cli']);
  await t.door.revoke('cli');
  assert.deepEqual(t.revoked, ['cli']);
  assert.equal(await keys.get('cli'), null);
  assert.equal(await code(t.door, t.request('search', 'cli', key, {})), 'EAUTH');
}

// A program that leaves before the person answers keeps nothing, and the name stays free.
{
  let release; const gate = new Promise(r => { release = r; });
  const t = setup({ answers: [() => gate.then(() => true), true] });
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = b64u(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const start = JSON.parse((await t.door.handle({ op: 'pair-start', body: { client: 'gone', pub } })).payload);
  const finishing = t.door.handle({ id: 'req-1', op: 'pair', body: { pairing: start.pairing } });
  t.door.abandon('req-1');
  release();
  assert.equal(JSON.parse((await finishing).payload).code, 'ETIMEOUT');
  assert.equal(await t.keys.get('gone'), null);
  assert.equal((await pairProgram(t, 'gone')).finish.ok, true, 'the name can be paired again');
}

// History trouble never turns a done change into an error answer.
{
  const store = new Map();
  const door = createDoor({ storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, keys: memoryKeyStore(),
    confirmPair: async () => true, search: async () => [], call: async () => ({ ok: true, result: 1 }), record: () => { throw new Error('disk full'); } });
  const { key } = await pairProgram({ door });
  const ts = Date.now(), nonce = randomBytes(18).toString('base64url'), payload = JSON.stringify({ name: 'a.b', input: {} });
  const answer = await door.handle({ id: 'x', op: 'call', body: { client: 'cli', ts, nonce, payload, mac: hmac(key, `call\n${ts}\n${nonce}\n${payload}`) } });
  assert.deepEqual(JSON.parse(answer.payload), { ok: true, result: 1, historyRecorded: false }, 'the program learns the History event is missing');
}

// The connection: answers by id, passes abandon, reconnects after a close, waits long when another tab holds the relay.
{
  const sockets = [], timers = [], abandoned = [];
  class FakeSocket { constructor(url) { this.url = url; this.sent = []; sockets.push(this); } send(d) { this.sent.push(JSON.parse(d)); } close() { this.onclose?.({ code: 1000 }); } }
  const states = [];
  const door = { handle: async req => ({ payload: JSON.stringify({ echo: req.op }) }), abandon: id => abandoned.push(id) };
  const link = connectDoor(door, { WebSocketImpl: FakeSocket, onState: s => states.push(s),
    setTimeoutFn: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeoutFn: () => {} });
  sockets[0].onopen();
  await sockets[0].onmessage({ data: JSON.stringify({ id: 'r1', op: 'search' }) });
  assert.deepEqual(sockets[0].sent, [{ id: 'r1', reply: { payload: '{"echo":"search"}' } }]);
  await sockets[0].onmessage({ data: JSON.stringify({ abandon: 'r9' }) });
  assert.deepEqual(abandoned, ['r9']);
  await sockets[0].onmessage({ data: 'not json' });
  assert.equal(sockets[0].sent.length, 1, 'malformed messages get no answer');
  sockets[0].onclose({ code: 1006 });
  assert.equal(timers.at(-1).ms, 1000, 'a dropped connection retries after a second');
  timers.at(-1).fn();
  sockets[1].onclose({ code: 4001 });
  assert.equal(states.at(-1), 'busy');
  assert.equal(timers.at(-1).ms, 30000, 'another tab holds the relay: wait 30 s, so two tabs do not take turns');
  link.stop();
  assert.equal(states.at(-1), 'off');
  sockets.at(-1).onclose?.({ code: 1000 });
  assert.equal(states.at(-1), 'off', 'a close that arrives after stop does not report waiting');
  const before = timers.length;
  sockets[1].onclose?.({ code: 1000 });
  assert.equal(timers.length, before, 'no reconnect after stop');
}

console.log('door: ok');
