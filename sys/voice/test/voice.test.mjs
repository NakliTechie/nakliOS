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
      for (const piece of reply) {
        if (opts.signal?.aborted) { seen.aborted = true; return; }
        if (piece instanceof Float32Array) { yield { text, tokens: text.length, audio: piece, sampleRate: 24000 }; continue; }
        text += piece; yield { text, tokens: text.length };
      }
    },
    dispose() {},
  };
  return { seen, importer: async () => ({ MODELS: { chat: { LFM3_OMNI_2B: 'lfm3' } }, load: async (id, { onProgress, speech }) => { seen.loads++; seen.loadSpeech = speech; onProgress?.({ loaded: 1, total: 2 }); return session; } }) };
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
  const m = createLfm3OmniModel({ importer: fake.importer, speech: false });
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
  assert.equal(fake.seen.calls[0].opts.tools.length, 5);   // text-only model: no decision pass, no answer_directly
  assert.equal(fake.seen.calls[0].opts.thinking, false);
  const again = await m.generate({ messages: [], tools: [] });
  assert.equal(again.text, 'Timer set.');
  assert.equal(fake.seen.calls[1].opts.tools, undefined);
  assert.equal(fake.seen.loads, 1);
});

await test('LFM3 adapter refuses tools it was not offered and releases a stray "<"', async () => {
  const fake = fakeAnyformer([['<tool_call><function=rm_rf></function></tool_call>'], ['x <', ' y']]);
  const m = createLfm3OmniModel({ importer: fake.importer, speech: false });
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
  const s = createVoiceSession({ model: createLfm3OmniModel({ importer: fake.importer, speech: false }), tools: makeTools(createTimers()) });
  const out = await s.sendText('battery?');
  assert.equal(out.text, 'Battery is at 42 percent.');
  assert.equal(fake.seen.calls[1].messages.at(-1).role, 'tool');
  assert.equal(fake.seen.calls[1].messages.at(-2).tool_calls[0].function.name, 'get_battery');
});

await test('VAD counts voiced time so a short noise burst can be dropped', () => {
  const vad = createVad({ minSpeechMs: 100, endSilenceMs: 300 });
  const frame = (amp) => { const f = new Float32Array(160); for (let i = 0; i < f.length; i++) f[i] = amp * Math.sin(i / 3); return f; };
  for (let i = 0; i < 30; i++) vad.push(frame(0.001));
  for (let i = 0; i < 25; i++) vad.push(frame(0.2));      // 250 ms loud
  for (let i = 0; i < 10; i++) vad.push(frame(0.001));
  for (let i = 0; i < 40; i++) vad.push(frame(0.2));      // 400 ms loud
  assert.equal(vad.voicedMs, 650);
  vad.reset();
  assert.equal(vad.voicedMs, 0);
  const quiet = createVad();
  for (let i = 0; i < 30; i++) quiet.push(frame(0.004));  // steady fan-level hum
  const events = []; for (let i = 0; i < 30; i++) events.push(quiet.push(frame(0.012)));  // louder hum, still under 0.02
  assert.deepEqual(events.filter(Boolean), []);
});

await test('speech fallback reports busy while a sentence is queued', () => {
  const synth = fakeSynth();
  const sp = createSpeechFallback({ synth, Utterance: FakeUtterance });
  assert.equal(sp.busy, false);
  sp.push('Hello there. ');
  assert.equal(sp.busy, true);
  synth.finishAll();
  assert.equal(sp.busy, false);
});

await test('isCached finds the decoder from Hugging Face and nothing else', async () => {
  const { isCached } = await import('../lfm3-omni.mjs');
  const store = (urls) => ({ keys: async () => ['diskformer-models'], open: async () => ({ keys: async () => urls.map((url) => ({ url })) }) });
  const hf = 'https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX/resolve/main/onnx/';
  assert.equal(await isCached({ cacheStorage: store([hf + 'decoder_q4f16.onnx_data']), speech: false }), true);
  assert.equal(await isCached({ cacheStorage: store([hf + 'decoder_q4f16.onnx_data']) }), false);
  assert.equal(await isCached({ cacheStorage: store([hf + 'decoder_q4f16.onnx_data', hf + 'depth_decoder.onnx_data']) }), true);
  assert.equal(await isCached({ cacheStorage: store(['http://127.0.0.1:8974/onnx/decoder_q4f16.onnx_data']), speech: false }), false);
  const partial = createLfm3OmniModel();
  assert.equal(await partial.isCached({ cacheStorage: store([hf + 'decoder_q4f16.onnx_data']) }), false);
  assert.equal(partial.downloadLabel, '0.5 GB of speech files');
  assert.equal(await isCached({ cacheStorage: store(['https://huggingface.co/LiquidAI/LFM3-Omni-2B-ONNX/resolve/main/config.json']) }), false);
  assert.equal(await isCached({ cacheStorage: { keys: async () => [] } }), false);
  assert.equal(await isCached({ cacheStorage: undefined }), false);
});

