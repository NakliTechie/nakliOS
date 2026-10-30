// voice.test.mjs — the voice assistant's pure parts: the stub model, tools, the voice-activity
// detector and the session's tool loop, interrupt and history trimming. No browser, no model.
import assert from 'node:assert/strict';
import { createStubModel, tone, INPUT_SAMPLE_RATE } from '../adapter.mjs';
import { createToolRegistry, createTimers, builtinTools } from '../tools.mjs';
import { createVoiceSession } from '../session.mjs';
import { createVad, createTurnRecorder, concatFloat32 } from '../audio.mjs';

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

console.log(`voice: ${pass} passed`);
