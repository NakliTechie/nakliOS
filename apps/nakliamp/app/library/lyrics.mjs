// Lyrics (T6, T7): embedded lyrics and `.lrc` sidecar files.
//
// `readLyrics(file, sidecarFile)` returns
//   { synced, lines: [{ timeS | null, text }], source: 'embedded' | 'lrc' }
// or null when neither source has any text. Synced lyrics win over plain ones;
// between two of the same kind, the sidecar wins, because a person put it
// there on purpose.
//
// Headless by contract: no DOM, no network.

import { readLyricsText } from './metadata.mjs';

// A lyrics file is text; anything larger is not lyrics and is not read whole.
const MAX_LRC_BYTES = 1024 * 1024;
const MAX_LINES = 10_000;

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx], and the [mm:ss:xx] variant.
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/y;
const TAG = /^\[([a-z#]+):([^\]]*)\]\s*$/i;

function stampSeconds(minutes, seconds, fraction) {
  const whole = Number(minutes) * 60 + Number(seconds);
  if (!fraction) return whole;
  return whole + Number(fraction) / 10 ** fraction.length;
}

/**
 * Parse LRC text.
 * - A line may carry several stamps (`[00:10.00][01:20.00]chorus`); it becomes
 *   one line per stamp.
 * - `[offset:+500]` is in milliseconds; a positive offset shows lines sooner.
 * - Word-level `<mm:ss.xx>` stamps (enhanced LRC) are removed from the text.
 * - With no stamps at all, the text is plain lyrics: `synced` is false and
 *   every line has `timeS: null`.
 * Returns `{ synced, lines, offsetS }`.
 */
/** The `[offset:...]` tag sets the offset in ms; any other ID tag keeps `current`. */
function offsetFromTag(tag, current) {
  if (tag[1].toLowerCase() !== 'offset') return current;
  const value = Number.parseInt(tag[2].trim(), 10);
  return Number.isFinite(value) ? value : current;
}

/** The leading `[mm:ss.xx]` stamps of a line, in seconds, and the text after them. */
function readStamps(line) {
  const stamps = [];
  // A sticky regex resets lastIndex to 0 on a miss, so the end of the last
  // stamp is tracked separately.
  let consumed = 0;
  STAMP.lastIndex = 0;
  let match;
  while ((match = STAMP.exec(line)) !== null) {
    consumed = STAMP.lastIndex;
    if (Number(match[2]) < 60) stamps.push(stampSeconds(match[1], match[2], match[3]));
  }
  return { stamps, rest: line.slice(consumed) };
}

/** Plain lyrics: trim blank lines at either end, keep inner stanza breaks. */
function plainLyrics(plain) {
  while (plain.length && !plain[0].trim()) plain.shift();
  while (plain.length && !plain[plain.length - 1].trim()) plain.pop();
  return { synced: false, lines: plain.map(text => ({ timeS: null, text })), offsetS: 0 };
}

export function parseLrc(text) {
  const rows = String(text ?? '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const timed = [];
  const plain = [];
  let offsetMs = 0;

  for (const raw of rows) {
    if (timed.length + plain.length >= MAX_LINES) break;
    const line = raw.trim();
    const tag = TAG.exec(line);
    if (tag && !/^\d+$/.test(tag[1])) {
      offsetMs = offsetFromTag(tag, offsetMs);
      continue; // ar, ti, al, by, length and other ID tags are not lyrics
    }

    const { stamps, rest } = readStamps(line);
    if (stamps.length) {
      const words = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
      for (const timeS of stamps) timed.push({ timeS, text: words });
    } else {
      plain.push(raw.replace(/\s+$/, ''));
    }
  }

  if (timed.length) {
    const offsetS = offsetMs / 1000;
    const lines = timed
      .map(line => ({ timeS: Math.max(0, Math.round((line.timeS - offsetS) * 1000) / 1000), text: line.text }))
      .sort((left, right) => left.timeS - right.timeS);
    return { synced: true, lines, offsetS };
  }

  return plainLyrics(plain);
}

/**
 * The index of the line to highlight at `timeS`, or -1 before the first line.
 * Binary search, so a long lyric costs nothing per animation frame.
 */
export function lineIndexAt(lines, timeS) {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((lines[middle].timeS ?? Infinity) <= timeS) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found;
}

/** The sidecar name for a track file name: same base name, `.lrc`. */
export function sidecarNameFor(name) {
  return `${String(name ?? '').replace(/\.[^./]+$/, '')}.lrc`;
}

async function readSidecar(sidecarFile) {
  if (!sidecarFile || typeof sidecarFile.text !== 'function') return null;
  if (Number(sidecarFile.size) > MAX_LRC_BYTES) return null;
  try {
    return await sidecarFile.text();
  } catch {
    return null;
  }
}

const hasText = parsed => parsed.lines.some(line => line.text);

/**
 * Lyrics for a track: embedded in `file`, or in `sidecarFile` (an `.lrc`
 * File or Blob beside it). Returns null when there are none. Never throws.
 */
export async function readLyrics(file, sidecarFile = null) {
  const candidates = [];
  const sidecarText = await readSidecar(sidecarFile);
  if (sidecarText) {
    const parsed = parseLrc(sidecarText);
    if (hasText(parsed)) candidates.push({ ...parsed, source: 'lrc' });
  }
  let embeddedText = null;
  try {
    embeddedText = file ? await readLyricsText(file) : null;
  } catch {
    embeddedText = null;
  }
  if (embeddedText) {
    const parsed = parseLrc(embeddedText);
    if (hasText(parsed)) candidates.push({ ...parsed, source: 'embedded' });
  }
  if (!candidates.length) return null;
  const chosen = candidates.find(candidate => candidate.synced) ?? candidates[0];
  return { synced: chosen.synced, lines: chosen.lines, source: chosen.source };
}
