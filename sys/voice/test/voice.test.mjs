// voice.test.mjs — the voice assistant's pure parts: the stub model, tools, the voice-activity
// detector and the session's tool loop, interrupt and history trimming. No browser, no model.
import assert from 'node:assert/strict';
import { createStubModel, tone, INPUT_SAMPLE_RATE } from '../adapter.mjs';
import { createToolRegistry, createTimers, builtinTools } from '../tools.mjs';
import { createVoiceSession } from '../session.mjs';
import { createVad, createTurnRecorder, concatFloat32, createSpeechFallback } from '../audio.mjs';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log('ok', name); };

const opened = [];
const host = {
  listApps: async () => [{ id: 'notes', name: 'Notes' }, { id: 'files', name: 'Files' }, { id: 'calendar', name: 'Calendar' }],
  openApp: async (id) => { opened.push(id); },
};
const fakeNav = { onLine: true, connection: { effectiveType: '4g' }, getBattery: async () => ({ level: 0.42, charging: true }) };
const makeTools = (timers) => createToolRegistry(builtinTools({ host, timers, nav: fakeNav, now: () => new Date('2026-10-30T10:15:00Z') }));
const fakePlayer = () => {
  const p = { chunks: [], stopped: 0, enqueue: (c) => p.chunks.push(c), stop: () => { p.stopped++; }, drained: async () => {} };
  return p;
};

await test('tools list in the LocalMind shape', () => {
  const t = makeTools(createTimers());
  const names = t.list().map((x) => x.name);
  assert.deepEqual(names, ['set_timer', 'get_battery', 'get_network_status', 'open_app', 'get_time']);
  for (const x of t.list()) { assert.equal(x.parameters.type, 'object'); assert.equal(typeof x.description, 'string'); assert.equal(x.run, undefined); }
});

await test('tool arguments are checked before a tool runs', async () => {
  const t = makeTools(createTimers());
  assert.deepEqual(await t.run('set_timer', {}), { ok: false, error: 'missing seconds' });
  assert.equal((await t.run('set_timer', { seconds: 'ten' })).error, 'seconds must be a number');
  assert.equal((await t.run('set_timer', { seconds: 0 })).error, 'seconds must be at least 1');
  assert.equal((await t.run('get_time', { extra: 1 })).error, 'unknown argument extra');
  assert.equal((await t.run('nope', {})).error, 'unknown tool nope');
});

await test('built-in tools answer from the injected browser and host', async () => {
  const t = makeTools(createTimers({ setTimeoutFn: () => 0, clearTimeoutFn: () => {} }));
  assert.deepEqual((await t.run('get_battery')).result, { available: true, level: 0.42, charging: true });
  assert.deepEqual((await t.run('get_network_status')).result, { online: true, effectiveType: '4g' });
  assert.equal((await t.run('get_time')).result.iso, '2026-10-30T10:15:00.000Z');
  assert.deepEqual((await t.run('open_app', { name: 'cal' })).result, { id: 'calendar', name: 'Calendar' });
  assert.equal((await t.run('open_app', { name: 'zzz' })).error, 'No app called zzz');
  assert.equal((await t.run('set_timer', { seconds: 5 })).result.seconds, 5);
  const noBattery = createToolRegistry(builtinTools({ host, timers: createTimers(), nav: {} }));
  assert.deepEqual((await noBattery.run('get_battery')).result, { available: false });
});

await test('timers fire onDone and can be cancelled', () => {
  const pending = new Map(); let seq = 0; const done = [];
  const timers = createTimers({ onDone: (t) => done.push(t), setTimeoutFn: (fn) => { pending.set(++seq, fn); return seq; }, clearTimeoutFn: (h) => pending.delete(h) });
  const a = timers.start(3, 'tea'); timers.start(9);
  assert.equal(timers.list().length, 2);
  pending.get(1)();
  assert.deepEqual(done, [{ id: a.id, seconds: 3, label: 'tea' }]);
  assert.equal(timers.cancel('timer-2'), true);
  assert.equal(timers.list().length, 0);
});

