/* Reel ai module: pure logic for Q1 (subtitles from speech) and Q2 (subtitle translation).
 * No DOM, no network: tested in Node by test/ai.test.mjs.
 *
 * Transcription works in 30-second windows that overlap by 2 seconds, because Whisper reads 30 s at a
 * time and a word cut at a window edge would otherwise be lost. Each window keeps the segments that
 * start inside its own share of the overlap, so a segment heard twice is kept once. The NakliOS host
 * speech model returns text without timestamps; for it, repeated words at the start of a window are
 * dropped by matching the end of the previous window's text, and cue times are spread over the window
 * by character count (approximate timing). */

export const WINDOW_S = 30;
export const OVERLAP_S = 2;
export const SAMPLE_RATE = 16000;
export const MAX_CUE_CHARS = 84;
export const MAX_LINE_CHARS = 42;

/* Languages offered for speech and translation. Codes are what Whisper and the prompt receive. */
export const LANGUAGES = [
  ['en', 'English'], ['hi', 'Hindi'], ['bn', 'Bengali'], ['ta', 'Tamil'], ['te', 'Telugu'],
  ['mr', 'Marathi'], ['gu', 'Gujarati'], ['kn', 'Kannada'], ['ml', 'Malayalam'], ['pa', 'Punjabi'],
  ['ur', 'Urdu'], ['fr', 'French'], ['de', 'German'], ['es', 'Spanish'], ['pt', 'Portuguese'],
  ['it', 'Italian'], ['nl', 'Dutch'], ['ru', 'Russian'], ['ar', 'Arabic'], ['tr', 'Turkish'],
  ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'], ['id', 'Indonesian'],
].map(([code, name]) => ({ code, name }));

export function languageName(codeOrName) {
  const value = String(codeOrName || '').trim();
  const hit = LANGUAGES.find(l => l.code === value.toLowerCase() || l.name.toLowerCase() === value.toLowerCase());
  return hit ? hit.name : value;
}
export function languageCode(codeOrName) {
  const value = String(codeOrName || '').trim();
  const hit = LANGUAGES.find(l => l.code === value.toLowerCase() || l.name.toLowerCase() === value.toLowerCase());
  return hit ? hit.code : value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'xx';
}

/* ---------- window planning ---------- */

/* Windows of windowS seconds stepping by windowS - overlapS. keepFromS/keepToS split each overlap at its
 * middle, so every instant belongs to exactly one window's keep range. */
export function planWindows(durationS, { windowS = WINDOW_S, overlapS = OVERLAP_S } = {}) {
  const total = Number(durationS);
  if (!Number.isFinite(total) || total <= 0) return [];
  if (!(overlapS >= 0) || !(windowS > overlapS)) throw new RangeError('windowS must exceed overlapS');
  const step = windowS - overlapS;
  const windows = [];
  for (let fromS = 0, index = 0; ; fromS += step, index++) {
    const toS = Math.min(total, fromS + windowS);
    windows.push({ index, fromS: round3(fromS), toS: round3(toS) });
    if (toS >= total) break;
  }
  const half = overlapS / 2;
  windows.forEach((w, i) => {
    w.keepFromS = i === 0 ? 0 : round3(w.fromS + half);
    w.keepToS = i === windows.length - 1 ? Infinity : round3(windows[i + 1].fromS + half);
  });
  return windows;
}

/* True when the window's audio is below about -60 dBFS RMS, so Whisper is not asked to hear silence
 * (it tends to invent text there). */
export function isSilent(pcm, threshold = 0.001) {
  if (!pcm || !pcm.length) return true;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length) < threshold;
}

/* ---------- text helpers ---------- */

const NOISE = /^\s*[[(]\s*(blank_audio|silence|no speech)\s*[\])]\s*$/i;

