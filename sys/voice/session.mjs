// session.mjs — one conversation with the voice assistant: the states, the history and the tool loop.
// No DOM and no audio devices: the overlay hands in a player and the model, so node tests run it.
//
// States: idle → listening → thinking → speaking → idle. interrupt() stops the reply and its audio.
// A model with audioOut === false gets its text spoken by `speech` (createSpeechFallback) instead.

export const STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking']);

// A restraining rule, LocalMind's: tools are decided in a text pass now (lfm3-omni.mjs), where the model calls something
// for nearly every request, so the prompt says when not to. The earlier pushing rule ("call the tool first") was for
// speech mode, which no longer decides tools.
const SYSTEM_PROMPT = 'You are the NakliOS voice assistant. Answer briefly, in plain spoken sentences. '
  + 'Call a tool only when the question needs current or live information (weather, time, battery, network, a web page), '
  + 'an action (a timer, opening an app, a calendar event, a calculation), or something stored about this person. '
  + 'When the person tells you something to remember, call store_memory. '
  + 'For greetings, jokes, opinions, stories and general knowledge, answer directly and call no tool. '
  + 'If you are not sure of a fact and no tool gave it to you, say you do not know rather than guess.';

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
      const seenCalls = new Set();
      const callKey = (c) => `${c.name}:${JSON.stringify(c.arguments || {})}`;
      let repeated = false;
      for (let round = 0; round <= maxToolRounds; round++) {
        const out = await model.generate({
          messages: [{ role: 'system', content: system }, ...history],
          tools: round < maxToolRounds && !repeated ? tools.list() : [],
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
        // A call the model already made this turn gets no new result, so the next round answers with no tools offered.
        // Seen live: web_search with the same query three times, each failing, then an invented answer.
        const fresh = toolCalls.filter((c) => !seenCalls.has(callKey(c)));
        if (fresh.length < toolCalls.length) repeated = true;
        for (const call of fresh) seenCalls.add(callKey(call));
        history.push({ role: 'assistant', content: [{ type: 'text', text: out.text || '' }], ...(fresh.length ? { toolCalls: fresh } : {}) });
        if (!toolCalls.length) break;
        if (!fresh.length) continue;
        for (const call of fresh) {
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
