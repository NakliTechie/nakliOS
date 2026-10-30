// overlay.mjs — the voice assistant panel on the NakliOS desktop.
// A light card at the bottom right: an orb that shows the state and the sound level, the reply under
// it, and a message box. Hold the orb (or Space) to talk; turn on Hands-free to talk without holding,
// with end of turn found by the voice-activity detector. Talking over a reply stops it.
//
// host: { listApps(), openApp(id) } from the host command registry. Every action here is also a
// host command (assistant.* in sys/host/agent.mjs), so the agent face and the panel share one list.
import { VOICE_MODELS, tone } from './adapter.mjs';
import { createToolRegistry, createTimers, createReminders, builtinTools } from './tools.mjs';
import { lookupTools } from './web-tools.mjs';
import { moreTools, memoryContext, SEARCH_PROVIDERS } from './more-tools.mjs';
import { createMusic, musicTools } from './music.mjs';
import { createVoiceSession } from './session.mjs';
import { openMic, createVad, createTurnRecorder, createPlayer, createSpeechFallback } from './audio.mjs';

const CSS = `
/* Colours come from the desktop theme (index.html :root tokens), so the panel follows every NakliOS theme. */
.nv-panel{--nv-raise:color-mix(in srgb, var(--ink) 5%, var(--panel)); --nv-field:color-mix(in srgb, var(--ink) 3%, var(--panel));
  position:fixed; right:20px; bottom:56px; width:min(360px, calc(100vw - 32px)); z-index:1400;
  max-height:calc(100vh - 96px); box-sizing:border-box;
  background:var(--panel); color:var(--ink); border:1px solid var(--line-strong, var(--line)); border-radius:18px;
  box-shadow:var(--shadow); font:14px/1.45 system-ui,-apple-system,sans-serif;
  display:flex; flex-direction:column; gap:10px; padding:14px 14px 12px;}
.nv-head{display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted);}
.nv-head b{color:var(--ink); font-size:13px;}
.nv-head .nv-sp{flex:1}
.nv-x{border:0; background:none; font-size:18px; line-height:1; color:var(--muted); cursor:pointer; padding:2px 6px; border-radius:8px;}
.nv-x:hover{background:var(--nv-raise); color:var(--ink)}
.nv-orbwrap{display:flex; flex-direction:column; align-items:center; gap:6px; padding:6px 0 2px;}
.nv-orb{--lvl:0; --nv-c:var(--act); width:96px; height:96px; border-radius:50%; border:0; cursor:pointer; touch-action:none;
  background:radial-gradient(circle at 35% 30%, #fff 0, color-mix(in srgb, var(--nv-c) 35%, #fff) 30%, var(--nv-c) 75%);
  transform:scale(calc(1 + var(--lvl) * .35)); transition:transform .06s linear, filter .2s;
  box-shadow:0 0 0 calc(var(--lvl) * 18px) color-mix(in srgb, var(--nv-c) 20%, transparent);}
.nv-orb:focus-visible{outline:3px solid var(--brand); outline-offset:4px}
.nv-panel[data-state=listening] .nv-orb{--nv-c:var(--brand)}
.nv-panel[data-state=thinking] .nv-orb{animation:nv-pulse 1.1s ease-in-out infinite}
.nv-panel[data-state=speaking] .nv-orb{--nv-c:var(--ok)}
@keyframes nv-pulse{50%{filter:brightness(1.15); transform:scale(1.06)}}
@media (prefers-reduced-motion: reduce){.nv-orb{transition:none; animation:none !important}}
.nv-state{font-size:12px; color:var(--muted); min-height:18px}
.nv-log{flex:0 1 auto; min-height:0; max-height:min(260px, 30vh); overflow:auto; display:flex; flex-direction:column; gap:6px}
.nv-load{display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--line); border-radius:12px; background:var(--nv-raise); font-size:13px}
.nv-load[hidden]{display:none}
.nv-load div{display:flex; gap:6px}
.nv-load .nv-btn.primary{background:var(--brand); border-color:var(--brand); color:var(--panel)}
.nv-load .nv-btn.primary:hover{filter:brightness(1.06)}
.nv-ask{display:flex; flex-direction:column; gap:8px; padding:10px; border:1px solid color-mix(in srgb, var(--brand) 40%, var(--line)); border-radius:12px; background:color-mix(in srgb, var(--brand) 10%, var(--panel)); font-size:13px}
.nv-ask div{display:flex; gap:6px}
.nv-set{display:flex; flex-direction:column; gap:6px; padding:10px; border:1px solid var(--line); border-radius:12px; background:var(--nv-raise); font-size:12px}
.nv-set[hidden]{display:none}
.nv-set label{display:flex; align-items:center; gap:6px}
.nv-set select,.nv-set input[type=text],.nv-set input[type=password]{flex:1; min-width:0; font:inherit; padding:4px 6px; border:1px solid var(--line); border-radius:8px; background:var(--nv-field); color:var(--ink)}
.nv-msg{padding:7px 10px; border-radius:12px; white-space:pre-wrap; word-break:break-word}
.nv-msg.user{align-self:flex-end; background:color-mix(in srgb, var(--brand) 16%, var(--panel)); max-width:85%}
.nv-msg.bot{align-self:flex-start; background:var(--nv-raise); border:1px solid var(--line); max-width:92%}
.nv-msg.tool{align-self:flex-start; font:12px ui-monospace,Menlo,monospace; color:var(--ok); background:color-mix(in srgb, var(--ok) 12%, var(--panel))}
.nv-msg.err{align-self:stretch; color:var(--ink); background:color-mix(in srgb, #d33 16%, var(--panel))}
.nv-form{display:flex; gap:6px}
.nv-form input{flex:1; min-width:0; padding:8px 10px; border:1px solid var(--line); border-radius:10px; background:var(--nv-field); color:var(--ink); font:inherit}
.nv-form input::placeholder{color:var(--faint)}
.nv-form input:focus{outline:2px solid var(--brand); outline-offset:0; border-color:transparent}
.nv-btn{padding:7px 11px; border:1px solid var(--line); border-radius:10px; background:var(--nv-field); color:var(--ink); cursor:pointer; font:inherit}
.nv-btn:hover{background:var(--nv-raise)}
.nv-btn[hidden]{display:none}
.nv-foot{display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted)}
.nv-foot label{display:flex; align-items:center; gap:5px; cursor:pointer}
.nv-foot .nv-sp{flex:1}
`;

