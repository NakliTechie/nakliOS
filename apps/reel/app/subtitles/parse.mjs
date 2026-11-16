/* SRT, WebVTT and ASS/SSA parsing into one cue shape, plus SRT/VTT serialisation.
 * Pure: no DOM, runs in Node for test/subtitles.test.mjs.
 *
 * Cue shape: { startS, endS, lines, placement }
 *   lines      array of lines; each line is an array of runs { text, i, b, u }
 *   placement  'top' when the file asks for the top of the picture ({\an8}, VTT line:0), else null
 * Text is never treated as HTML: the renderer builds text nodes from runs. */

const TIME = String.raw`(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?`;
const TIMING_RE = new RegExp(`^\\s*${TIME}\\s*-->\\s*${TIME}(.*)$`);

export function parseTimestamp(text) {
  const match = new RegExp(`^\\s*${TIME}\\s*$`).exec(text);
  return match ? timeFrom(match, 1) : null;
}

function timeFrom(match, at) {
  const hours = Number(match[at] || 0);
  const minutes = Number(match[at + 1]);
  const seconds = Number(match[at + 2]);
  const fraction = match[at + 3] ? Number(match[at + 3].padEnd(3, '0')) / 1000 : 0;
  return hours * 3600 + minutes * 60 + seconds + fraction;
}

export function detectFormat(text, name = '') {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'ass' || ext === 'ssa') return 'ass';
  if (ext === 'vtt') return 'vtt';
  if (ext === 'srt') return 'srt';
  const head = text.replace(/^﻿/, '').trimStart().slice(0, 200);
  if (/^WEBVTT/.test(head)) return 'vtt';
  if (/^\[(Script Info|V4\+? Styles|Events)\]/i.test(head)) return 'ass';
  return 'srt';
}

/* Parses a whole file. Returns cues sorted by start time. */
export function parseSubtitles(text, format = detectFormat(text)) {
  const clean = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues = format === 'ass' ? parseAss(clean) : parseTimedText(clean, format === 'vtt' ? 'vtt' : 'srt');
  return finishCues(cues);
}

/* SRT and VTT share one line-based reader, so a missing blank line between cues or at the end
 * of the file still parses: a cue ends at a blank line, or where a counter line is followed by
 * the next timing line. */
function parseTimedText(text, format) {
  const lines = text.split('\n');
  const cues = [];
  for (let i = 0; i < lines.length; i += 1) {
    const timing = TIMING_RE.exec(lines[i]);
    if (!timing) continue;
    const startS = timeFrom(timing, 1);
    const endS = timeFrom(timing, 5);
    const settings = timing[9] || '';
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') break;
      if (TIMING_RE.test(line)) break;
      if (/^\s*\d+\s*$/.test(line) && j + 1 < lines.length && TIMING_RE.test(lines[j + 1])) break;
      body.push(line);
    }
    i = j - 1;
    const parsed = parseInline(body.join('\n'), format);
    const placement = parsed.placement || (format === 'vtt' ? vttPlacement(settings) : null);
    cues.push({ startS, endS, lines: parsed.lines, placement });
  }
  return cues;
}