await test('VAD starts on speech and ends after silence', () => {
  const vad = createVad({ minSpeechMs: 100, endSilenceMs: 300 });
  const frame = (amp) => { const f = new Float32Array(160); for (let i = 0; i < f.length; i++) f[i] = amp * Math.sin(i / 3); return f; };
  const events = [];
  for (let i = 0; i < 30; i++) events.push(vad.push(frame(0.001)));   // 300 ms of room noise
  for (let i = 0; i < 20; i++) events.push(vad.push(frame(0.2)));     // 200 ms of speech
  for (let i = 0; i < 40; i++) events.push(vad.push(frame(0.001)));   // 400 ms of silence
  const fired = events.map((e, i) => e && [e, i]).filter(Boolean);
  assert.deepEqual(fired.map((x) => x[0]), ['start', 'end']);
  assert.equal(fired[0][1], 30 + 9);   // 10 frames × 10 ms = 100 ms
  assert.equal(fired[1][1], 50 + 29);  // 30 frames × 10 ms = 300 ms
});

await test('turn recorder caps at the turn length and joins frames', () => {
  const rec = createTurnRecorder({ maxSeconds: 1 });
  let full = false;
  for (let i = 0; i < 120 && !full; i++) full = rec.push(new Float32Array(160).fill(i));
  assert.equal(full, true);
  assert.equal(rec.seconds, 1);
  assert.equal(rec.take().length, INPUT_SAMPLE_RATE);
  assert.deepEqual([...concatFloat32([new Float32Array([1]), new Float32Array([2, 3])])], [1, 2, 3]);
});

await test('stub speaks a tone per word and echoes text', async () => {
  const m = createStubModel({ wordMs: 0 });
  const audio = []; let text = '';
  const out = await m.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }] }], tools: [], onText: (d) => { text += d; }, onAudio: (a) => audio.push(a) });
  assert.equal(out.text, 'You said: hello there');
  assert.equal(text, out.text);
  assert.equal(audio.length, 4);
  assert.equal(audio[0].length, tone().length);
  const heard = await m.generate({ messages: [{ role: 'user', content: [{ type: 'audio', audio: new Float32Array(INPUT_SAMPLE_RATE * 2) }] }] });
  assert.match(heard.text, /2\.0 seconds of audio/);
});

