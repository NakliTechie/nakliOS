// session.mjs — one conversation with the voice assistant: the states, the history and the tool loop.
// No DOM and no audio devices: the overlay hands in a player and the model, so node tests run it.
//
// States: idle → listening → thinking → speaking → idle. interrupt() stops the reply and its audio.
// A model with audioOut === false gets its text spoken by `speech` (createSpeechFallback) instead.

export const STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking']);

// Firm on tools, because in speech mode LFM3-Omni announced a weather lookup and then answered without calling the
// tool under a gentler prompt (headless check, 2026-10-30); with this one it spoke a short preface and called it.
const SYSTEM_PROMPT = 'You are the NakliOS voice assistant. Answer briefly, in plain spoken sentences. You have tools, listed above. '
  + 'When a question needs live information (weather, time, battery, network, a web page) or an action (timer, '
  + 'opening an app, a calculation, a calendar event), call the tool first and answer only after its result arrives. '
  + 'Answer greetings, chat and general knowledge yourself; look a topic up only when the person asks you to. '
  + 'When the person tells you something to remember, call store_memory; when they ask about something they told you before, '
  + 'call search_memory, because this conversation is forgotten later. Never say you lack a tool that is listed.';

export function createVoiceSession({
  model, tools, player = null, speech = null, systemPrompt = SYSTEM_PROMPT, context = async () => '',
  maxToolRounds = 3, keepTurns = 6,
  onState = () => {}, onText = () => {}, onTool = () => {}, onError = () => {},
} = {}) {
  let state = 'idle';
  let history = [];
  let current = null; // { controller, done }

  const setState = (next) => { if (next !== state) { state = next; onState(next); } };

  // Older turns drop their audio, because the model only needs the current turn's sound.
  function trim() {
    const userIdx = history.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0);
    if (userIdx.length > keepTurns) history = history.slice(userIdx[userIdx.length - keepTurns]);
    const lastUser = userIdx.length ? history.findLastIndex((m) => m.role === 'user') : -1;
    history = history.map((m, i) => (m.role === 'user' && i !== lastUser && Array.isArray(m.content)
      ? { ...m, content: m.content.map((p) => (p.type === 'audio' ? { type: 'text', text: '[spoken message]' } : p)) }
      : m));
  }

  async function runTurn(content) {
    interrupt();
    const controller = new AbortController();
    const { signal } = controller;
    let resolveDone;
    current = { controller, done: new Promise((r) => { resolveDone = r; }) };
    history.push({ role: 'user', content });
    trim();
    setState('thinking');
    let reply = '';
    // Standing context for this turn (what the person asked the assistant to remember), read fresh each turn.
    let extra = '';
    try { extra = String((await context()) || '').trim(); } catch (_) {}
    const system = extra ? `${systemPrompt}\n\n${extra}` : systemPrompt;
    const voiceText = model.audioOut === false && speech ? speech : null;
    try {
      for (let round = 0; round <= maxToolRounds; round++) {
        const out = await model.generate({
          messages: [{ role: 'system', content: system }, ...history],
          tools: round < maxToolRounds ? tools.list() : [],
          onText: (delta) => {
            if (signal.aborted) return;
            reply += delta; onText(delta);
            if (voiceText?.push(delta)) setState('speaking');
          },
          onAudio: (chunk) => { if (signal.aborted) return; setState('speaking'); player?.enqueue(chunk); },
          signal,
        });
        if (signal.aborted || out.stopReason === 'aborted') return { stopReason: 'aborted', text: reply };
        const toolCalls = out.toolCalls || [];
        history.push({ role: 'assistant', content: [{ type: 'text', text: out.text || '' }], ...(toolCalls.length ? { toolCalls } : {}) });
        if (!toolCalls.length) break;
        for (const call of toolCalls) {
          const result = await tools.run(call.name, call.arguments);
          onTool({ name: call.name, arguments: call.arguments, result });
          history.push({ role: 'tool', name: call.name, content: JSON.stringify(result) });
        }
      }
      if (voiceText && !signal.aborted && voiceText.flush()) setState('speaking');
      if (player && !signal.aborted) await player.drained();
      if (voiceText && !signal.aborted) await voiceText.drained();
      return { stopReason: signal.aborted ? 'aborted' : 'stop', text: reply };
    } catch (error) {
      if (!signal.aborted) onError(error);
      return { stopReason: 'error', text: reply, error };
    } finally {
      if (current?.controller === controller) { current = null; if (state !== 'listening') setState('idle'); }
      resolveDone();
    }
  }

  function interrupt() {
    if (current) { current.controller.abort(); current = null; }
    player?.stop();
    speech?.stop();
    if (state === 'thinking' || state === 'speaking') setState('idle');
  }

  return {
    get state() { return state; },
    get history() { return history; },
    sendText: (text) => runTurn([{ type: 'text', text: String(text) }]),
    sendAudio: (audio) => runTurn([{ type: 'audio', audio }]),
    // Listening is a state the overlay sets while the mic is open; a new turn ends it.
    startListening() { interrupt(); setState('listening'); },
    stopListening() { if (state === 'listening') setState('idle'); },
    interrupt,
    reset() { interrupt(); history = []; },
    get model() { return model; },
    // A new model starts a fresh conversation, because one model's turns are not another's.
    setModel(next) { interrupt(); model = next; history = []; },
  };
}