// ── lookup tools (canned web replies) ──
const { lookupTools, calculate } = await import('../web-tools.mjs');
await test('calculate handles arithmetic, percentages and powers without eval', () => {
  assert.equal(calculate('15% of 2400'), 360);
  assert.equal(calculate('(3 + 4) ^ 2'), 49);
  assert.equal(calculate('2 ^ 3 ^ 2'), 512);
  assert.equal(calculate('-2 ^ 2'), -4);
  assert.equal(calculate('1,250 × 4'), 5000);
  assert.equal(calculate('sqrt(16) + pi - pi'), 4);
  assert.equal(calculate('17!'), 355687428096000);
  assert.equal(calculate('fact(5) + 3!'), 126);
  assert.throws(() => calculate('2.5!'), /whole number/);
  assert.throws(() => calculate('alert(1)'), /cannot read|needs brackets/);
  assert.throws(() => calculate('1 / 0'), /finite/);
  assert.throws(() => calculate('(1 + 2'), /not closed/);
});

await test('weather and Wikipedia shape canned replies, and the web switch stops them', async () => {
  const urls = [];
  const canned = async (url) => {
    urls.push(url);
    if (url.includes('geocoding-api')) return { results: [
      { name: 'Mumbai', admin1: 'Maharashtra', country: 'India', latitude: 19.07, longitude: 72.88, population: 12691836 },
      { name: 'Mumbai', admin1: 'Somewhere', country: 'Elsewhere', latitude: 1, longitude: 1, population: 10 } ] };
    if (url.includes('api.open-meteo.com')) return { current: { weather_code: 2, temperature_2m: 31.2, apparent_temperature: 36, relative_humidity_2m: 70, wind_speed_10m: 12 },
      daily: { time: ['2026-10-30'], weather_code: [61], temperature_2m_max: [33], temperature_2m_min: [26], precipitation_probability_max: [40] } };
    if (url.includes('wikipedia.org')) return { query: { pages: [{ title: 'Mumbai', fullurl: 'https://en.wikipedia.org/wiki/Mumbai', extract: 'Mumbai is the capital of Maharashtra.\n\nIt is a port.' }] } };
    throw new Error('unexpected ' + url);
  };
  let on = true;
  const reg = createToolRegistry(lookupTools({ webOn: () => on, fetchJsonFn: canned }));
  const w = await reg.run('get_weather', { location: 'Bombay' });
  assert.equal(w.ok, true);
  assert.match(urls[0], /name=Mumbai/);   // the old name maps to the current one
  assert.equal(w.result.location, 'Mumbai, Maharashtra, India');
  assert.equal(w.result.current.conditions, 'partly cloudy');
  assert.equal(w.result.daily[0].conditions, 'light rain');
  const k = await reg.run('wikipedia_lookup', { query: 'Mumbai' });
  assert.equal(k.result.title, 'Mumbai');
  assert.equal(k.result.summary, 'Mumbai is the capital of Maharashtra. It is a port.');
  on = false;
  const off = await reg.run('get_weather', { location: 'Pune' });
  assert.equal(off.ok, false);
  assert.match(off.error, /switched off/);
  assert.equal(urls.length, 3);   // nothing was fetched while the switch was off
  assert.deepEqual((await reg.run('calculate', { expression: '2+2' })).result, { result: 4 });
});

