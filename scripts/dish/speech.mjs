// Dish's speech-to-text provider for dsh's voice input. dsh's own provider runs SenseVoice as a native process, which
// the Worker cannot start; this one sends the recording to NakliOS (naklios.ai.experimental_transcribe), which
// transcribes on the voice assistant's on-device model once the person has switched the assistant on.
export const name = 'naklios-speech';
export const inject = ['speechToText'];
const SAMPLE_RATE = 16000;
const CHUNK = SAMPLE_RATE * 30; // the host takes at most 30 s per call

// dsh's voice input records 16 kHz mono 16-bit PCM WAV (client-ui-voice-input encodeWave).
export function wavSamples(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = at => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Dish expects a WAV recording');
  let at = 12, format, data;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at), size = view.getUint32(at + 4, true);
    if (id === 'fmt ') format = { channels: view.getUint16(at + 10, true), rate: view.getUint32(at + 12, true), bits: view.getUint16(at + 22, true) };
    if (id === 'data') { data = { start: at + 8, size: Math.min(size, bytes.byteLength - at - 8) }; break; }
    at += 8 + size + (size % 2);
  }
  if (!format || !data) throw new Error('The WAV recording has no audio');
  if (format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) throw new Error('Dish expects 16 kHz mono 16-bit audio');
  const samples = new Float32Array(data.size >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(data.start + i * 2, true) / 32768;
  return samples;
}

// Each request carries its own port: the Worker's message channel belongs to dsh's tunnel.
function transcribeChunk(samples, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Transcription cancelled')); return; }
    const { port1, port2 } = new MessageChannel();
    const done = () => { port1.close(); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { done(); reject(new Error('Transcription cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
    port1.onmessage = event => { done(); if (event.data?.error) reject(new Error(event.data.error)); else resolve(String(event.data?.result?.text || '')); };
    globalThis.postMessage({ t: 'dish-speech', samples }, [port2, samples.buffer]);
  });
}

export function apply(ctx) {
  ctx.effect(() => ctx.speechToText.register({
    info: { id: 'naklios', name: 'NakliOS on-device (voice assistant model)', location: 'host-local', languages: ['auto'] },
    async transcribe(input, signal) {
      const started = performance.now();
      const samples = wavSamples(input.audio);
      const parts = [];
      for (let at = 0; at < samples.length; at += CHUNK) parts.push(await transcribeChunk(samples.slice(at, at + CHUNK), signal));
      return { text: parts.map(part => part.trim()).filter(Boolean).join(' '), audioSeconds: samples.length / SAMPLE_RATE,
        inferenceSeconds: (performance.now() - started) / 1000 };
    },
  }));
}
