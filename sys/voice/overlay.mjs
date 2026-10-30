// overlay.mjs — the voice assistant panel on the NakliOS desktop.
// A light card at the bottom right: an orb that shows the state and the sound level, the reply under
// it, and a message box. Hold the orb (or Space) to talk; turn on Hands-free to talk without holding,
// with end of turn found by the voice-activity detector. Talking over a reply stops it.
//
// host: { listApps(), openApp(id) } from the host command registry. Every action here is also a
// host command (assistant.* in sys/host/agent.mjs), so the agent face and the panel share one list.
import { VOICE_MODELS, tone } from './adapter.mjs';
import { createToolRegistry, createTimers, builtinTools } from './tools.mjs';
import { lookupTools } from './web-tools.mjs';
import { createVoiceSession } from './session.mjs';
import { openMic, createVad, createTurnRecorder, createPlayer, createSpeechFallback } from './audio.mjs';

const CSS = `
.nv-panel{position:fixed; right:20px; bottom:56px; width:min(360px, calc(100vw - 32px)); z-index:1400;
  max-height:calc(100vh - 96px); box-sizing:border-box;
  background:#fbfaf7; color:#1f1d1a; border:1px solid #e4e0d8; border-radius:18px;
  box-shadow:0 18px 50px rgba(30,25,20,.18); font:14px/1.45 system-ui,-apple-system,sans-serif;
  display:flex; flex-direction:column; gap:10px; padding:14px 14px 12px;}
.nv-head{display:flex; align-items:center; gap:8px; font-size:12px; color:#6b665e;}
.nv-head b{color:#1f1d1a; font-size:13px;}
.nv-head .nv-sp{flex:1}
.nv-head select{font:inherit; font-size:12px; color:#1f1d1a; background:#fff; border:1px solid #dcd7cd; border-radius:8px; padding:2px 4px; max-width:190px}
.nv-x{border:0; background:none; font-size:18px; line-height:1; color:#6b665e; cursor:pointer; padding:2px 6px; border-radius:8px;}
.nv-x:hover{background:#efece6}
.nv-orbwrap{display:flex; flex-direction:column; align-items:center; gap:6px; padding:6px 0 2px;}
.nv-orb{--lvl:0; width:96px; height:96px; border-radius:50%; border:0; cursor:pointer; touch-action:none;
  background:radial-gradient(circle at 35% 30%, #fff 0, #c9d8ff 30%, #5b7fe0 75%);
  transform:scale(calc(1 + var(--lvl) * .35)); transition:transform .06s linear, filter .2s;
  box-shadow:0 0 0 calc(var(--lvl) * 18px) rgba(91,127,224,.18);}
.nv-orb:focus-visible{outline:3px solid #5b7fe0; outline-offset:4px}
.nv-panel[data-state=listening] .nv-orb{background:radial-gradient(circle at 35% 30%, #fff 0, #ffd3c4 30%, #e0603a 75%); box-shadow:0 0 0 calc(var(--lvl) * 18px) rgba(224,96,58,.2);}
.nv-panel[data-state=thinking] .nv-orb{animation:nv-pulse 1.1s ease-in-out infinite}
.nv-panel[data-state=speaking] .nv-orb{background:radial-gradient(circle at 35% 30%, #fff 0, #c8efd9 30%, #2f9e6a 75%); box-shadow:0 0 0 calc(var(--lvl) * 18px) rgba(47,158,106,.2);}
@keyframes nv-pulse{50%{filter:brightness(1.15); transform:scale(1.06)}}
@media (prefers-reduced-motion: reduce){.nv-orb{transition:none; animation:none !important}}
.nv-state{font-size:12px; color:#6b665e; min-height:18px}
.nv-log{flex:0 1 auto; min-height:0; max-height:min(260px, 30vh); overflow:auto; display:flex; flex-direction:column; gap:6px}
.nv-load{display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid #e4e0d8; border-radius:12px; background:#fff; font-size:13px}
.nv-load[hidden]{display:none}
.nv-load .nv-btn{align-self:flex-start; background:#5b7fe0; border-color:#5b7fe0; color:#fff}
.nv-load .nv-btn:hover{background:#4a6dcc}
.nv-msg{padding:7px 10px; border-radius:12px; white-space:pre-wrap; word-break:break-word}
.nv-msg.user{align-self:flex-end; background:#e9eefc; max-width:85%}
.nv-msg.bot{align-self:flex-start; background:#fff; border:1px solid #ebe7df; max-width:92%}
.nv-msg.tool{align-self:flex-start; font:12px ui-monospace,Menlo,monospace; color:#4d6b3c; background:#eef6e9}
.nv-msg.err{align-self:stretch; color:#9b2c2c; background:#fdecec}
.nv-form{display:flex; gap:6px}
.nv-form input{flex:1; min-width:0; padding:8px 10px; border:1px solid #dcd7cd; border-radius:10px; background:#fff; color:#1f1d1a; font:inherit}
.nv-form input:focus{outline:2px solid #5b7fe0; outline-offset:0; border-color:transparent}
.nv-btn{padding:7px 11px; border:1px solid #dcd7cd; border-radius:10px; background:#fff; color:#1f1d1a; cursor:pointer; font:inherit}
.nv-btn:hover{background:#f3f0ea}
.nv-btn[hidden]{display:none}
.nv-foot{display:flex; align-items:center; gap:8px; font-size:12px; color:#6b665e}
.nv-foot label{display:flex; align-items:center; gap:5px; cursor:pointer}
.nv-foot .nv-sp{flex:1}
`;