await test('LFM3 speech with tools: decides in text, then speaks the answer with no tools offered', async () => {
  const pcm = (n) => new Float32Array(n).fill(0.1);
  const fake = fakeAnyformer([
    ['One moment. <tool_call>\n<function=get_time>\n</function>\n</tool_call>', ' never'],   // decision, text mode
    ['It is ten.'],                                                                             // decision: no tool
    ['It is ', pcm(50), 'ten.', pcm(60)],                                                       // spoken answer
  ]);
  const m = createLfm3OmniModel({ importer: fake.importer });
  assert.equal(m.audioOut, true);
  await m.load();
  assert.equal(fake.seen.loadSpeech, true);
  const tools = makeTools(createTimers()).list();
  const audio = []; let text = '';
  const msgs = [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: 'time?' }] }];
  const out = await m.generate({ messages: msgs, tools, onText: (d) => { text += d; }, onAudio: (a) => audio.push(a.length) });
  assert.deepEqual(out.toolCalls, [{ name: 'get_time', arguments: {} }]);
  assert.deepEqual(audio, []);              // the decision is never spoken
  assert.equal(text, '');
  assert.equal(fake.seen.calls[0].opts.speech, undefined);
  assert.equal(fake.seen.calls[0].opts.tools.length, 6);   // the five tools plus answer_directly
  assert.equal(fake.seen.calls[0].opts.tools.at(-1).name, 'answer_directly');
  assert.equal(fake.seen.calls[0].opts.maxNewTokens, 128);
  assert.equal(fake.seen.calls[0].opts.signal.aborted, true);   // the closed call ended the decision
  const out2 = await m.generate({ messages: msgs, tools, onText: (d) => { text += d; }, onAudio: (a) => audio.push(a.length) });
  assert.equal(out2.text, 'It is ten.');
  assert.deepEqual(audio, [50, 60]);
  assert.equal(text, 'It is ten.');
  assert.equal(fake.seen.calls[2].opts.speech, true);
  assert.equal(fake.seen.calls[2].opts.tools, undefined);
  assert.equal(fake.seen.calls[2].messages[0].content, 'Be brief.\nRespond with interleaved text and audio.');
});

await test('LFM3 speech: audio stops at stray tool markup in a spoken reply', async () => {
  const pcm = (n) => new Float32Array(n).fill(0.1);
  const fake = fakeAnyformer([['Sure, ', pcm(100), '<tool_call>\n<function=get_time>', pcm(300), '\n</function>\n</tool_call>', pcm(400), 'never']]);
  const m = createLfm3OmniModel({ importer: fake.importer });
  const audio = [];
  const out = await m.generate({ messages: [], tools: [], onAudio: (a) => audio.push(a.length) });
  assert.deepEqual(audio, [100]);
  assert.equal(out.text.includes('never'), false);
});

await test('LFM3 speech: a caller abort stops the audio', async () => {
  const pcm = (n) => new Float32Array(n);
  const fake = fakeAnyformer([['a', pcm(10), 'b', pcm(20), 'c', pcm(30)]]);
  const m = createLfm3OmniModel({ importer: fake.importer });
  const ctl = new AbortController(); const audio = [];
  const out = await m.generate({ messages: [], tools: [], signal: ctl.signal, onAudio: (a) => { audio.push(a.length); ctl.abort(); } });
  assert.equal(out.stopReason, 'aborted');
  assert.deepEqual(audio, [10]);
});

// ── the rest of LocalMind's tools, on stand-ins ──
const { moreTools, calendarEvent, MEMORY_PATH } = await import('../more-tools.mjs');
function standIns() {
  const files = new Map(); let cal = null; const proposed = [];
  return { files, get cal() { return cal; }, proposed, deps: {
    memory: { read: async (p) => files.get(p) ?? null, write: async (p, t) => { files.set(p, t); } },
    calendar: { label: 'Calendar (test)', read: async () => cal, write: async (t) => { cal = t; } },
    fetchText: async (url) => ({ status: 200, text: '<title>T</title><main>Hello page</main>', via: 'direct' }),
    parseHtml: () => ({ title: 'T', querySelectorAll: () => [], querySelector: (sel) => (sel === 'main' ? { textContent: '  Hello   page ' } : null), body: { textContent: 'x' } }),
    python: async () => ({ runCode: async (code) => ({ status: 'ok', stdout: `ran ${code.length} chars\n`, stderr: '' }) }),
    skills: { propose: async (sk) => { proposed.push(sk); return sk.name === 'bad' ? { ok: false, message: 'refused by Sentinel' } : { ok: true, status: 'staged' }; } },
    search: () => null,
    now: () => new Date('2026-10-30T10:00:00'),
  } };
}

