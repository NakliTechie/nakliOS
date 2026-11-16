// Cue sheets (parity row P12): one-file albums shown and played as separate
// tracks.
//
// A `.cue` file next to an album image (one FLAC, WAV or APE holding the whole
// disc) names where each track starts. This module parses the sheet and turns
// it into virtual track records: ordinary index rows whose `virtual` field
// says which file to load and which span of it to play. The parent image is
// flagged `hidden` so track lists show the tracks instead of the one long file.
//
// Gapless across virtual boundaries needs no work: consecutive virtual tracks
// are one file playing on.
//
// Headless and pure: no DOM, no IndexedDB, no network. The scanner calls
// `planCueRecords` and writes what it returns.

/** Cue frames: 75 per second (Red Book CD audio). */
export const CUE_FRAMES_PER_SECOND = 75;

// A sheet is a few kilobytes. Anything past this is not a cue sheet.
const MAX_CUE_BYTES = 512 * 1024;
const MAX_TRACKS = 99;

export class CueFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CueFormatError';
    this.code = 'ERR_NAKLIAMP_CUE_INVALID';
  }
}

/** True for a `.cue` file name. */
export function isCuePath(path) {
  return /\.cue$/i.test(String(path ?? ''));
}

/**
 * Decode cue bytes. Sheets written by older rippers are Windows-1252, newer
 * ones UTF-8 (sometimes with a byte-order mark). UTF-8 is tried strictly
 * first, so a valid UTF-8 sheet is never misread.
 */
export function decodeCueBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(view).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(view);
  }
}

/** `mm:ss:ff` to seconds, or null when the text is not a cue time. */
export function cueTimeToSeconds(text) {
  const match = /^(\d{1,4}):(\d{1,2}):(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [minutes, seconds, frames] = match.slice(1).map(Number);
  if (seconds > 59 || frames >= CUE_FRAMES_PER_SECOND) return null;
  return minutes * 60 + seconds + frames / CUE_FRAMES_PER_SECOND;
}

/** Split one cue line into its command and arguments, honouring quotes. */
function tokens(line) {
  const out = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(line))) out.push(match[1] ?? match[2]);
  return out;
}

/** The rest of a line after its command, unquoted: `TITLE "A B"` gives `A B`. */
function restOf(line, skip = 1) {
  const parts = tokens(line);
  return parts.slice(skip).join(' ').trim() || null;
}

