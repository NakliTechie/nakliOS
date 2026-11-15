// Speech for Listen and the Audio overview: Gradium's Phonon 31m English model (Apache-2.0), run on this device by
// the phonon-tts browser package (MIT OR Apache-2.0, vendored unmodified in vendor/phonon-tts-0.7.1). It runs on the
// CPU in a worker, so it never competes for the GPU. The model (about 65 MB) and two voice files (256 KB each) come
// from Hugging Face the first time, pinned to fixed commits, and stay in this browser's cache. The browser's own
// system voices are not used.

const BASE = new URL('../vendor/phonon-tts-0.7.1/', import.meta.url);
const VOICES_AT = 'https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/';

/** The two hosts' voices, from the Apache-2.0 catalog gradium/phonon-voices (British English, the catalog's first pair). */
export const VOICE_FOR = /** @type {Record<string, { name: string, id: string }>} */ ({
  Asha: { name: 'maeve', id: '6PWnV0Nq4wu7RVBT' },
  Ravi: { name: 'alfie', id: 'X6NceqF285Gr04gb' },
});
export const DOWNLOAD_LABEL = 'about 65 MB';
/** Silence between two speakers' lines, in seconds. */
const GAP = 0.3;

/** @type {Promise<any> | null} */
let loading = null;

/**
 * Load the model and both voices once per page. A failed load can be retried.
 * @param {{ onProgress?: (p: { file: string, loaded: number, total: number, cached?: boolean }) => void }} [opts]
 */
export function loadSpeech({ onProgress } = {}) {
  loading ??= (async () => {
    const { PhononTTS } = await import(new URL('index.js', BASE).href);
    const tts = await PhononTTS.load({ lang: 'en', device: 'cpu', onProgress });
    for (const v of Object.values(VOICE_FOR)) await tts.addVoice(v.name, `${VOICES_AT}${v.id}.safetensors`);
    return tts;
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** The voice name for a speaker; an unknown speaker (or a plain note) gets the first host's voice. @param {string} speaker */
export const voiceOf = (speaker) => (VOICE_FOR[speaker] ?? Object.values(VOICE_FOR)[0]).name;

/**
 * Play lines in order, each in its speaker's voice, streaming so the first words play within moments. Resolves when
 * the last line has finished playing, or at once after stop().
 * @param {any} tts @param {{ speaker: string, text: string }[]} lines
 * @param {{ onLine?: (i: number) => void }} [opts]
 */
export function playLines(tts, lines, { onLine } = {}) {
  const ctx = new AudioContext({ sampleRate: tts.sampleRate });
  const ctl = new AbortController();
  /** @type {ReturnType<typeof setTimeout>[]} */
  const timers = [];
  let stopped = false;
  const done = (async () => {
    let t = ctx.currentTime + 0.1;
    for (const [i, line] of lines.entries()) {
      if (stopped) break;
      let first = true;
      const stream = tts.stream(line.text, { voice: voiceOf(line.speaker), signal: ctl.signal });
      try {
        for await (const pcm of stream) {
          if (stopped) break;
          const buffer = ctx.createBuffer(1, pcm.length, tts.sampleRate);
          buffer.getChannelData(0).set(pcm);
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(ctx.destination);
          t = Math.max(t, ctx.currentTime);
          if (first) {
            first = false;
            const at = Math.max(0, (t - ctx.currentTime) * 1000);
            timers.push(setTimeout(() => !stopped && onLine?.(i), at));
          }
          src.start(t);
          t += buffer.duration;
        }
      } catch (e) {
        if (!stopped) throw e;
      }
      t += GAP;
    }
    // Wait for the scheduled audio to finish before saying it is over.
    while (!stopped && ctx.currentTime < t - GAP) await new Promise((r) => setTimeout(r, 200));
  })().finally(() => {
    timers.forEach(clearTimeout);
    ctx.close().catch(() => {});
  });
  return {
    done,
    stop() {
      stopped = true;
      ctl.abort();
      ctx.close().catch(() => {});
    },
  };
}

/**
 * Render lines into one 16-bit WAV file, each in its speaker's voice, with a short pause between lines.
 * @param {any} tts @param {{ speaker: string, text: string }[]} lines @param {{ onLine?: (i: number) => void }} [opts]
 */
export async function renderWav(tts, lines, { onLine } = {}) {
  const { concatPcm, encodeWav } = await import(new URL('index.js', BASE).href);
  const gap = new Float32Array(Math.round(GAP * tts.sampleRate));
  const parts = [];
  for (const [i, line] of lines.entries()) {
    onLine?.(i);
    parts.push(await tts.synth(line.text, { voice: voiceOf(line.speaker) }), gap);
  }
  return encodeWav(concatPcm(parts), tts.sampleRate);
}
