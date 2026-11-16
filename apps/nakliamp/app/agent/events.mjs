// events.mjs — the runtime snapshot, the event stream and the BroadcastChannel face (M3).
//
// Shaped after cliamp's remote-control IPC v2 (github.com/bjarneo/cliamp, docs/remote-control.md,
// ipc/v2.go, ui/model/ipc_runtime.go; MIT): one snapshot of the runtime, a revision that moves
// when meaningful state changes, typed events that carry `seq` and `time`, and commands with a
// request id answered by a result. docs/agent-face.md maps each cliamp operation, event and
// snapshot field to its NakliAmp counterpart.
//
// A `{ type: 'capabilities', id }` message is answered with the names the channel accepts.
//
// Three parts, none of which touches the DOM:
//   buildSnapshot(parts)        the `player.snapshot` record, built from what the page knows,
//                               with track fields whitelisted so a path can never leak;
//   createEventPublisher(...)   diffs successive snapshots and posts events to its sinks;
//   createChannelBridge(...)    answers `{ type: 'command', name, input, id }` messages on a
//                               BroadcastChannel with `{ type: 'result', id, ok, value|error }`.
//
// The channel is same-origin only, and on naklios.dev every NakliOS app shares one origin, so
// any of them can post to it (N9). It is therefore off until the person turns it on for this
// tab (the shell opens no BroadcastChannel before that), and once on:
//   - read commands run for any caller;
//   - reversible commands run only with `auth`, an HMAC-SHA256 of the command made with this
//     tab's pairing code (`channelAuth`), which the person copies from NakliAmp into the
//     other tab. The code itself never crosses the channel, so a page listening on it cannot
//     learn it; a command must name this tab in `target`, and an id is accepted once, so a
//     signed command cannot be replayed;
//   - destructive commands, and turning on a network service (the person's consent), are
//     refused whatever the pairing, because the person cannot see who asked.

import { COMMANDS, commandByName } from '../commands/commands.mjs';

export const CHANNEL_NAME = 'nakliamp';
export const SNAPSHOT_VERSION = 1;

/** Event names, in the order one check publishes them. `position` and `error` come outside the diff. */
export const EVENT_TYPES = Object.freeze([
  'track-changed', 'state-changed', 'queue-changed', 'volume-changed', 'settings-changed', 'position', 'error',
]);

/** Commands the channel refuses although their scope is not destructive, with the reason. */
export const CHANNEL_REFUSALS = Object.freeze({
  'network.grant': 'turning on a network service is the person\'s consent, given in the app',
});

const TRACK_FIELDS = ['id', 'title', 'artist', 'album', 'year', 'durationS'];
const finite = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = v => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));

function safeTrack(track) {
  if (!track || typeof track !== 'object') return null;
  const out = {};
  for (const key of TRACK_FIELDS) {
    const value = track[key];
    out[key] = key === 'year' || key === 'durationS' ? finite(value) : text(value);
  }
  return out;
}

/**
 * The snapshot. `parts` is `{ status, queue: { length, index, revision }, playlist, eq: { enabled,
 * preset }, visualiser: { mode, linkVolume }, dsp, mono, error }`, where `status` is the
 * `player.status` result and `playlist` the name of the saved playlist the queue was loaded
 * from (cliamp's `playlist`), or null. Unknown values become null; nothing outside the
 * whitelist is copied.
 */
export function buildSnapshot(parts = {}) {
  const status = parts.status ?? {};
  return {
    version: SNAPSHOT_VERSION,
    ...playbackPart(status),
    mono: Boolean(parts.mono),
    queue: queuePart(parts.queue),
    playlist: text(parts.playlist),
    eq: { enabled: Boolean(parts.eq?.enabled), preset: text(parts.eq?.preset) ?? 'flat' },
    visualiser: { mode: text(parts.visualiser?.mode), linkVolume: Boolean(parts.visualiser?.linkVolume) },
    dsp: dspPart(status.route, parts.dsp),
    error: parts.error ? { code: text(parts.error.code), message: text(parts.error.message) } : null,
  };
}

function playbackPart(status) {
  const track = safeTrack(status.track);
  const playing = Boolean(status.playing);
  return {
    state: playing ? 'playing' : track ? 'paused' : 'stopped',
    playing,
    track,
    positionS: finite(status.positionS),
    durationS: finite(status.durationS),
    seekable: Boolean(track) && finite(status.durationS) !== null,
    volume: finite(status.volume),
    volumeDb: finite(status.volumeDb),
    muted: Boolean(status.muted),
    speed: finite(status.speed) ?? 1,
    shuffle: text(status.shuffle) ?? 'off',
    repeat: text(status.repeat) ?? 'off',
  };
}

const int = (v, fallback) => (Number.isInteger(v) ? v : fallback);

function queuePart(raw) {
  const queue = raw ?? {};
  return { length: int(queue.length, 0), index: int(queue.index, -1), revision: int(queue.revision, 0) };
}

