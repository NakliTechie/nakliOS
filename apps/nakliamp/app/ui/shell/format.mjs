// format.mjs — small pure helpers the shell (index.html) uses for display and
// transport arithmetic. No DOM, so node:test covers them (test/shell-format.test.mjs).

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function stem(name) {
  return String(name || 'Untitled track').replace(/\.[^.]+$/, '');
}

/**
 * The position a seek command asks for, clamped to the track.
 * `input` is `{ seconds }` or `{ percent }` (player.seek), or `{ delta }` for a
 * relative move. Returns null when nothing is loaded or the input names nothing.
 */
function rawSeekTarget(positionS, duration, known, input) {
  if (Number.isFinite(input.seconds)) return input.seconds;
  if (Number.isFinite(input.percent)) return known ? (input.percent / 100) * duration : null;
  if (Number.isFinite(input.delta)) return (Number(positionS) || 0) + input.delta;
  return null;
}

export function seekTarget({ positionS = 0, duration = null } = {}, input = {}) {
  const known = Number.isFinite(duration) && duration > 0;
  let target = rawSeekTarget(positionS, duration, known, input);
  if (target === null) return null;
  target = Math.max(0, target);
  return known ? Math.min(target, Math.max(0, duration - 0.05)) : target;
}

/**
 * The relative seek a key binding sends is ±5 s (plain arrows) or ±30 s (Shift).
 * The plain arrows follow `settings.seekStepS`; the 30 s jumps stay as they are.
 */
export function scaledSeek(seconds, seekStepS = 5, fromKey = false) {
  if (!fromKey || Math.abs(seconds) !== 5) return seconds;
  const step = Number.isFinite(seekStepS) && seekStepS > 0 ? seekStepS : 5;
  return Math.sign(seconds) * step;
}

/** Volume after a keyboard or command step, on the slider's 0.01 grid. */
export function steppedVolume(current, { level, delta } = {}) {
  const base = Number.isFinite(level) ? level : (Number(current) || 0) + (Number(delta) || 0);
  return Math.round(Math.max(0, Math.min(1, base)) * 100) / 100;
}

/** The next value in `list` after `current`, wrapping. */
export function cycle(list, current) {
  const at = list.indexOf(current);
  return list[(at + 1) % list.length];
}

const signed = db => `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(db).toFixed(1)} dB`;

/**
 * The sound part of the honesty strip, from `engine.state().dsp`. Each item is
 * `{ text, tone }` with tone 'active', 'warning' or ''. Returns [] when the
 * engine reports no dsp block (an older engine, or nothing loaded).
 */
function chainItems(dsp) {
  if (dsp.chain === 'off') return [{ text: 'sound chain off', tone: 'warning' }];
  const items = [];
  if (dsp.eq?.enabled) items.push({ text: `EQ ${dsp.eq.preset ?? 'custom'}`, tone: 'active' });
  const source = dsp.gainSource;
  if (!source || source === 'off') return items;
  if (source === 'none') {
    items.push({ text: 'no gain value', tone: '' });
  } else {
    const label = source === 'loudness' ? 'measured' : source;
    items.push({ text: `gain ${signed(Number(dsp.gainDb) || 0)} (${label}${dsp.clipLimited ? ', peak limited' : ''})`, tone: 'active' });
  }
  return items;
}

function laneText(dsp) {
  if (dsp.crossfading) return 'crossfading';
  if (dsp.next === 'gapless') return 'next joins gapless';
  if (dsp.next === 'crossfade') return 'next crossfades';
  return 'gapless route';
}

function laneItems(dsp) {
  if (dsp.lane === 'gapless') {
    const items = [{ text: laneText(dsp), tone: 'active' }];
    if (dsp.trim) items.push({ text: `trim ${dsp.trim}`, tone: '' });
    return items;
  }
  return dsp.laneSkipped ? [{ text: 'gapless unavailable for this file', tone: 'warning' }] : [];
}

export function dspSummary(dsp) {
  if (!dsp || typeof dsp !== 'object') return [];
  return [...chainItems(dsp), ...laneItems(dsp)];
}

/** Display fields for an agent or a panel. Never the path (contract N2). */
export function trackSummary(track) {
  if (!track) return null;
  return {
    id: track.id,
    title: track.title || stem(track.name),
    artist: track.artist ?? null,
    album: track.album ?? null,
    year: track.year ?? null,
    durationS: track.durationS ?? null,
  };
}

/** One page of a list: `{ total, offset, limit, items }`. */
export function page(list, { offset = 0, limit = 20 } = {}) {
  const start = Math.max(0, Math.floor(offset) || 0);
  const size = Math.max(1, Math.min(100, Math.floor(limit) || 20));
  return { total: list.length, offset: start, limit: size, items: list.slice(start, start + size) };
}

/** The engine meta for a track record (contract Audio API: load and preload). */
export function engineMeta(track, loudness = null) {
  if (!track) return null;
  return {
    albumKey: track.albumKey ?? null,
    trackNo: track.trackNo ?? null,
    discNo: track.discNo ?? null,
    replayGain: track.replayGain ?? null,
    loudness: loudness ?? null,
  };
}
