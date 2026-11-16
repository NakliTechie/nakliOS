/* Reel transport: pure logic (no DOM, no engine). Tested by test/transport.test.mjs in Node. */

/* ---------------------------------------------------------- jump to time -- */

/* Parses a typed time: "1:23:45", "83:20" (minutes may pass 59 when they lead), "90" (seconds),
 * "1:02.5" (fractional seconds) or "45%" (of durationS).
 * Returns { ok: true, seconds } or { ok: false, reason } with reason "empty", "format" or "range". */
export function parseTime(input, durationS = Infinity) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };
  const limit = Number.isFinite(durationS) && durationS >= 0 ? durationS : Infinity;

  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(text);
  if (percent) {
    const value = Number(percent[1]);
    if (value > 100 || !Number.isFinite(limit)) return { ok: false, reason: 'range' };
    return { ok: true, seconds: (value / 100) * limit };
  }

  if (!/^\d+(?::\d+){0,2}(?:\.\d+)?$/.test(text)) return { ok: false, reason: 'format' };
  const parts = text.split(':');
  const numbers = parts.map(Number);
  // Every part after the first is a sexagesimal digit pair: below 60.
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] >= 60 || parts[i].split('.')[0].length > 2) return { ok: false, reason: 'format' };
  }
  const seconds = numbers.reduce((total, value) => total * 60 + value, 0);
  if (!Number.isFinite(seconds) || seconds > limit) return { ok: false, reason: 'range' };
  return { ok: true, seconds };
}

/* ------------------------------------------------------------- chapters -- */

const EPSILON_S = 0.001;

/* Sorts and cleans engine chapters; fills a missing endS from the next start or the duration. */
export function normaliseChapters(chapters, durationS = null) {
  const list = (Array.isArray(chapters) ? chapters : [])
    .filter(chapter => chapter && Number.isFinite(chapter.startS))
    .map(chapter => ({ startS: Math.max(0, chapter.startS), endS: chapter.endS, title: chapter.title || '' }))
    .sort((a, b) => a.startS - b.startS);
  return list.map((chapter, i) => {
    const fallback = i + 1 < list.length ? list[i + 1].startS : (Number.isFinite(durationS) ? durationS : chapter.startS);
    return { ...chapter, endS: Number.isFinite(chapter.endS) && chapter.endS > chapter.startS ? chapter.endS : fallback };
  });
}

/* Index of the chapter containing positionS, or -1 before the first chapter (or with none). */
export function chapterIndexAt(chapters, positionS) {
  let found = -1;
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i].startS <= positionS + EPSILON_S) found = i;
    else break;
  }
  return found;
}

/* Index of the next chapter after positionS, or -1 when positionS is in the last one. */
export function nextChapterIndex(chapters, positionS) {
  return chapters.findIndex(chapter => chapter.startS > positionS + EPSILON_S);
}

/* Previous chapter, as most players do it: more than thresholdS into a chapter goes to its
 * start; otherwise to the start of the chapter before (or the first chapter's start). -1 if none. */
export function previousChapterIndex(chapters, positionS, thresholdS = 3) {
  if (!chapters.length) return -1;
  const current = chapterIndexAt(chapters, positionS);
  if (current < 0) return 0;
  if (positionS - chapters[current].startS > thresholdS) return current;
  return Math.max(0, current - 1);
}

/* ------------------------------------------------------------ A-B loop -- */

/* Loop state: { phase: 'off' | 'a' | 'ab', aS, bS }. */
export const LOOP_OFF = Object.freeze({ phase: 'off', aS: null, bS: null });

/* One press of the loop key at positionS.
 * Returns { state, effect } where effect is 'setA', 'setB', 'clear' or 'reject' (B at or before A). */
export function cycleLoop(state, positionS) {
  const current = state || LOOP_OFF;
  if (current.phase === 'off') return { state: { phase: 'a', aS: positionS, bS: null }, effect: 'setA' };
  if (current.phase === 'a') {
    if (!(positionS > current.aS)) return { state: current, effect: 'reject' };
    return { state: { phase: 'ab', aS: current.aS, bS: positionS }, effect: 'setB' };
  }
  return { state: LOOP_OFF, effect: 'clear' };
}

/* Sets both points at once; rejects B at or before A. */
export function setLoopPoints(aS, bS) {
  if (!Number.isFinite(aS) || !Number.isFinite(bS) || aS < 0 || !(bS > aS)) return { state: null, effect: 'reject' };
  return { state: { phase: 'ab', aS, bS }, effect: 'setB' };
}

/* --------------------------------------------------------- audio delay -- */

export const AUDIO_DELAY_STEP_S = 0.05;
export const AUDIO_DELAY_LIMIT_S = 10;

/* Clamps to ±10 s and rounds to the millisecond, so repeated 50 ms steps do not drift. */
export function clampAudioDelay(seconds) {
  const value = Number.isFinite(seconds) ? seconds : 0;
  const clamped = Math.max(-AUDIO_DELAY_LIMIT_S, Math.min(AUDIO_DELAY_LIMIT_S, value));
  return Math.round(clamped * 1000) / 1000 || 0;
}

/* "+50 ms", "-1250 ms", "0 ms". Uses a plain hyphen-minus. */
export function formatDelay(seconds) {
  const ms = Math.round(clampAudioDelay(seconds) * 1000);
  return `${ms > 0 ? '+' : ''}${ms} ms`;
}

/* -------------------------------------------------------- audio tracks -- */

/* Index after current, wrapping; -1 for an empty list. */
export function nextTrackIndex(count, current, delta = 1) {
  if (!(count > 0)) return -1;
  const start = Number.isInteger(current) && current >= 0 ? current : 0;
  return (((start + delta) % count) + count) % count;
}

/* Translator fallback for Node tests: fills {name} placeholders from the English STRINGS in index.mjs
 * style. index.mjs passes ctx.t instead. */
const FALLBACK = {
  'transport.audio.mono': 'Mono',
  'transport.audio.stereo': 'Stereo',
  'transport.audio.channels': '{count} channels',
  'transport.audio.trackN': 'Track {n}',
};
export function fallbackT(key, values = null) {
  const template = FALLBACK[key] ?? key;
  return values ? template.replace(/\{(\w+)\}/g, (m, name) => (name in values ? String(values[name]) : m)) : template;
}

/* "Mono", "Stereo", "5.1", "7.1" or "N channels"; null when unknown. */
export function channelLayout(channels, t = fallbackT) {
  if (!Number.isFinite(channels) || channels < 1) return null;
  switch (channels) {
    case 1: return t('transport.audio.mono');
    case 2: return t('transport.audio.stereo');
    case 3: return '2.1';
    case 6: return '5.1';
    case 8: return '7.1';
    default: return t('transport.audio.channels', { count: channels });
  }
}

/* English name for a language code ("fra" -> "French"); the code itself if unknown; null for und. */
export function languageName(code) {
  if (!code || code === 'und') return null;
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/* { title, detail } for a track descriptor: title is its name, else its language, else "Track N". */
export function describeAudioTrack(track, index, t = fallbackT) {
  const language = languageName(track?.language);
  const codec = track?.codec ? String(track.codec).toUpperCase() : null;
  const layout = channelLayout(track?.channels, t);
  const title = track?.name || language || t('transport.audio.trackN', { n: index + 1 });
  const detail = [track?.name ? language : null, codec, layout].filter(Boolean).join(' · ');
  return { title, detail };
}