const STATE_TEXT = {
  idle: 'Hold the orb or Space to talk',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking — press the orb or Stop to interrupt',
};

const DEFAULT_MODEL = 'lfm3-omni-2b';
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
// Answers the person gave once and the assistant keeps in this browser (a proxy allowed, a search provider set).
const CONSENT_KEY = (id) => `nakli.voice.consent.${id}`;
const SEARCH_KEY = 'nakli.voice.search';
export const REMINDER_KEY = 'nakli.voice.reminders';
const readJson = (key) => { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } };

export function mountVoiceAssistant({ root = document.body, host, more = null, model: injected = null } = {}) {
  const modelId = injected ? injected.id : DEFAULT_MODEL;
  const model = injected || VOICE_MODELS[modelId].create();
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
  // Reminders chime, open the panel and, when the person has allowed notifications for this site, show one.
  const reminders = createReminders({
    onDue: (r) => {
      announce(`${r.late ? 'Missed reminder' : 'Reminder'}${r.message ? `: ${r.message}` : ''}.`);
      try { if (globalThis.Notification?.permission === 'granted') new Notification('NakliOS reminder', { body: r.message || 'It is time.' }); } catch (_) {}
    },
    store: { load: () => readJson(REMINDER_KEY) || [], save: (list) => localStorage.setItem(REMINDER_KEY, JSON.stringify(list)) },
  });
  const music = createMusic({ files: () => more?.musicFiles?.() || null });
  const tools = createToolRegistry([...builtinTools({ host, timers, reminders }), ...musicTools({ music, host }), ...lookupTools({ webOn }),
    ...(more ? moreTools({ ...more, webOn, search: () => readJson(SEARCH_KEY) }) : [])]);
  const session = createVoiceSession({
    model, tools, player, speech,
    context: () => (more?.memory ? memoryContext(more.memory) : ''),
    onState: (s) => { if (s === 'idle') music.duck(false); if (panel) { panel.dataset.state = s; els.state.textContent = STATE_TEXT[s]; els.stop.hidden = !(s === 'thinking' || s === 'speaking'); } },
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
    // The assistant's own voice and its music bypass echo cancellation, so the mic ignores sound while either plays;
    // pressing the orb still talks over them (music drops to a fifth of its volume while the person speaks).
    if (player.playing || speech.busy || music.playing) quietUntil = now + ECHO_TAIL_MS;
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
    music.duck(true);
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
      <div class="nv-head"><b>Assistant</b><span class="nv-model"></span><span class="nv-sp"></span>
        <button class="nv-x nv-gear" type="button" aria-label="Assistant settings">⚙</button>
        <button class="nv-x" type="button" aria-label="Close assistant">×</button></div>
      <div class="nv-set" hidden>
        <label>Web search <select class="nv-sp-provider"><option value="">Off</option>${SEARCH_PROVIDERS.map((p) => `<option value="${p}">${p === 'searxng' ? 'SearXNG' : p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select></label>
        <label class="nv-sp-keyrow">Key <input type="password" class="nv-sp-key" autocomplete="off" placeholder="API key (kept in this browser)"></label>
        <label class="nv-sp-urlrow">URL <input type="text" class="nv-sp-url" autocomplete="off" placeholder="https://your-searxng.example"></label>
        <label><input type="checkbox" class="nv-proxy"> Read blocked pages through Jina Reader (r.jina.ai sees the address)</label>
      </div>
      <div class="nv-orbwrap"><button class="nv-orb" type="button" aria-label="Hold to talk"></button>
        <div class="nv-state" aria-live="polite"></div></div>
      <div class="nv-load" hidden><span class="nv-load-text"></span>
        <div><button class="nv-btn primary nv-load-btn" type="button">Download and turn on</button><button class="nv-btn nv-load-later" type="button">Not now</button></div></div>
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
    panel.querySelector('.nv-load-later').onclick = () => { els.load.hidden = true; };
    panel.querySelector('.nv-model').textContent = `· ${model.label || model.id}`;
    els.state.textContent = loadNote || STATE_TEXT[session.state];
    els.hf.checked = handsFree;
    panel.querySelector('.nv-x:not(.nv-gear)').onclick = close;
    wireSettings();
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
    if (need) els.loadText.textContent = `Turn on the voice assistant? ${model.label} runs on this device. It downloads ${model.downloadLabel || 'the model'} once, and then stays in this browser.`;
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
  // ⚙ settings: the search provider and its key, and the page proxy. Typed by the person, kept in this browser.
  function wireSettings() {
    const box = panel.querySelector('.nv-set'), prov = box.querySelector('.nv-sp-provider'), key = box.querySelector('.nv-sp-key'),
      url = box.querySelector('.nv-sp-url'), proxy = box.querySelector('.nv-proxy');
    const cfg = readJson(SEARCH_KEY) || {};
    prov.value = cfg.provider || ''; key.value = cfg.key || ''; url.value = cfg.url || '';
    proxy.checked = localStorage.getItem(CONSENT_KEY('page-proxy')) === 'yes';
    const rows = () => { box.querySelector('.nv-sp-keyrow').hidden = !['brave', 'tavily'].includes(prov.value); box.querySelector('.nv-sp-urlrow').hidden = prov.value !== 'searxng'; };
    const saveSearch = () => { rows(); try { prov.value ? localStorage.setItem(SEARCH_KEY, JSON.stringify({ provider: prov.value, key: key.value.trim(), url: url.value.trim() })) : localStorage.removeItem(SEARCH_KEY); } catch {} };
    prov.onchange = saveSearch; key.onchange = saveSearch; url.onchange = saveSearch;
    proxy.onchange = () => setConsent('page-proxy', proxy.checked);
    rows();
    panel.querySelector('.nv-gear').onclick = () => { box.hidden = !box.hidden; };
  }
  function setConsent(id, on) {
    try { on ? localStorage.setItem(CONSENT_KEY(id), 'yes') : localStorage.removeItem(CONSENT_KEY(id)); } catch {}
    const box = panel?.querySelector(id === 'page-proxy' ? '.nv-proxy' : null);
    if (box) box.checked = !!on;
  }
  // Asks once; "Allow" is kept in this browser, so the next load does not ask again. Unanswered in 60 s counts as no.
  function consent(id, question) {
    if (localStorage.getItem(CONSENT_KEY(id)) === 'yes') return Promise.resolve(true);
    open();
    return new Promise((resolve) => {
      const card = document.createElement('div');
      card.className = 'nv-ask';
      card.innerHTML = '<span></span><div><button class="nv-btn" type="button">Allow</button><button class="nv-btn" type="button">Not now</button></div>';
      card.querySelector('span').textContent = question;
      const [yes, no] = card.querySelectorAll('button');
      const done = (v) => { clearTimeout(t); card.remove(); if (v) setConsent(id, true); resolve(v); };
      const t = setTimeout(() => done(false), 60000);
      yes.onclick = () => done(true); no.onclick = () => done(false);
      els.log.appendChild(card); scroll();
    });
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
    ask, listen, stopListening, stop, setHandsFree, setWebLookups, setConsent, consent, loadModel, get modelId() { return modelId; },
    get state() { return session.state; }, session, tools, timers, reminders, music,
  };
}