await test('session runs a tool round trip and speaks the result', async () => {
  const player = fakePlayer(); const states = []; const toolEvents = [];
  const s = createVoiceSession({ model: createStubModel({ wordMs: 0 }), tools: makeTools(createTimers({ setTimeoutFn: () => 0 })), player, onState: (x) => states.push(x), onTool: (e) => toolEvents.push(e) });
  const out = await s.sendText('what is my battery level');
  assert.equal(out.stopReason, 'stop');
  assert.equal(out.text, 'Battery is at 42 percent and charging.');
  assert.equal(toolEvents[0].name, 'get_battery');
  assert.deepEqual(states, ['thinking', 'speaking', 'idle']);
  assert.ok(player.chunks.length > 0);
  assert.deepEqual(s.history.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  await s.sendText('open notes');
  assert.equal(opened.at(-1), 'notes');
});

await test('interrupt stops the reply and the audio at once', async () => {
  const player = fakePlayer();
  const s = createVoiceSession({ model: createStubModel({ wordMs: 20 }), tools: makeTools(createTimers()), player });
  const turn = s.sendText('one two three four five six seven eight nine ten');
  await new Promise((r) => setTimeout(r, 50));
  s.startListening(); // barge-in: the person talks over the reply
  const out = await turn;
  assert.equal(out.stopReason, 'aborted');
  assert.ok(out.text.split(/\s+/).length < 8);
  assert.ok(player.stopped >= 1);
  assert.equal(s.state, 'listening');
});

await test('older turns drop their audio and history keeps the last turns', async () => {
  const s = createVoiceSession({ model: createStubModel({ wordMs: 0 }), tools: createToolRegistry(), keepTurns: 2 });
  await s.sendAudio(new Float32Array(1600));
  await s.sendAudio(new Float32Array(1600));
  await s.sendText('third');
  const users = s.history.filter((m) => m.role === 'user');
  assert.equal(users.length, 2);
  assert.deepEqual(users[0].content, [{ type: 'text', text: '[spoken message]' }]);
  assert.deepEqual(users[1].content, [{ type: 'text', text: 'third' }]);
});

await test('tool rounds stop at the cap', async () => {
  let calls = 0;
  const loopy = { id: 'loopy', async generate({ tools }) { calls++; return tools.length ? { text: '', toolCalls: [{ name: 'get_time', arguments: {} }], stopReason: 'tool_calls' } : { text: 'done', toolCalls: [], stopReason: 'stop' }; } };
  const s = createVoiceSession({ model: loopy, tools: makeTools(createTimers()), maxToolRounds: 2 });
  await s.sendText('time');
  assert.equal(calls, 3);
});

function fakeSynth({ local = true } = {}) {
  const synth = { spoken: [], cancelled: 0, queue: [],
    getVoices: () => [{ name: 'Cloud', lang: 'en-US', localService: false }, ...(local ? [{ name: 'Samantha', lang: 'en-US', localService: true, default: true }] : [])],
    speak(u) { synth.spoken.push([u.text, u.voice.name]); synth.queue.push(u); },
    cancel() { synth.cancelled++; synth.queue = []; },
    finishAll() { synth.queue.splice(0).forEach((u) => u.onend()); } };
  return synth;
}
class FakeUtterance { constructor(text) { this.text = text; } }

await test('speech fallback speaks whole sentences with an on-device voice only', () => {
  const synth = fakeSynth();
  const sp = createSpeechFallback({ synth, Utterance: FakeUtterance });
  assert.equal(sp.push('Hello the'), false);
  assert.equal(sp.push('re. How are'), true);
  sp.flush(); sp.push(' you'); sp.flush();
  assert.deepEqual(synth.spoken.map((x) => x[1]), ['Samantha', 'Samantha', 'Samantha']);
  assert.deepEqual(synth.spoken.map((x) => x[0]), ['Hello there.', 'How are', 'you']);
  const none = createSpeechFallback({ synth: fakeSynth({ local: false }), Utterance: FakeUtterance });
  assert.equal(none.available, false);
  assert.equal(none.push('Nothing leaves the machine. '), false);
});

await test('a text-only model is spoken by the fallback and interrupt cancels it', async () => {
  const synth = fakeSynth();
  const speech = createSpeechFallback({ synth, Utterance: FakeUtterance });
  const states = [];
  const s = createVoiceSession({ model: createStubModel({ wordMs: 0, audioOut: false }), tools: makeTools(createTimers()), speech, onState: (x) => states.push(x) });
  const turn = s.sendText('hello. there');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(synth.spoken.map((x) => x[0]), ['You said: hello.', 'there']);
  assert.equal(s.state, 'speaking');
  synth.finishAll();
  assert.equal((await turn).stopReason, 'stop');
  assert.deepEqual(states, ['thinking', 'speaking', 'idle']);
  const slow = createVoiceSession({ model: createStubModel({ wordMs: 0, audioOut: false }), tools: makeTools(createTimers()), speech });
  const t2 = slow.sendText('a long reply.');
  await new Promise((r) => setTimeout(r, 20));
  slow.interrupt();
  assert.ok(synth.cancelled >= 1);
  await t2;
});


// ── LFM3-Omni adapter over a fake anyformer ──
const { createLfm3OmniModel, visibleEnd, toTemplateMessages } = await import('../lfm3-omni.mjs');
function fakeAnyformer(replies) {
  const seen = { loads: 0, calls: [] };
  const session = {
    async *generate(messages, opts) {
      seen.calls.push({ messages, opts });
      const reply = replies.shift();
      let text = '';
      for (const piece of reply) { if (opts.signal?.aborted) return; text += piece; yield { text, tokens: text.length }; }
    },
    dispose() {},
  };
  return { seen, importer: async () => ({ MODELS: { chat: { LFM3_OMNI_2B: 'lfm3' } }, load: async (id, { onProgress }) => { seen.loads++; onProgress?.({ loaded: 1, total: 2 }); return session; } }) };
}

await test('visibleEnd holds tool markup and partial markers', () => {
  assert.equal(visibleEnd('Sure. <tool_call>\n<function=x>'), 6);
  assert.equal(visibleEnd('Sure <tool'), 5);
  assert.equal(visibleEnd('a < b'), 5);
  assert.equal(visibleEnd('ends with <'), 10);
  assert.equal(visibleEnd('<function=get_time>'), 0);
});

await test('LFM3 adapter streams text, hides tool XML and parses calls against the offered tools', async () => {
  const xml = '<tool_call>\n<function=set_timer>\n<parameter=seconds>\n90\n</parameter>\n</function>\n</tool_call>';
  const fake = fakeAnyformer([['One moment. ', ...xml.match(/.{1,5}/gs)], ['Timer ', 'set.']]);
  const m = createLfm3OmniModel({ importer: fake.importer });
  const progress = [];
  await m.load({ onProgress: (p) => progress.push(p) });
  assert.equal(m.ready, true);
  assert.deepEqual(progress, [{ loaded: 1, total: 2 }]);
  const tools = makeTools(createTimers()).list();
  let streamed = '';
  const out = await m.generate({ messages: [{ role: 'user', content: [{ type: 'audio', audio: new Float32Array(16) }] }], tools, onText: (d) => { streamed += d; } });
  assert.equal(streamed, 'One moment. ');
  assert.deepEqual(out.toolCalls, [{ name: 'set_timer', arguments: { seconds: 90 } }]);
  assert.equal(out.stopReason, 'tool_calls');
  assert.equal(fake.seen.calls[0].opts.tools.length, 5);
  assert.equal(fake.seen.calls[0].opts.thinking, false);
  const again = await m.generate({ messages: [], tools: [] });
  assert.equal(again.text, 'Timer set.');
  assert.equal(fake.seen.calls[1].opts.tools, undefined);
  assert.equal(fake.seen.loads, 1);
});

await test('LFM3 adapter refuses tools it was not offered and releases a stray "<"', async () => {
  const fake = fakeAnyformer([['<tool_call><function=rm_rf></function></tool_call>'], ['x <', ' y']]);
  const m = createLfm3OmniModel({ importer: fake.importer });
  const bad = await m.generate({ messages: [], tools: makeTools(createTimers()).list() });
  assert.deepEqual(bad.toolCalls, []);
  let streamed = '';
  const ok = await m.generate({ messages: [], tools: [], onText: (d) => { streamed += d; } });
  assert.equal(streamed, 'x < y');
  assert.equal(ok.text, 'x < y');
});

await test('history reaches the chat template with tool_calls and tool results', () => {
  const msgs = toTemplateMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: [{ type: 'audio', audio: new Float32Array(4) }] },
    { role: 'assistant', content: [{ type: 'text', text: '' }], toolCalls: [{ name: 'get_time', arguments: {} }] },
    { role: 'tool', name: 'get_time', content: '{"ok":true}' },
  ]);
  assert.equal(msgs[1].content[0].type, 'audio');
  assert.deepEqual(msgs[2], { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'get_time', arguments: {} } }] });
  assert.deepEqual(msgs[3], { role: 'tool', content: '{"ok":true}' });
});

await test('a session tool round runs end to end on the LFM3 adapter', async () => {
  const xml = '<tool_call>\n<function=get_battery>\n</function>\n</tool_call>';
  const fake = fakeAnyformer([[xml], ['Battery is at 42 percent.']]);
  const s = createVoiceSession({ model: createLfm3OmniModel({ importer: fake.importer }), tools: makeTools(createTimers()) });
  const out = await s.sendText('battery?');
  assert.equal(out.text, 'Battery is at 42 percent.');
  assert.equal(fake.seen.calls[1].messages.at(-1).role, 'tool');
  assert.equal(fake.seen.calls[1].messages.at(-2).tool_calls[0].function.name, 'get_battery');
});

console.log(`voice + lfm3 adapter: ${pass} passed`);