function vttPlacement(settings) {
  const line = /(?:^|\s)line:(-?[\d.]+)(%?)/.exec(settings);
  if (!line) return null;
  const value = Number(line[1]);
  if (line[2] === '%') return value < 50 ? 'top' : null;
  return value >= 0 ? 'top' : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', nbsp: ' ', lrm: '‎', rlm: '‏', quot: '"', apos: "'" };
function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|nbsp|lrm|rlm|quot|apos|#\d+|#x[0-9a-f]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/* Inline markup of an SRT or VTT cue payload: <i> <b> <u> become styles; other tags
 * (<font>, <c.x>, <v Name>, <ruby>, timestamps) are dropped; SSA-style {\an8} sets placement
 * and other {\...} blocks are dropped. */
export function parseInline(payload, format = 'srt') {
  const style = { i: false, b: false, u: false };
  const lines = [[]];
  let placement = null;
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*|\d[\d:.]*)(?:[.\s][^<>]*)?>|\{\\[^{}]*\}|\n/g;
  let last = 0;
  const push = raw => {
    if (!raw) return;
    const text = format === 'vtt' ? decodeEntities(raw) : raw;
    lines[lines.length - 1].push({ text, i: style.i, b: style.b, u: style.u });
  };
  for (let match = token.exec(payload); match; match = token.exec(payload)) {
    push(payload.slice(last, match.index));
    last = token.lastIndex;
    const whole = match[0];
    if (whole === '\n') { lines.push([]); continue; }
    if (whole[0] === '{') {
      const align = /\\an?(\d+)/.exec(whole);
      if (align && isTopAlign(whole, Number(align[1]))) placement = 'top';
      continue;
    }
    const tag = match[2].toLowerCase();
    if (tag === 'i' || tag === 'b' || tag === 'u') style[tag] = !match[1];
  }
  push(payload.slice(last));
  return { lines: trimLines(lines), placement };
}

function isTopAlign(block, n) {
  // \anN uses numpad layout (7-9 top); legacy \aN uses 5-7 for top (5, 6, 7) and 9-11 for middle.
  return /\\an\d/.test(block) ? n >= 7 && n <= 9 : n >= 5 && n <= 7;
}

function trimLines(lines) {
  const out = lines.map(line => line.filter(run => run.text !== ''));
  while (out.length && !out[0].length) out.shift();
  while (out.length && !out[out.length - 1].length) out.pop();
  return out;
}

/* ---------- ASS / SSA ---------- */

function parseAss(text) {
  const cues = [];
  let section = '';
  let format = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === ';') continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { section = header[1].toLowerCase(); continue; }
    if (section !== 'events') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const kind = line.slice(0, colon).trim().toLowerCase();
    const rest = line.slice(colon + 1).trimStart();
    if (kind === 'format') {
      format = rest.split(',').map(field => field.trim().toLowerCase());
      continue;
    }
    if (kind !== 'dialogue') continue;
    const fields = format || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
    const values = splitFields(rest, fields.length);
    const get = name => values[fields.indexOf(name)];
    const startS = parseAssTime(get('start'));
    const endS = parseAssTime(get('end'));
    if (startS === null || endS === null) continue;
    const parsed = assTextToLines(get('text') ?? '');
    if (!parsed.lines.length) continue;
    cues.push({ startS, endS, lines: parsed.lines, placement: parsed.placement });
  }
  return cues;
}

function splitFields(text, count) {
  const out = [];
  let rest = text;
  for (let k = 0; k < count - 1; k += 1) {
    const comma = rest.indexOf(',');
    if (comma < 0) { out.push(rest); rest = ''; continue; }
    out.push(rest.slice(0, comma).trim());
    rest = rest.slice(comma + 1);
  }
  out.push(rest);
  return out;
}

function parseAssTime(text) {
  const match = /^\s*(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\s*$/.exec(text || '');
  if (!match) return null;
  const fraction = match[4] ? Number(`0.${match[4]}`) : 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction;
}

/* ASS dialogue text to plain styled lines: override blocks {\...} are read for \i \b \u,
 * \an placement and \p drawing mode, then dropped; drawing commands (\p1 until \p0) are
 * removed; \N and \n break lines; \h is a non-breaking space. */
export function assTextToLines(text) {
  const style = { i: false, b: false, u: false };
  const lines = [[]];
  let placement = null;
  let drawing = false;
  const push = raw => {
    if (!raw || drawing) return;
    const parts = raw.replace(/\\h/g, ' ').split(/\\[Nn]/);
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines[lines.length - 1].push({ text: part, i: style.i, b: style.b, u: style.u });
    });
  };
  const block = /\{([^{}]*)\}/g;
  let last = 0;
  for (let match = block.exec(text); match; match = block.exec(text)) {
    push(text.slice(last, match.index));
    last = block.lastIndex;
    const body = match[1];
    for (const tag of body.matchAll(/\\(an?|p|i|b|u)(-?\d+)/g)) {
      const value = Number(tag[2]);
      if (tag[1] === 'p') drawing = value > 0;
      else if (tag[1] === 'i' || tag[1] === 'u') style[tag[1]] = value !== 0;
      else if (tag[1] === 'b') style.b = value !== 0 && (value === 1 || value >= 600);
      else if (isTopAlign(`\\${tag[1]}${tag[2]}`, value)) placement = 'top';
    }
  }
  push(text.slice(last));
  return { lines: trimLines(lines), placement };
}