const STATE_TEXT = {
  idle: 'Hold the orb or Space to talk',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking — press the orb or Stop to interrupt',
};

const MODEL_KEY = 'nakli.voice.model';
const DEFAULT_MODEL = 'lfm3-omni-2b';
const savedModelId = () => { try { const id = localStorage.getItem(MODEL_KEY); return VOICE_MODELS[id] ? id : DEFAULT_MODEL; } catch { return DEFAULT_MODEL; } };
// The mic ignores sound while the assistant speaks and this long after: system voices bypass the browser's
// echo cancellation, so without it the assistant hears itself, interrupts itself and answers its own words.
const ECHO_TAIL_MS = 600;
// A hands-free turn needs this much voiced sound, so a fan or a door does not become a question.
const MIN_VOICED_MS = 500;
// Sound kept from before a hold-to-talk press and recorded after its release, so the first and last words survive.
const PREROLL_FRAMES = 38;   // about 300 ms of 8 ms frames
const RELEASE_TAIL_MS = 250;
const WEB_KEY = 'nakli.voice.web';
const webOn = () => { try { return localStorage.getItem(WEB_KEY) !== 'off'; } catch { return true; } };

export function mountVoiceAssistant({ root = document.body, host, model: injected = null } = {}) {
  let modelId = injected ? injected.id : savedModelId();
  let model = injected || VOICE_MODELS[modelId].create();
  let loadNote = '';
  if (!document.getElementById('nv-style')) {
    const style = document.createElement('style');
    style.id = 'nv-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let panel = null, els = {}, botBubble = null;
  let mic = null, micOpening = null, recorder = null, vad = null, preroll = [];
  let handsFree = false, pushing = false, quietUntil = 0;
  let level = 0, shown = 0, raf = 0;

  const player = createPlayer({ onLevel: (l) => { level = l; } });
  const speech = createSpeechFallback();
  const timers = createTimers({ onDone: ({ seconds, label }) => announce(`Timer done${label ? `: ${label}` : ''} (${seconds} s).`) });
  const tools = createToolRegistry([...builtinTools({ host, timers }), ...lookupTools({ webOn })]);
  const session = createVoiceSession({
    model, tools, player, speech,
    onState: (s) => { if (panel) { panel.dataset.state = s; els.state.textContent = STATE_TEXT[s]; els.stop.hidden = !(s === 'thinking' || s === 'speaking'); } },
    onText: (delta) => { botBubble ||= addMsg('bot', ''); botBubble.textContent += delta; scroll(); },
    onTool: ({ name, arguments: args, result }) => { addMsg('tool', `${name}(${JSON.stringify(args)}) → ${result.ok ? 'ok' : result.error}`); botBubble = null; },
    onError: (e) => addMsg('err', String(e?.message || e)),
  });

  function addMsg(kind, text) {
    if (!panel) return null;
    const div = document.createElement('div');
    div.className = `nv-msg ${kind}`;
    div.textContent = text;
    els.log.appendChild(div);
    scroll();
    return div;
  }
  const scroll = () => { if (els.log) els.log.scrollTop = els.log.scrollHeight; };

  function announce(text) {
    open();
    addMsg('bot', text);
    for (let i = 0; i < 3; i++) { player.enqueue(tone({ seconds: 0.18, hz: 880, gain: 0.2 })); player.enqueue(new Float32Array(2400)); }
  }

  function animate() {
    raf = requestAnimationFrame(animate);
    shown += (level - shown) * 0.35;
    level *= 0.9;
    els.orb?.style.setProperty('--lvl', shown.toFixed(3));
  }

  // ── mic ──
  async function ensureMic() {
    if (mic) return mic;
    micOpening ||= openMic({
      onLevel: (l) => { if (session.state === 'listening' || handsFree) level = Math.max(level, Math.min(1, l * 8)); },
      onFrame,
    }).then((m) => { mic = m; return m; }).finally(() => { micOpening = null; });
    return micOpening;
  }
  function onFrame(frame) {
    if (pushing || (recorder && !handsFree)) { if (recorder.push(frame)) endTurn(); return; }
    if (!recorder) { preroll.push(frame); if (preroll.length > PREROLL_FRAMES) preroll.shift(); }
    if (!handsFree) return;
    const now = performance.now();
    if (player.playing || speech.busy) quietUntil = now + ECHO_TAIL_MS;
    if (now < quietUntil) { if (recorder) { recorder = null; session.stopListening(); } vad.reset(); preroll = []; return; }
    const ev = vad.push(frame);
    if (ev === 'start') { session.startListening(); recorder = createTurnRecorder(); preroll.splice(0).forEach((f) => recorder.push(f)); return; }
    if (session.state === 'listening' && recorder && recorder.push(frame)) { vad.reset(); endTurn(); }
    else if (ev === 'end' && recorder) endTurn();
  }
  async function closeMic() { const m = mic; mic = null; await m?.close(); }

  // The mic stays open while the panel is, after its first use, so a press starts recording at once and keeps the
  // moment before it. The first press waits for the mic, and "Listening…" shows only once it records.
  async function listen() {
    open();
    player.unlock();
    pushing = true;
    try { await ensureMic(); }
    catch (e) { pushing = false; addMsg('err', `Microphone: ${e.message || e}`); return; }
    if (!pushing) return;   // released before the mic opened
    session.startListening();
    recorder = createTurnRecorder();
    recorder.byPress = true;   // a pressed turn is meant, so the noise filter does not apply
    preroll.splice(0).forEach((f) => recorder.push(f));
  }
  function endTurn() {
    pushing = false;
    const rec = recorder; recorder = null;
    const voiced = vad?.voicedMs ?? Infinity;
    if (vad) vad.voicedMs = 0;
    if (!rec || rec.seconds < 0.25 || (!rec.byPress && voiced < MIN_VOICED_MS)) { session.stopListening(); return; }
    if (!readyForTurn()) { session.stopListening(); return; }
    const secs = rec.seconds;
    const audio = rec.take();
    addMsg('user', `🎤 ${secs.toFixed(1)} s`);
    botBubble = null;
    session.sendAudio(audio);
  }
  // Release: keep recording a moment longer, then send.
  const stopListening = () => {
    if (!pushing) { if (recorder) endTurn(); return; }
    pushing = false;
    if (recorder) setTimeout(() => { if (recorder && !pushing) endTurn(); }, RELEASE_TAIL_MS);
    else session.stopListening();
  };

  async function setHandsFree(on) {
    handsFree = on;
    if (els.hf) els.hf.checked = on;
    if (on) {
      vad = createVad();
      player.unlock();
      try { await ensureMic(); } catch (e) { handsFree = false; if (els.hf) els.hf.checked = false; addMsg('err', `Microphone: ${e.message || e}`); }
    } else { recorder = null; session.stopListening(); }
  }

  function ask(text) {
    open();
    const t = String(text || '').trim();
    if (!t) return null;
    if (!readyForTurn()) return null;
    addMsg('user', t);
    botBubble = null;
    return session.sendText(t);
  }
  function stop() { pushing = false; recorder = null; session.interrupt(); }

  // A turn waits for a loaded model; it never starts a 2 GB download by itself.
  function readyForTurn() {
    if (model.ready || !model.load) return true;
    addMsg('err', loading ? `${model.label} is still loading.` : `Load ${model.label} first (the button above).`);
    return false;
  }

  // ── panel ──
  function open() {
    if (panel) return;
    panel = document.createElement('section');
    panel.className = 'nv-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Voice assistant');
    panel.dataset.state = session.state;
    panel.innerHTML = `
      <div class="nv-head"><b>Assistant</b><select class="nv-model" aria-label="Model"></select><span class="nv-sp"></span>
        <button class="nv-x" type="button" aria-label="Close assistant">×</button></div>
      <div class="nv-orbwrap"><button class="nv-orb" type="button" aria-label="Hold to talk"></button>
        <div class="nv-state" aria-live="polite"></div></div>
      <div class="nv-load" hidden><span class="nv-load-text"></span><button class="nv-btn nv-load-btn" type="button">Download and load</button></div>
      <div class="nv-log" aria-live="polite"></div>
      <form class="nv-form"><input type="text" placeholder="Type a message…" aria-label="Message" autocomplete="off">
        <button class="nv-btn" type="submit">Send</button><button class="nv-btn nv-stop" type="button" hidden>Stop</button></form>
      <div class="nv-foot"><label><input type="checkbox" class="nv-hf"> Hands-free</label>
        <label title="Weather and Wikipedia send only the place or topic to open-meteo.com or wikipedia.org"><input type="checkbox" class="nv-web"> Web lookups</label>
        <span class="nv-sp"></span><span>⌘. to toggle</span></div>`;
    root.appendChild(panel);
    els = {
      orb: panel.querySelector('.nv-orb'), state: panel.querySelector('.nv-state'), log: panel.querySelector('.nv-log'),
      input: panel.querySelector('.nv-form input'), stop: panel.querySelector('.nv-stop'), hf: panel.querySelector('.nv-hf'),
      load: panel.querySelector('.nv-load'), loadText: panel.querySelector('.nv-load-text'),
    };
    panel.querySelector('.nv-load-btn').onclick = () => loadModel();
    const pick = panel.querySelector('.nv-model');
    for (const [id, m] of Object.entries(VOICE_MODELS)) pick.add(new Option(`${m.label} · ${m.note}`, id));
    if (!VOICE_MODELS[modelId]) pick.add(new Option(model.label || model.id, modelId));
    pick.value = modelId;
    pick.onchange = () => chooseModel(pick.value);
    els.state.textContent = loadNote || STATE_TEXT[session.state];
    els.hf.checked = handsFree;
    panel.querySelector('.nv-x').onclick = close;
    els.stop.onclick = stop;
    els.hf.onchange = () => setHandsFree(els.hf.checked);
    const web = panel.querySelector('.nv-web');
    web.checked = webOn();
    web.onchange = () => setWebLookups(web.checked);
    panel.querySelector('.nv-form').onsubmit = (e) => { e.preventDefault(); const v = els.input.value; els.input.value = ''; ask(v); };
    els.orb.addEventListener('pointerdown', (e) => {
      e.preventDefault(); els.orb.setPointerCapture?.(e.pointerId);
      // Pressing the orb while the assistant speaks stops the reply; the next press talks.
      if (session.state === 'speaking' || session.state === 'thinking') { stop(); return; }
      listen();
    });
    const up = () => { if (pushing) stopListening(); };
    els.orb.addEventListener('pointerup', up);
    els.orb.addEventListener('pointercancel', up);
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.code === 'Space' && e.target !== els.input && !e.repeat) { e.preventDefault(); listen(); }
    });
    panel.addEventListener('keyup', (e) => { if (e.code === 'Space' && e.target !== els.input && pushing) { e.preventDefault(); stopListening(); } });
    raf = requestAnimationFrame(animate);
    els.orb.focus();
    ensureLoaded();
  }
  // A cached model loads when the panel opens. An uncached one waits for the person's click, because the
  // first load downloads 2.1 GB; after that it stays in the browser's cache.
  let loading = null;
  async function ensureLoaded() {
    if (model.ready || !model.load || loading) return showLoadCard();
    if (model.isCached && !(await model.isCached())) return showLoadCard();
    return loadModel();
  }
  function showLoadCard() {
    if (!panel) return;
    const need = !model.ready && !!model.load && !loading;
    els.load.hidden = !need;
    if (need) els.loadText.textContent = `${model.label} runs on this device. The first load downloads ${model.downloadLabel || 'the model'} once; after that it stays cached in this browser.`;
  }
  function loadModel() {
    if (model.ready || !model.load) return Promise.resolve();
    if (loading) return loading;
    const m = model;
    const show = (text) => { loadNote = text; if (panel && m === model) els.state.textContent = text; };
    show(`Loading ${m.label}…`);
    loading = m.load({ onProgress: (p) => {
      if (p?.total) show(`Loading ${m.label}… ${Math.round((p.loaded / p.total) * 100)}%`);
      else if (p?.file) show(`Loading ${m.label}… ${String(p.file).split('/').pop()}`);
    } }).then(() => {
      if (m === model) { loadNote = ''; if (panel) els.state.textContent = STATE_TEXT[session.state]; }
    }, (e) => {
      if (m !== model) return;
      loadNote = '';
      if (panel) els.state.textContent = STATE_TEXT[session.state];
      addMsg('err', `${m.label} could not load: ${e?.message || e}.`);
    }).finally(() => { if (m === model) { loading = null; showLoadCard(); } });
    showLoadCard();
    return loading;
  }
  function chooseModel(id) {
    if (!VOICE_MODELS[id] || id === modelId) return;
    model.dispose?.();
    modelId = id;
    model = VOICE_MODELS[id].create();
    loading = null; loadNote = '';
    try { localStorage.setItem(MODEL_KEY, id); } catch {}
    session.setModel(model);
    if (panel) { panel.querySelector('.nv-model').value = id; els.log.textContent = ''; }
    botBubble = null;
    ensureLoaded();
  }

  function setWebLookups(on) {
    try { localStorage.setItem(WEB_KEY, on ? 'on' : 'off'); } catch {}
    const box = panel?.querySelector('.nv-web');
    if (box) box.checked = !!on;
  }

  function close() {
    if (!panel) return;
    stop();
    setHandsFree(false);
    closeMic();
    cancelAnimationFrame(raf);
    panel.remove();
    panel = null; els = {}; botBubble = null;
  }

  return {
    open, close, toggle: () => (panel ? close() : open()), get isOpen() { return !!panel; },
    ask, listen, stopListening, stop, setHandsFree, setWebLookups, chooseModel, loadModel, get modelId() { return modelId; },
    get state() { return session.state; }, session, tools, timers,
  };
}
