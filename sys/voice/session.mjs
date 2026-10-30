// session.mjs — one conversation with the voice assistant: the states, the history and the tool loop.
// No DOM and no audio devices: the overlay hands in a player and the model, so node tests run it.
//
// States: idle → listening → thinking → speaking → idle. interrupt() stops the reply and its audio.

export const STATES = Object.freeze(['idle', 'listening', 'thinking', 'speaking']);

const SYSTEM_PROMPT = 'You are the NakliOS voice assistant. Answer briefly, in plain spoken sentences. Use a tool when the person asks for something a tool does.';

export function createVoiceSession({
  model, tools, player = null, systemPrompt = SYSTEM_PROMPT,
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
    try {
      for (let round = 0; round <= maxToolRounds; round++) {
        const out = await model.generate({
          messages: [{ role: 'system', content: systemPrompt }, ...history],
          tools: round < maxToolRounds ? tools.list() : [],
          onText: (delta) => { if (signal.aborted) return; reply += delta; onText(delta); },
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
      if (player && !signal.aborted) { setState('speaking'); await player.drained(); }
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
  };
}