/* An embedded Matroska ASS/SSA block holds "ReadOrder,Layer,Style,Name,MarginL,MarginR,
 * MarginV,Effect,Text"; a full "Dialogue:" line is also accepted. */
export function assPayloadToLines(payload) {
  const text = String(payload).replace(/\r\n?/g, '\n').trim();
  if (/^Dialogue:/i.test(text)) {
    const values = splitFields(text.slice(text.indexOf(':') + 1).trimStart(), 10);
    return assTextToLines(values[9] ?? '');
  }
  return assTextToLines(splitFields(text, 9)[8] ?? '');
}

/* Turns engine cues ({ startS, endS, text }) for a track codec into parsed cues. */
export function cuesFromEngine(rawCues, codec = 'srt') {
  const kind = String(codec || '').toLowerCase();
  const cues = rawCues.map(cue => {
    const parsed = kind === 'ass' || kind === 'ssa'
      ? assPayloadToLines(cue.text)
      : parseInline(String(cue.text ?? '').replace(/\r\n?/g, '\n'), kind === 'webvtt' || kind === 'vtt' ? 'vtt' : 'srt');
    const placement = parsed.placement || (cue.settings ? vttPlacement(cue.settings) : null);
    return { startS: Number(cue.startS), endS: cue.endS == null ? null : Number(cue.endS), lines: parsed.lines, placement };
  });
  return finishCues(cues);
}

function finishCues(cues) {
  const sorted = cues
    .filter(cue => Number.isFinite(cue.startS) && cue.lines.length)
    .sort((a, b) => a.startS - b.startS);
  sorted.forEach((cue, index) => {
    if (!Number.isFinite(cue.endS) || cue.endS <= cue.startS) {
      const next = sorted[index + 1];
      cue.endS = next && next.startS > cue.startS ? Math.min(next.startS, cue.startS + 5) : cue.startS + 5;
    }
  });
  return sorted;
}

/* ---------- output ---------- */

export function plainText(cue) {
  return cue.lines.map(line => line.map(run => run.text).join('')).join('\n');
}

function formatTimestamp(seconds, separator) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(totalMs / 3_600_000))}:${pad(Math.floor((totalMs % 3_600_000) / 60_000))}:${pad(Math.floor((totalMs % 60_000) / 1000))}${separator}${pad(totalMs % 1000, 3)}`;
}

function markup(cue, format) {
  const escape = text => (format === 'vtt' ? text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : text);
  return cue.lines.map(line => line.map(run => {
    let text = escape(run.text);
    if (run.u) text = `<u>${text}</u>`;
    if (run.b) text = `<b>${text}</b>`;
    if (run.i) text = `<i>${text}</i>`;
    return text;
  }).join('')).join('\n');
}

/* Writes cues as SRT or WebVTT. offsetS shifts every cue (the current subtitle delay). */
export function serialiseSubtitles(cues, format = 'srt', offsetS = 0) {
  const separator = format === 'vtt' ? '.' : ',';
  const blocks = cues.map((cue, index) => {
    const timing = `${formatTimestamp(cue.startS + offsetS, separator)} --> ${formatTimestamp(cue.endS + offsetS, separator)}`;
    const settings = format === 'vtt' && cue.placement === 'top' ? ' line:0' : '';
    const prefix = format === 'srt' ? `${index + 1}\n` : '';
    return `${prefix}${timing}${settings}\n${markup(cue, format)}`;
  });
  return `${format === 'vtt' ? 'WEBVTT\n\n' : ''}${blocks.join('\n\n')}\n`;
}
