// Speech for Listen and the Audio overview: Gradium's Phonon 31m English model (Apache-2.0), run on this device by
// the phonon-tts browser package (MIT OR Apache-2.0, vendored unmodified in vendor/phonon-tts-0.7.1). It runs on the
// CPU in a worker, so it never competes for the GPU. The model (about 65 MB) and two voice files (256 KB each) come
// from Hugging Face the first time, pinned to fixed commits, and stay in this browser's cache. The browser's own
// system voices are not used.

const BASE = new URL('../vendor/phonon-tts-0.7.1/', import.meta.url);
const VOICES_AT = 'https://huggingface.co/gradium/phonon-voices/resolve/0ee17205f254b5abc43b266c8a0f215565c352f7/voices/';

/**
 * The English voices of the Apache-2.0 catalog gradium/phonon-voices for Phonon 31m: 6 per accent and gender.
 * `id` is the file name in the catalog's voices/ folder.
 */
export const VOICES = [
  ['maeve', '6PWnV0Nq4wu7RVBT', 'British', 'female'], ['freya', 'GgfEkEJtxZR7gnpy', 'British', 'female'], ['pippa', 'uem82D50GRv2Dwma', 'British', 'female'],
  ['imogen', 'gDT1nz7Ie36ZhL-C', 'British', 'female'], ['lottie', 'm9MxpY6IUGXtWp76', 'British', 'female'], ['bryony', 'gfP44RlHwr2kEwk7', 'British', 'female'],
  ['alfie', 'X6NceqF285Gr04gb', 'British', 'male'], ['hugh', 'YyKcxPG7iIgS3jsK', 'British', 'male'], ['edwin', 'zUCxzrOrugTSis03', 'British', 'male'],
  ['spencer', 'JOW0vchyswkQUMDS', 'British', 'male'], ['toby', 'dME3IWyZBvmh1n1q', 'British', 'male'], ['teddy', 'Zn7g6NxLqXlJb7Qi', 'British', 'male'],
  ['zoey', 'NbpkqMVS3CJeq2j8', 'American', 'female'], ['juniper', 'NIWIOv5vTi5eRMj8', 'American', 'female'], ['everly', 'vjFyp2BcCyTlUmYb', 'American', 'female'],
  ['harper', '4SZHfMpw-p46Ywgs', 'American', 'female'], ['hadley', 'bXwrkHhURL1VFJdG', 'American', 'female'], ['delia', 'nGzMHMPAWGaJFHOo', 'American', 'female'],
  ['easton', 'LMDIYE0Oa377Qh6Z', 'American', 'male'], ['micah', '40QrMVgAxFiUnP9f', 'American', 'male'], ['trevor', '0zLApsZfVLLNaEGl', 'American', 'male'],
  ['russell', '_6Aslh2DxfmnRLmP', 'American', 'male'], ['preston', 'qIxlZ7Ei8KvWlyQH', 'American', 'male'], ['miles', 'd9XCyhjo4JhkHF1d', 'American', 'male'],
].map(([name, id, accent, gender]) => ({ name, id, accent, gender, label: `${name[0].toUpperCase()}${name.slice(1)} (${accent}, ${gender})` }));

const byName = (/** @type {string} */ n) => VOICES.find((v) => v.name === n);

/** The default voices: the catalog's first British pair, so the two hosts share an accent. */
export const DEFAULT_VOICES = /** @type {Record<string, string>} */ ({ Asha: 'maeve', Ravi: 'alfie' });

/** The hosts' current voices. The page sets them from the person's choice. */
const chosen = { ...DEFAULT_VOICES };

/** Set a host's voice by catalog name; an unknown name is ignored. @param {string} host @param {string} name */
export function setVoice(host, name) {
  if (byName(name) && host in chosen) chosen[host] = name;
}
export const currentVoices = () => ({ ...chosen });

/** Back-compatible view of the hosts' voices: name and catalog id. */
export const VOICE_FOR = new Proxy(/** @type {Record<string, { name: string, id: string }>} */ ({}), {
  get: (_, host) => (typeof host === 'string' && host in chosen ? { name: chosen[host], id: byName(chosen[host])?.id ?? '' } : undefined),
  ownKeys: () => Object.keys(chosen),
  getOwnPropertyDescriptor: (_, host) => (typeof host === 'string' && host in chosen ? { enumerable: true, configurable: true, value: { name: chosen[host], id: byName(chosen[host])?.id ?? '' } } : undefined),
});
export const DOWNLOAD_LABEL = 'about 65 MB';
/** Pauses between lines, in seconds: after a question, between ordinary lines, and between segments. */
const GAP = { question: 0.18, line: 0.32, segment: 0.7 };
/** How far a short reaction starts before the previous line ends, in seconds. */
const OVERLAP = 0.15;