function dspPart(route, raw) {
  const dsp = raw ?? {};
  return {
    route: text(route),
    chain: text(dsp.chain),
    lane: text(dsp.lane),
    gapless: dsp.gapless === undefined ? null : Boolean(dsp.gapless),
    crossfading: Boolean(dsp.crossfading),
    gainDb: finite(dsp.gainDb),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** What each event carries, from a snapshot. */
const PAYLOADS = {
  'track-changed': s => ({ track: s.track, durationS: s.durationS }),
  'state-changed': s => ({ state: s.state, playing: s.playing }),
  'queue-changed': s => ({ queue: s.queue, playlist: s.playlist, shuffle: s.shuffle, repeat: s.repeat }),
  'volume-changed': s => ({ volume: s.volume, volumeDb: s.volumeDb, muted: s.muted }),
  'settings-changed': s => ({ speed: s.speed, mono: s.mono, eq: s.eq, visualiser: s.visualiser, dsp: s.dsp }),
  position: s => ({ positionS: s.positionS, durationS: s.durationS }),
};

/** The events that turn `prev` into `next`, in EVENT_TYPES order. A first snapshot changes nothing. */
export function diffSnapshots(prev, next) {
  if (!prev || !next) return [];
  return ['track-changed', 'state-changed', 'queue-changed', 'volume-changed', 'settings-changed']
    .filter(type => !same(PAYLOADS[type](prev), PAYLOADS[type](next)));
}

/**
 * Publish events to every sink. A sink is `message => void`; a throwing sink is skipped.
 * `check()` diffs the current snapshot against the last one; `poke()` schedules one check
 * soon (many engine events in one task cost one check); `tick()` is the 1 Hz clock, which
 * also posts `position` while playing; `error(e)` posts at once.
 */
export function createEventPublisher({
  getSnapshot,
  sinks = [],
  instance = '',
  now = () => Date.now(),
  timers = globalThis,
  intervalMs = 1000,
} = {}) {
  if (typeof getSnapshot !== 'function') throw new TypeError('createEventPublisher needs getSnapshot');
  let last = null;
  let seq = 0;
  let revision = 0;
  let timer = null;
  let pokeTimer = null;

  function post(event, data) {
    seq += 1;
    const message = { type: 'event', event, seq, revision, time: now(), instance, data };
    for (const sink of sinks) {
      try { sink(message); } catch { /* one dead sink must not stop the others */ }
    }
    return message;
  }

  function read() {
    try { return getSnapshot(); } catch { return null; }
  }

  function check() {
    const next = read();
    if (!next) return [];
    const changes = diffSnapshots(last, next);
    last = next;
    if (!changes.length) return [];
    revision += 1;
    return changes.map(type => post(type, PAYLOADS[type](next)));
  }

  function tick() {
    const posted = check();
    if (last?.playing) posted.push(post('position', PAYLOADS.position(last)));
    return posted;
  }

  return {
    check,
    tick,
    poke() {
      if (pokeTimer !== null) return;
      pokeTimer = timers.setTimeout(() => { pokeTimer = null; check(); }, 0);
    },
    error(error) {
      return post('error', { code: text(error?.code) ?? 'refused', message: text(error?.message ?? error) });
    },
    /** The snapshot with this publisher's revision, for `player.snapshot`. */
    snapshot() {
      check();
      return last ? { ...last, revision, instance } : null;
    },
    revision: () => revision,
    start() {
      if (timer !== null) return;
      last = read();
      timer = timers.setInterval(tick, intervalMs);
    },
    stop() {
      if (timer !== null) timers.clearInterval(timer);
      if (pokeTimer !== null) timers.clearTimeout(pokeTimer);
      timer = null;
      pokeTimer = null;
    },
  };
}

/**
 * Why the channel will not run `name`, as `{ code, message }`, or null when it will.
 * `paired` is true when the command carried a valid pairing signature.
 */
export function channelRefusal(name, { paired = false } = {}, commands = commandByName) {
  const command = commands.get(name);
  if (!command) return { code: 'not-found', message: `No command named ${String(name)}.` };
  if (command.scope === 'destructive') {
    return { code: 'refused', message: `${name} is destructive, and the channel accepts read and reversible commands only. Run it in NakliAmp, where you approve the change.` };
  }
  if (CHANNEL_REFUSALS[name] || command.askEveryTime) {
    return { code: 'refused', message: `${name} is not accepted on the channel: ${CHANNEL_REFUSALS[name] ?? 'it needs the person\'s consent in the app'}.` };
  }
  if (command.scope !== 'read' && !paired) {
    return { code: 'refused', message: `${name} changes the player, so the channel runs it only when it is signed with this tab's pairing code. Copy the code from NakliAmp (Tools, Agent channel).` };
  }
  return null;
}

/** The names the channel accepts: read ones from anyone, and with `paired` the reversible ones too. */
export const channelCommandNames = (commands = COMMANDS, { paired = false } = {}) =>
  commands.filter(c => !channelRefusal(c.name, { paired })).map(c => c.name);

const PAIRING_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** A fresh pairing code: 20 characters (about 99 bits) in groups of five, easy to read aloud. */
export function newPairingCode(random = globalThis.crypto) {
  const bytes = random.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map(b => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
  return chars.match(/.{5}/g).join('-');
}

/** The exact text a pairing signature covers. */
export const channelAuthText = ({ target, id, name, input }) =>
  ['nakliamp-channel-v1', String(target ?? ''), String(id ?? ''), String(name ?? ''), JSON.stringify(input ?? {})].join('\n');

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * The `auth` a caller puts on a command: base64url HMAC-SHA256 of channelAuthText, keyed
 * with the pairing code as typed (dashes and case ignored). Both sides use this function.
 */
export async function channelAuth({ code, target, id, name, input }, subtle = globalThis.crypto.subtle) {
  const raw = new TextEncoder().encode(String(code ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase());
  const key = await subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await subtle.sign('HMAC', key, new TextEncoder().encode(channelAuthText({ target, id, name, input }))));
}

// Constant-time comparison of two strings of the same length.
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Results cross a structured-clone boundary; JSON keeps them to plain data.
function plain(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
}

const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));

/**
 * Answer commands on `channel` (a BroadcastChannel, or anything with postMessage and
 * addEventListener). `run(name, input, options)` is the bound command runner. Messages that
 * are not commands, or that name another `target` instance, are ignored. After each command
 * the publisher checks, so the events a command caused follow its result.
 * `pairingCode()` returns this tab's current pairing code, or null when none is set; a
 * reversible command runs only with a valid `auth` for that code, a `target` naming this
 * tab, and an id this bridge has not seen.
 */
export function createChannelBridge({ channel, run, publisher = null, instance = '', pairingCode = () => null, subtle = globalThis.crypto?.subtle } = {}) {
  if (!channel || typeof channel.postMessage !== 'function') throw new TypeError('createChannelBridge needs a channel');
  if (typeof run !== 'function') throw new TypeError('createChannelBridge needs the bound command runner');

  const reply = (id, body) => {
    const message = { type: 'result', id: validId(id) ? id : null, instance, ...body };
    try { channel.postMessage(message); } catch { /* channel closed */ }
    return message;
  };

  // A message this tab should ignore: not an object, or addressed to another tab.
  const notForUs = message => !message || typeof message !== 'object'
    || (message.target !== undefined && message.target !== instance);

  const seen = new Set();
  // True when the message is signed with this tab's pairing code, names this tab, and its id is new.
  async function isPaired({ id, name, input, target, auth }) {
    const code = pairingCode();
    if (!code || typeof auth !== 'string' || target !== instance || !validId(id) || seen.has(String(id)) || !subtle) return false;
    let expected;
    try { expected = await channelAuth({ code, target, id, name, input }, subtle); } catch { return false; }
    if (!sameText(auth, expected)) return false;
    seen.add(String(id));
    if (seen.size > 10_000) seen.delete(seen.values().next().value);
    return true;
  }

  async function runCommand(message) {
    const { id, name, input } = message;
    const needsPairing = commandByName.get(name)?.scope === 'reversible';
    const paired = needsPairing ? await isPaired(message) : false;
    const refusal = channelRefusal(name, { paired });
    if (refusal) return reply(id, { ok: false, error: refusal });
    try {
      const value = await run(name, input && typeof input === 'object' ? input : {}, { context: { from: 'channel' } });
      const sent = reply(id, { ok: true, value: plain(value) });
      publisher?.check();
      return sent;
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'refused';
      const message = String(error?.message ?? error).replace(/^\[[a-z-]+\] /, '');
      return reply(id, { ok: false, error: { code, message } });
    }
  }

  async function handle(message) {
    if (notForUs(message)) return null;
    // cliamp's `capabilities`: the command names this channel accepts.
    if (message.type === 'capabilities') {
      return reply(message.id, { ok: true, value: {
        channel: CHANNEL_NAME,
        commands: channelCommandNames(),
        paired: channelCommandNames(COMMANDS, { paired: true }),
        pairing: { auth: 'HMAC-SHA256, base64url', covers: 'nakliamp-channel-v1, target, id, name, JSON input; one per line', available: Boolean(pairingCode()) },
      } });
    }
    if (message.type === 'command') return runCommand(message);
    return null;
  }

  const listener = event => { handle(event?.data); };
  channel.addEventListener?.('message', listener);
  return {
    handle,
    /** A sink for createEventPublisher. */
    sink: message => channel.postMessage(message),
    close() {
      channel.removeEventListener?.('message', listener);
      try { channel.close?.(); } catch { /* already closed */ }
    },
  };
}

/** A random id for this page, so a caller can address one of several open NakliAmp tabs. */
export function instanceId(random = () => Math.random()) {
  return `nakliamp-${Math.floor(random() * 0x100000000).toString(16).padStart(8, '0')}`;
}