await test('memory tools store, find, list and forget', async () => {
  const st = standIns(); const reg = createToolRegistry(moreTools(st.deps));
  await reg.run('store_memory', { content: 'My dentist is Dr Rao in Bandra', category: 'fact' });
  await reg.run('store_memory', { content: 'I prefer tea over coffee', category: 'preference' });
  assert.equal(JSON.parse(st.files.get(MEMORY_PATH)).length, 2);
  const hit = await reg.run('search_memory', { query: 'who is my dentist' });
  assert.equal(hit.result.found[0].content, 'My dentist is Dr Rao in Bandra');
  assert.equal((await reg.run('list_memories')).result.count, 2);
  assert.equal((await reg.run('delete_memory', { query: 'tea' })).result.deleted, 1);
  assert.equal(JSON.parse(st.files.get(MEMORY_PATH)).length, 1);
  assert.equal((await reg.run('store_memory', { content: 'x', category: 'nonsense' })).ok, false);   // enum checked
});

await test('calendar events land in Calendar\'s own data shape', async () => {
  const st = standIns(); const reg = createToolRegistry(moreTools(st.deps));
  const r = await reg.run('create_calendar_event', { title: 'Dentist', start: '2026-11-02T15:00', duration_minutes: 30, location: 'Bandra' });
  assert.equal(r.ok, true);
  const data = JSON.parse(st.cal);
  assert.equal(data.version, 1);
  assert.deepEqual({ ...data.events[0], id: 'x', timeZone: 'z' }, { id: 'x', title: 'Dentist', description: '', location: 'Bandra',
    startLocal: '2026-11-02T15:00', endLocal: '2026-11-02T15:30', allDay: false, timeZone: 'z', recurrence: { frequency: 'none', interval: 1, until: null } });
  await reg.run('create_calendar_event', { title: 'Holiday', start: '2026-11-14' });
  assert.equal(JSON.parse(st.cal).events[1].allDay, true);
  assert.match((await reg.run('create_calendar_event', { title: 'Old', start: '2026-01-01T10:00' })).error, /in the past/);
  assert.match((await reg.run('create_calendar_event', { title: 'Bad', start: '2026-02-30' })).error, /not a real date/);
});

await test('web search needs a provider; page, Python and skill tools reach their stand-ins', async () => {
  const st = standIns(); let on = true;
  const reg = createToolRegistry(moreTools({ ...st.deps, webOn: () => on }));
  assert.equal((await reg.run('web_search', { query: 'news today' })).error, 'unknown tool web_search');   // hidden until a provider is set
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => ({ ok: true, json: async () => ({ results: [{ title: 'A', url: 'https://a', content: 'snip' }] }) });
  try {
    const reg2 = createToolRegistry(moreTools({ ...st.deps, search: () => ({ provider: 'searxng', url: 'https://sx.example' }) }));
    assert.deepEqual((await reg2.run('web_search', { query: 'news' })).result.results, [{ title: 'A', url: 'https://a', snippet: 'snip' }]);
  } finally { globalThis.fetch = realFetch; }
  const page = await reg.run('fetch_page', { url: 'https://example.com/x' });
  assert.equal(page.result.text, 'Hello page');
  assert.match((await reg.run('fetch_page', { url: 'file:///etc/passwd' })).error, /only http/);
  on = false;
  assert.match((await reg.run('fetch_page', { url: 'https://example.com' })).error, /switched off/);
  assert.equal((await reg.run('run_python', { code: 'print(1)' })).result.stdout, 'ran 8 chars\n');
  assert.equal((await reg.run('save_skill', { name: 'brief', description: 'd', instructions: 'Be brief.' })).result.status, 'staged');
  assert.match((await reg.run('save_skill', { name: 'bad', description: 'd', instructions: 'x' })).error, /Sentinel/);
});