/** @type {Promise<any> | null} */
let loading = null;

/**
 * Load the model and both voices once per page. A failed load can be retried.
 * @param {{ onProgress?: (p: { file: string, loaded: number, total: number, cached?: boolean }) => void }} [opts]
 */
export function loadSpeech({ onProgress } = {}) {
  loading ??= (async () => {
    const { PhononTTS } = await import(new URL('index.js', BASE).href);
    return PhononTTS.load({ lang: 'en', device: 'cpu', onProgress });
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** Fetch the voice files a set of lines needs (256 KB each, once). @param {any} tts @param {string[]} names */
export async function ensureVoices(tts, names) {
  for (const n of new Set(names)) {
    const v = byName(n);
    if (v && !tts.voices.includes(n)) await tts.addVoice(n, `${VOICES_AT}${v.id}.safetensors`);
  }
}

/** The voice name for a speaker; an unknown speaker (or a plain note) gets the first host's voice. @param {string} speaker */
export const voiceOf = (speaker) => chosen[speaker] ?? chosen.Asha;

/** Read one sentence in a voice, for previewing it. @param {any} tts @param {string} name */
export async function previewVoice(tts, name) {
  await ensureVoices(tts, [name]);
  return playLines(tts, [{ speaker: '', text: `Hello, I'm ${name[0].toUpperCase()}${name.slice(1)}. This is how I sound reading your notebook.`, voice: name }]);
}

/** The pause before a line, and whether it overlaps the line before. @param {{ text: string, speaker?: string, segment?: number }} prev @param {{ text: string, speaker?: string, segment?: number }} line */
export function spacing(prev, line) {
  if (!prev) return 0;
  // The same host carrying on after their own short reaction ("Exactly! And then…") keeps talking.
  if (/** @type {any} */ (prev).speaker && /** @type {any} */ (prev).speaker === /** @type {any} */ (line).speaker && isShort(prev.text)) return 0.08;
  if (line.segment !== undefined && prev.segment !== undefined && line.segment !== prev.segment) return GAP.segment;
  if (isShort(line.text)) return -OVERLAP;
  return /\?\s*$/.test(prev.text) ? GAP.question : GAP.line;
}
const isShort = (/** @type {string} */ t) => t.trim().split(/\s+/).length <= 4 && t.length <= 30;

/**
 * Play lines in order, each in its speaker's voice, streaming so the first words play within moments. Resolves when
 * the last line has finished playing, or at once after stop().
 * @param {any} tts @param {{ speaker: string, text: string, voice?: string, segment?: number }[]} lines
 * @param {{ onLine?: (i: number) => void }} [opts]
 */
export function playLines(tts, lines, { onLine } = {}) {
  const ctx = new AudioContext({ sampleRate: tts.sampleRate });
  const ctl = new AbortController();
  /** @type {ReturnType<typeof setTimeout>[]} */
  const timers = [];
  let stopped = false;
  const done = (async () => {
    await ensureVoices(tts, lines.map((l) => l.voice ?? voiceOf(l.speaker)));
    let t = ctx.currentTime + 0.1;
    for (const [i, line] of lines.entries()) {
      if (stopped) break;
      // A short reaction starts just before the last line ends; other lines wait a pause that fits the turn.
      t = Math.max(ctx.currentTime, t + spacing(lines[i - 1], line));
      let first = true;
      const stream = tts.stream(line.text, { voice: line.voice ?? voiceOf(line.speaker), signal: ctl.signal });
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
    }
    // Wait for the scheduled audio to finish before saying it is over.
    while (!stopped && ctx.currentTime < t) await new Promise((r) => setTimeout(r, 200));
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
  const { encodeWav } = await import(new URL('index.js', BASE).href);
  await ensureVoices(tts, lines.map((l) => l.voice ?? voiceOf(l.speaker)));
  const rate = tts.sampleRate;
  /** @type {{ at: number, pcm: Float32Array }[]} */
  const placed = [];
  let t = 0;
  for (const [i, line] of lines.entries()) {
    onLine?.(i);
    t = Math.max(0, t + spacing(lines[i - 1], line));
    const pcm = await tts.synth(line.text, { voice: line.voice ?? voiceOf(line.speaker) });
    placed.push({ at: Math.round(t * rate), pcm });
    t += pcm.length / rate;
  }
  // Mix, so an overlapping reaction adds to the end of the line before it.
  const out = new Float32Array(Math.max(1, ...placed.map((p) => p.at + p.pcm.length)));
  for (const p of placed) for (let k = 0; k < p.pcm.length; k++) out[p.at + k] = Math.max(-1, Math.min(1, out[p.at + k] + p.pcm[k]));
  return encodeWav(out, rate);
}