function yearOf(text) {
  const match = /\b(\d{4})\b/.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

/**
 * Parse cue sheet text.
 *
 * Returns `{ title, performer, genre, year, files: [{ name, type, tracks:
 * [{ number, title, performer, startS, pregapS }] }] }`. `startS` is the
 * track's INDEX 01; `pregapS` its INDEX 00 when present. Tracks without an
 * INDEX 01 are dropped (they cannot be placed). Throws CueFormatError when the
 * text has no FILE with a placeable AUDIO track, because then it is not a
 * sheet this player can use.
 */
export function parseCue(text) {
  const source = String(text ?? '');
  if (source.length > MAX_CUE_BYTES) throw new CueFormatError('The cue sheet is larger than 512 KB.');
  const state = { sheet: { title: null, performer: null, genre: null, year: null, files: [] }, file: null, track: null };

  for (const raw of source.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = tokens(line);
    const handler = CUE_COMMANDS[parts[0].toUpperCase()];
    if (handler) handler(state, parts, line);
  }

  const { sheet } = state;
  for (const entry of sheet.files) {
    entry.tracks = entry.tracks.filter(item => item.startS !== null).sort((a, b) => a.startS - b.startS);
  }
  sheet.files = sheet.files.filter(entry => entry.tracks.length);
  if (!sheet.files.length) throw new CueFormatError('The cue sheet names no audio track with a start time.');
  return sheet;
}

function cueRem(state, parts, line) {
  if (state.track) return; // per-track REM fields are not used
  const key = (parts[1] ?? '').toUpperCase();
  const value = restOf(line, 2);
  if (key === 'GENRE') state.sheet.genre = value;
  else if (key === 'DATE') state.sheet.year = yearOf(value);
}

function cueFile(state, parts) {
  // FILE "name with spaces.wav" WAVE: the type is the last token.
  const name = parts.length >= 3 ? parts.slice(1, -1).join(' ') : parts[1];
  if (!name) return;
  state.file = { name, type: parts.length >= 3 ? parts[parts.length - 1].toUpperCase() : null, tracks: [] };
  state.sheet.files.push(state.file);
  state.track = null;
}

function isAudioTrackNumber(number, type) {
  return Number.isInteger(number) && number >= 1 && number <= MAX_TRACKS && type === 'AUDIO';
}

function cueTrack(state, parts) {
  state.track = null;
  if (!state.file) return; // a TRACK before any FILE has nothing to play
  const number = Number(parts[1]);
  const type = (parts[2] ?? '').toUpperCase();
  if (!isAudioTrackNumber(number, type)) return;
  state.track = { number, title: null, performer: null, startS: null, pregapS: null };
  state.file.tracks.push(state.track);
}

function cueIndex(state, parts) {
  if (!state.track) return;
  const index = Number(parts[1]);
  const at = cueTimeToSeconds(parts[2]);
  if (at === null) return;
  if (index === 1) state.track.startS = at;
  else if (index === 0) state.track.pregapS = at;
}

/** TITLE and PERFORMER set the current track's field, or the sheet's before any track. */
const cueText = field => (state, parts, line) => {
  (state.track ?? state.sheet)[field] = restOf(line);
};

const CUE_COMMANDS = Object.freeze({
  REM: cueRem,
  FILE: cueFile,
  TRACK: cueTrack,
  INDEX: cueIndex,
  TITLE: cueText('title'),
  PERFORMER: cueText('performer'),
});

/**
 * Spans for one FILE's tracks: each ends where the next starts; the last ends
 * at `durationS` (null when the duration is unknown, meaning "to the end").
 * A track whose span would be empty or negative is dropped.
 */
export function cueSpans(tracks, durationS = null) {
  const sorted = [...tracks].sort((a, b) => a.startS - b.startS);
  const spans = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const next = sorted[i + 1];
    const endS = next ? next.startS : (Number.isFinite(durationS) ? durationS : null);
    if (endS !== null && endS <= sorted[i].startS) continue;
    spans.push({ ...sorted[i], endS });
  }
  return spans;
}

const AUDIO_EXTENSIONS = /\.(flac|wav|wave|ape|wv|tta|tak|m4a|mp3|ogg|opus|aif|aiff|aifc|alac)$/i;
const stem = name => String(name).replace(/\.[^./]+$/, '').toLowerCase();
const dirOf = path => String(path).split('/').slice(0, -1).join('/');
const baseOf = path => String(path).split('/').pop();

/**
 * Find the audio file a cue FILE line means, among the paths in the cue's own
 * folder. Exact name first (case-insensitive), then the same stem with another
 * audio extension: rippers often write `FILE "x.wav"` and the image is later
 * compressed to `x.flac` without editing the sheet. Returns a path or null.
 */
export function resolveCueFile(cuePath, fileName, audioPaths) {
  const folder = dirOf(cuePath);
  const wanted = baseOf(String(fileName).replace(/\\/g, '/'));
  const siblings = [...audioPaths].filter(path => dirOf(path) === folder);
  const exact = siblings.find(path => baseOf(path).toLowerCase() === wanted.toLowerCase());
  if (exact) return exact;
  const sameStem = siblings.filter(path => AUDIO_EXTENSIONS.test(path) && stem(baseOf(path)) === stem(wanted));
  return sameStem.length === 1 ? sameStem[0] : null;
}

/** The library path of a virtual track: parent path, `#`, track number. */
export function virtualPath(parentPath, number) {
  return `${parentPath}#${number}`;
}

/** True when a track record is a cue-sheet virtual track. */
export function isVirtual(track) {
  return Boolean(track?.virtual);
}