await test('LFM3 replies never overlap on the engine, even after a stop', async () => {
  let active = 0, maxActive = 0, drained = 0;
  const session = {
    async *generate(messages, opts) {
      active++; maxActive = Math.max(maxActive, active);
      try {
        let text = '';
        for (const piece of ['<tool_call>\n<function=get_time>\n</function>\n</tool_call>', ' tail', ' more']) {
          await new Promise((r) => setTimeout(r, 5));
          text += piece; yield { text, tokens: 1 };
          if (opts.signal?.aborted) { drained++; return; }
        }
      } finally { active--; }
    },
  };
  const m = createLfm3OmniModel({ importer: async () => ({ MODELS: { chat: { LFM3_OMNI_2B: 'x' } }, load: async () => session }) });
  const tools = makeTools(createTimers()).list();
  const ctl = new AbortController();
  const a = m.generate({ messages: [], tools, signal: ctl.signal });
  const b = m.generate({ messages: [], tools });
  ctl.abort();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(maxActive, 1);
  assert.equal(ra.stopReason, 'aborted');
  assert.deepEqual(rb.toolCalls, [{ name: 'get_time', arguments: {} }]);
  assert.equal(drained, 1);   // the closed tool call's stream was read to its end after the stop
  assert.equal(ra.text, '');  // the reply stopped before its turn never ran on the engine
});

await test('stored memories reach every turn\'s system prompt', async () => {
  const { memoryContext } = await import('../more-tools.mjs');
  const st = standIns(); const reg = createToolRegistry(moreTools(st.deps));
  assert.equal(await memoryContext(st.deps.memory), '');
  await reg.run('store_memory', { content: 'My dentist is Dr Rao in Bandra' });
  const seen = [];
  const spy = { id: 'spy', async generate({ messages }) { seen.push(messages[0].content); return { text: 'ok', toolCalls: [], stopReason: 'stop' }; } };
  const s = createVoiceSession({ model: spy, tools: reg, context: () => memoryContext(st.deps.memory) });
  await s.sendText('who is my dentist?');
  assert.match(seen[0], /What the person asked you to remember .*call no tool:\n- My dentist is Dr Rao in Bandra$/);
  assert.match(seen[0], /^You are the NakliOS voice assistant/);
});

await test('answer_directly is never run: picked alone, the turn goes straight to the spoken answer', async () => {
  const pcm = (n) => new Float32Array(n).fill(0.1);
  const fake = fakeAnyformer([
    ['<tool_call>\n<function=answer_directly>\n</function>\n</tool_call>'],
    ['Hello there.', pcm(40)],
  ]);
  const m = createLfm3OmniModel({ importer: fake.importer });
  const ran = [];
  const reg = createToolRegistry(builtinTools({ host, timers: createTimers(), nav: fakeNav }).map((t) => ({ ...t, run: (a) => { ran.push(t.name); return t.run(a); } })));
  const s = createVoiceSession({ model: m, tools: reg, player: fakePlayer() });
  const out = await s.sendText('hello');
  assert.equal(out.text, 'Hello there.');
  assert.deepEqual(ran, []);
  assert.deepEqual(s.history.map((x) => x.role), ['user', 'assistant']);
  assert.equal(fake.seen.calls[1].opts.speech, true);
  assert.equal(fake.seen.calls[1].opts.tools, undefined);
});

await test('a repeated tool call ends the tool rounds, and web search is hidden until a provider is set', async () => {
  const st = standIns();
  const reg = createToolRegistry(moreTools({ ...st.deps, search: () => null }));
  assert.equal(reg.list().some((t) => t.name === 'web_search'), false);
  assert.equal((await reg.run('web_search', { query: 'x' })).error, 'unknown tool web_search');
  const withKey = createToolRegistry(moreTools({ ...st.deps, search: () => ({ provider: 'brave', key: 'k' }) }));
  assert.equal(withKey.list().some((t) => t.name === 'web_search'), true);
  const offered = []; let n = 0;
  const loopy = { id: 'loopy', async generate({ tools }) { offered.push(tools.length); n++;
    return tools.length && n <= 3 ? { text: '', toolCalls: [{ name: 'list_memories', arguments: {} }], stopReason: 'tool_calls' } : { text: 'I do not know.', toolCalls: [], stopReason: 'stop' }; } };
  const ran = [];
  const s = createVoiceSession({ model: loopy, tools: reg, onTool: (e) => ran.push(e.name) });
  const out = await s.sendText('fastest way from Rome to Mumbai?');
  assert.deepEqual(ran, ['list_memories']);           // run once, not again
  assert.equal(offered[2], 0);                        // after the repeat, no tools are offered
  assert.equal(out.stopReason, 'stop');
  assert.equal(s.history.at(-1).content[0].text, 'I do not know.');
  assert.deepEqual(s.history.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'assistant']);
});

console.log(`voice + lfm3 adapter: ${pass} passed`);