/* Plain cue text: drops HTML-style tags, ASS override blocks and repeated spaces. */
export function cleanCueText(text) {
  return String(text ?? '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\N/g, '\n')
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

const norm = word => word.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const words = text => String(text || '').split(/\s+/).filter(Boolean);

/* Removes the words at the start of `current` that repeat the end of `previous` (at least minWords). */
export function dropRepeatedPrefix(previous, current, { maxWords = 20, minWords = 2 } = {}) {
  const pw = words(previous).map(norm);
  const raw = words(current);
  const cw = raw.map(norm);
  for (let k = Math.min(maxWords, pw.length, cw.length); k >= minWords; k--) {
    let same = true;
    for (let i = 0; i < k && same; i++) same = pw[pw.length - k + i] === cw[i] && cw[i] !== '';
    if (same) return raw.slice(k).join(' ');
  }
  return raw.join(' ');
}

/* Breaks text into pieces of at most maxChars: sentence ends first, then commas, then words.
 * Text without spaces (Chinese, Japanese) breaks by character. */
export function splitText(text, maxChars = MAX_CUE_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  if (flat.length <= maxChars) return [flat];
  const sentences = flat.match(/[^.!?。！？…]+[.!?。！？…]+["'”’)]*\s*|[^.!?。！？…]+$/g) || [flat];
  const out = [];
  for (const sentence of sentences.map(s => s.trim()).filter(Boolean)) {
    if (sentence.length <= maxChars) { out.push(sentence); continue; }
    const clauses = sentence.split(/(?<=[,;:，、；])\s*/);
    for (const clause of clauses) {
      if (clause.length <= maxChars) { out.push(clause); continue; }
      const parts = clause.includes(' ') ? clause.split(' ') : [...clause];
      const joiner = clause.includes(' ') ? ' ' : '';
      let piece = '';
      for (const part of parts) {
        const next = piece ? piece + joiner + part : part;
        if (next.length > maxChars && piece) { out.push(piece); piece = part; } else piece = next;
      }
      if (piece) out.push(piece);
    }
  }
  // Join short neighbours back together while they fit.
  const merged = [];
  for (const piece of out) {
    const last = merged[merged.length - 1];
    if (last && (last + ' ' + piece).length <= maxChars) merged[merged.length - 1] = last + ' ' + piece;
    else merged.push(piece);
  }
  return merged;
}

/* Wraps a cue into at most two lines near the middle when it is longer than one line. */
export function wrapCue(text, maxLine = MAX_LINE_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLine || !flat.includes(' ')) return flat;
  const mid = flat.length / 2;
  let best = -1;
  for (let i = 0; i < flat.length; i++) {
    if (flat[i] === ' ' && (best < 0 || Math.abs(i - mid) < Math.abs(best - mid))) best = i;
  }
  return best < 0 ? flat : `${flat.slice(0, best)}\n${flat.slice(best + 1)}`;
}

/* Spreads text over [fromS, toS] as cues, timed by character count. */
export function spreadText(text, fromS, toS, maxChars = MAX_CUE_CHARS) {
  const pieces = splitText(text, maxChars);
  const total = pieces.reduce((n, p) => n + p.length, 0);
  if (!total || !(toS > fromS)) return [];
  const span = toS - fromS;
  let at = fromS;
  return pieces.map(piece => {
    const startS = at;
    at += span * (piece.length / total);
    return { startS: round3(startS), endS: round3(at), text: piece };
  });
}

/* Reading time for a cue with no end time: about 15 characters a second, 1 to 7 seconds. */
const readingTimeS = text => Math.max(1, Math.min(7, String(text).length / 15));

/* ---------- assembling cues from window results ---------- */

/* results: [{ window, chunks?: [{ start, end, text }] (seconds from the window start), text? }].
 * Returns cues [{ startS, endS, text }] sorted, de-duplicated across overlaps, with every end set. */
export function assembleCues(results, { overlapS = OVERLAP_S } = {}) {
  const segments = [];
  let previousText = '';
  for (const { window: w, chunks, text } of results) {
    if (Array.isArray(chunks) && chunks.length) {
      for (const chunk of chunks) {
        const body = cleanCueText(chunk.text);
        if (!body || NOISE.test(body)) continue;
        const startS = w.fromS + (Number(chunk.start) || 0);
        if (startS < w.keepFromS || startS >= w.keepToS) continue;
        const endS = Number.isFinite(chunk.end) && chunk.end != null ? w.fromS + chunk.end : null;
        segments.push({ startS: round3(startS), endS: endS == null ? null : round3(endS), text: body });
      }
      previousText = chunks.map(c => c.text).join(' ');
    } else if (text && cleanCueText(text) && !NOISE.test(text)) {
      const body = cleanCueText(text).replace(/\n/g, ' ');
      const fresh = w.index === 0 ? body : dropRepeatedPrefix(previousText, body);
      const fromS = w.index === 0 ? w.fromS : Math.min(w.toS, w.fromS + overlapS);
      segments.push(...spreadText(fresh, fromS, w.toS));
      previousText = body;
    } else {
      previousText = '';
    }
  }
  segments.sort((a, b) => a.startS - b.startS);
  // Drop a segment that repeats the previous kept one within the overlap distance.
  const unique = [];
  for (const seg of segments) {
    const last = unique[unique.length - 1];
    if (last && norm(last.text.replace(/\s+/g, '')) === norm(seg.text.replace(/\s+/g, '')) && seg.startS - last.startS <= overlapS + 1) continue;
    unique.push(seg);
  }
  // Long segments become several cues; ends are clamped to the next start.
  const cues = [];
  unique.forEach((seg, i) => {
    const nextStart = unique[i + 1]?.startS ?? Infinity;
    let endS = seg.endS ?? seg.startS + readingTimeS(seg.text);
    endS = Math.min(endS, nextStart);
    if (!(endS > seg.startS)) endS = Math.min(seg.startS + 0.5, nextStart > seg.startS ? nextStart : seg.startS + 0.5);
    const pieces = seg.text.replace(/\n/g, ' ').length > MAX_CUE_CHARS ? spreadText(seg.text, seg.startS, endS) : [{ startS: seg.startS, endS, text: seg.text }];
    for (const p of pieces) cues.push({ startS: round3(p.startS), endS: round3(p.endS), text: wrapCue(p.text) });
  });
  return cues;
}

/* ---------- SRT ---------- */

export function formatTimestamp(seconds) {
  const ms = Math.max(0, Math.round(Number(seconds) * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function formatSrt(cues) {
  const blocks = cues.map((cue, i) => `${i + 1}\n${formatTimestamp(cue.startS)} --> ${formatTimestamp(cue.endS)}\n${cue.text}`);
  return blocks.length ? `${blocks.join('\n\n')}\n` : '';
}

export function parseTimestamp(value) {
  const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$/.exec(value || '');
  if (!m) return NaN;
  const [, h = '0', mi, s, frac = '0'] = m;
  return Number(h) * 3600 + Number(mi) * 60 + Number(s) + Number(frac.padEnd(3, '0')) / 1000;
}

/* Parses SRT (and plain WebVTT cue blocks). Returns { cues, errors }: errors names each block it skipped. */
export function parseSrt(text) {
  const cues = [];
  const errors = [];
  const blocks = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n\s*\n/);
  blocks.forEach((block, i) => {
    const lines = block.split('\n').filter(line => line.trim() !== '');
    if (!lines.length || /^WEBVTT/.test(lines[0])) return;
    const at = lines.findIndex(line => line.includes('-->'));
    if (at < 0) { errors.push(`block ${i + 1}: no time line`); return; }
    const [a, b] = lines[at].split('-->');
    const startS = parseTimestamp(a);
    const endS = parseTimestamp(String(b).trim().split(/\s+/)[0]);
    if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS < startS) { errors.push(`block ${i + 1}: bad time line "${lines[at]}"`); return; }
    const body = lines.slice(at + 1).join('\n');
    cues.push({ startS, endS, text: body });
  });
  cues.sort((x, y) => x.startS - y.startS);
  return { cues, errors };
}

/* ---------- translation ---------- */

const SENTENCE_END = /[.!?。！？…]["'”’)\]]*$/;

/* Groups adjacent cues into sentences: a group ends at sentence punctuation, a gap over maxGapS,
 * maxCues cues or maxChars characters. Returns [{ from, to, text }] (cue index range, inclusive). */
export function mergeCuesIntoSentences(cues, { maxCues = 4, maxChars = 240, maxGapS = 1.5 } = {}) {
  const groups = [];
  let current = null;
  cues.forEach((cue, i) => {
    const text = cleanCueText(cue.text).replace(/\n/g, ' ');
    const gap = current ? cue.startS - cues[i - 1].endS : 0;
    const fits = current && i - current.from < maxCues && (current.text + ' ' + text).length <= maxChars && gap <= maxGapS;
    if (current && fits && !SENTENCE_END.test(current.text)) {
      current.to = i;
      current.text = `${current.text} ${text}`.trim();
    } else {
      if (current) groups.push(current);
      current = { from: i, to: i, text };
    }
  });
  if (current) groups.push(current);
  return groups;
}

/* Splits a translated sentence back over its cues, in proportion to the source cues' lengths. */
export function splitTranslation(text, weights) {
  const n = weights.length;
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (n <= 1) return [flat];
  // Character units only for scripts written without spaces (Chinese, Japanese, Thai); else words.
  const spaced = flat.includes(' ') || !/[\u0e00-\u0e7f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(flat);
  const units = spaced ? flat.split(' ').filter(Boolean) : [...flat];
  const joiner = spaced ? ' ' : '';
  const totalWeight = weights.reduce((a, b) => a + Math.max(1, b), 0);
  const totalChars = units.reduce((a, u) => a + u.length, 0) || 1;
  const parts = Array.from({ length: n }, () => []);
  let part = 0, chars = 0, bound = totalChars * Math.max(1, weights[0]) / totalWeight;
  units.forEach((unit, i) => {
    const left = units.length - i;
    // Move on when past this part's share, unless the remaining parts would then get no unit at all.
    while (part < n - 1 && parts[part].length && (chars + unit.length / 2 > bound || left <= n - 1 - part)) {
      part++;
      bound += totalChars * Math.max(1, weights[part]) / totalWeight;
    }
    parts[part].push(unit);
    chars += unit.length;
  });
  return parts.map(p => p.join(joiner));
}

/* The chat messages for one batch of numbered lines. */
export function translationMessages(lines, language) {
  const n = lines.length;
  const target = languageName(language);
  return [
    { role: 'system', content: `You translate film and video subtitles into ${target}. Translate each numbered line into ${target}. Reply with exactly ${n} lines, numbered 1 to ${n} in the same order, each in the form "1. translated text". Keep each line's meaning inside that line. Do not merge, split, skip or add lines, and add no notes.` },
    { role: 'user', content: lines.map((line, i) => `${i + 1}. ${line}`).join('\n') },
  ];
}

/* Reads a numbered reply. Throws an error with code LINE_COUNT unless lines 1..n each appear once. */
export function parseNumberedLines(reply, n) {
  const byNumber = new Map();
  let last = null;
  for (const raw of String(reply || '').replace(/```[a-z]*\n?/gi, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\d{1,4})\s*[.):\-]\s*(.*)$/.exec(line);
    if (m) {
      const k = Number(m[1]);
      if (byNumber.has(k)) throw Object.assign(new Error(`line ${k} appears twice in the reply`), { code: 'LINE_COUNT' });
      byNumber.set(k, m[2].trim());
      last = k;
    } else if (last != null) {
      byNumber.set(last, `${byNumber.get(last)} ${line}`.trim());
    }
  }
  const missing = [];
  for (let k = 1; k <= n; k++) if (!byNumber.has(k)) missing.push(k);
  const extra = [...byNumber.keys()].filter(k => k < 1 || k > n);
  if (missing.length || extra.length) {
    throw Object.assign(new Error(`expected ${n} numbered lines, got ${byNumber.size}${missing.length ? ` (missing ${missing.slice(0, 5).join(', ')})` : ''}`), { code: 'LINE_COUNT' });
  }
  return Array.from({ length: n }, (_, i) => byNumber.get(i + 1));
}

/* Builds translated cues: each group's translation is split back over its cues, times kept.
 * A cue left with no words lends its time to the cue before it. */
export function applyTranslation(cues, groups, translations) {
  if (translations.length !== groups.length) throw Object.assign(new Error(`${translations.length} translations for ${groups.length} sentences`), { code: 'LINE_COUNT' });
  const out = [];
  groups.forEach((group, g) => {
    const members = cues.slice(group.from, group.to + 1);
    const pieces = splitTranslation(translations[g], members.map(c => cleanCueText(c.text).length));
    members.forEach((cue, i) => {
      const text = pieces[i];
      if (text) out.push({ startS: cue.startS, endS: cue.endS, text: wrapCue(text) });
      else if (out.length) out[out.length - 1].endS = Math.max(out[out.length - 1].endS, cue.endS);
    });
  });
  return out;
}

export function batches(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function stripExtension(name) {
  return String(name || 'video').replace(/\.[^./\\]+$/, '');
}

function round3(x) { return Math.round(x * 1000) / 1000; }