/** Tracks to list: everything except parent images a cue sheet replaced. */
export function visibleTracks(tracks) {
  return tracks.filter(track => !track.hidden);
}

const PLAYBACK_STATE = ['resumePositionS', 'playCount', 'lastPlayedAt', 'bookmarked', 'addedAt', 'rating'];

/**
 * Build virtual records for one parent from a parsed sheet's FILE entry.
 * `parent` is the parent's index record; `previous` maps path to an existing
 * record so playback state survives a rescan. `cuePath` is null for a sheet
 * embedded in the parent's tags. Returns records without `id` (the scanner
 * hashes the path, as it does for every row).
 */
export function virtualRecords({ sheet, fileEntry, parent, cuePath = null, previous = new Map() }) {
  const spans = cueSpans(fileEntry.tracks, parent.durationS ?? null);
  // A FILE holding one track that starts at zero is an ordinary file, not an
  // album image: nothing to split, so nothing to hide.
  if (spans.length < 2) return [];
  return spans.map(span => virtualRecord({ sheet, span, trackTotal: spans.length, parent, cuePath, previous }));
}

/** The first value that is neither null nor undefined, else null. */
function firstOf(...values) {
  return values.find(value => value !== null && value !== undefined) ?? null;
}

/** Fields a virtual track copies from its parent file, each defaulting to null. */
function parentFields(parent) {
  return {
    name: firstOf(parent.name),
    size: parent.size,
    lastModified: parent.lastModified ?? 0,
    container: firstOf(parent.container),
    discNo: firstOf(parent.discNo),
    discTotal: firstOf(parent.discTotal),
    sampleRate: firstOf(parent.sampleRate),
    channels: firstOf(parent.channels),
    artKey: firstOf(parent.artKey),
    dirArtKey: firstOf(parent.dirArtKey),
    replayGain: firstOf(parent.replayGain),
    parserVersion: parent.parserVersion ?? 0,
  };
}

function virtualRecord({ sheet, span, trackTotal, parent, cuePath, previous }) {
  const path = virtualPath(parent.path, span.number);
  const old = previous.get(path);
  const inherited = parentFields(parent);
  const record = {
    path,
    name: inherited.name,
    size: inherited.size,
    lastModified: inherited.lastModified,
    container: inherited.container,
    title: span.title ?? `Track ${span.number}`,
    artist: firstOf(span.performer, sheet.performer, parent.artist),
    album: firstOf(sheet.title, parent.album),
    albumArtist: firstOf(sheet.performer, parent.albumArtist),
    trackNo: span.number,
    trackTotal,
    discNo: inherited.discNo,
    discTotal: inherited.discTotal,
    year: firstOf(sheet.year, parent.year),
    genre: firstOf(sheet.genre, parent.genre),
    durationS: span.endS === null ? null : span.endS - span.startS,
    sampleRate: inherited.sampleRate,
    channels: inherited.channels,
    hasLyrics: false,
    artKey: inherited.artKey,
    dirArtKey: inherited.dirArtKey,
    replayGain: inherited.replayGain,
    parserVersion: inherited.parserVersion,
    virtual: { parentPath: parent.path, startS: span.startS, endS: span.endS, cuePath },
  };
  for (const field of PLAYBACK_STATE) if (old && old[field] !== undefined) record[field] = old[field];
  record.addedAt ||= parent.addedAt || 0;
  return record;
}

/**
 * The scanner's cue pass, as a pure function.
 *
 * - `cues`: `[{ path, text }]` for every `.cue` file the walk found.
 * - `embedded`: `[{ parentPath, text }]` for sheets read from a file's tags.
 * - `records`: Map path to the current record of every audio file in scope
 *   (fresh or unchanged).
 * - `previous`: Map path to every existing record in scope, virtual ones too.
 * - `unchangedParents`: paths of parents that were not re-read this scan.
 *
 * Returns `{ virtual, hidden, keep, errors }`: new virtual records (no ids),
 * the set of parent paths to flag hidden, existing virtual paths to keep
 * (embedded sheets of unchanged parents, which were not re-read), and
 * `[{ path, message }]` for sheets that could not be used.
 */
export function planCueRecords({ cues = [], embedded = [], records, previous = new Map(), unchangedParents = new Set() }) {
  const virtual = [];
  const hidden = new Set();
  const keep = new Set();
  const errors = [];
  const audioPaths = [...records.keys()];

  const addFor = (sheet, fileEntry, parentPath, cuePath) => {
    const parent = records.get(parentPath);
    if (!parent || hidden.has(parentPath)) return;
    const built = virtualRecords({ sheet, fileEntry, parent, cuePath, previous });
    if (!built.length) return;
    virtual.push(...built);
    hidden.add(parentPath);
  };

  for (const cue of cues) addCueFile(cue, { audioPaths, errors, addFor });
  for (const item of embedded) addEmbeddedSheet(item, { errors, addFor });
  keepUnchangedEmbedded({ previous, records, unchangedParents, hidden, keep });

  return { virtual, hidden, keep, errors };
}

/** Parse a `.cue` file and add virtual records for every FILE it resolves. */
function addCueFile(cue, { audioPaths, errors, addFor }) {
  let sheet;
  try { sheet = parseCue(cue.text); } catch (error) { errors.push({ path: cue.path, message: error.message }); return; }
  let used = 0;
  for (const fileEntry of sheet.files) {
    const parentPath = resolveCueFile(cue.path, fileEntry.name, audioPaths);
    if (!parentPath) continue;
    used += 1;
    addFor(sheet, fileEntry, parentPath, cue.path);
  }
  if (!used) errors.push({ path: cue.path, message: 'The cue sheet names no audio file in its folder.' });
}

/** Parse a sheet embedded in a file's tags and add its virtual records. */
function addEmbeddedSheet(item, { errors, addFor }) {
  let sheet;
  try { sheet = parseCue(item.text); } catch (error) { errors.push({ path: item.parentPath, message: error.message }); return; }
  // An embedded sheet always describes its own file, whatever FILE says.
  const tracks = sheet.files.flatMap(entry => entry.tracks);
  addFor(sheet, { name: baseOf(item.parentPath), type: null, tracks }, item.parentPath, null);
}

/**
 * Sheets embedded in parents that were not re-read are not in `embedded`;
 * their children stay as they are.
 */
function keepUnchangedEmbedded({ previous, records, unchangedParents, hidden, keep }) {
  for (const [path, record] of previous) {
    const parentPath = record.virtual?.parentPath;
    if (!parentPath || record.virtual.cuePath !== null) continue;
    if (unchangedParents.has(parentPath) && records.has(parentPath) && !hidden.has(parentPath)) keep.add(path);
  }
  for (const path of keep) hidden.add(previous.get(path).virtual.parentPath);
}

/**
 * What the player does for a track: `{ path, startS, endS }` where `path` is
 * the file to load. An ordinary track plays its own file from 0 to the end
 * (`endS` null).
 */
export function playbackSpan(track) {
  if (track?.virtual) {
    return { path: track.virtual.parentPath, startS: track.virtual.startS, endS: track.virtual.endS ?? null };
  }
  return { path: track?.path ?? null, startS: 0, endS: null };
}

/**
 * Whether playback of a virtual track has reached its end and the player
 * should advance. `toleranceS` absorbs the coarse `timeupdate` cadence.
 */
export function reachedSpanEnd(track, positionS, toleranceS = 0.05) {
  const span = playbackSpan(track);
  return span.endS !== null && Number.isFinite(positionS) && positionS >= span.endS - toleranceS;
}

/**
 * True when moving from `from` to `to` needs no new load: both are spans of
 * one file and `to` starts where `from` ends, so the file plays on.
 */
export function continuesInFile(from, to) {
  if (!from?.virtual || !to?.virtual) return false;
  return from.virtual.parentPath === to.virtual.parentPath
    && from.virtual.endS !== null
    && Math.abs(from.virtual.endS - to.virtual.startS) < 1e-6;
}
