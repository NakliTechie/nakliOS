// Encoder delay and padding, read from the file itself.
//
// Lossy encoders add silence: MP3 and AAC prime the codec at the start and pad
// the last frame at the end; Opus declares a pre-skip. Gapless playback has to
// cut these, or every album transition carries a few tens of milliseconds of
// silence. Sources read here:
//   - MP3: the LAME (or Lavc/Lavf) tag after the Xing/Info header: 12-bit
//     encoder delay and padding, and the Xing frame count.
//   - MP4/M4A: the iTunSMPB atom: priming, padding, and the original sample count.
//   - Ogg Opus: OpusHead pre-skip and the last page's granule position.
//   - FLAC, WAV, AIFF: lossless, nothing to trim.
// Anything else returns `known: false`, and the gapless lane trims nothing and
// says so, rather than guessing.
//
// Browsers differ on whether decodeAudioData already applies these. So the
// lane does not trim blindly: `reconcileTrim` compares the decoded length with
// the untrimmed and trimmed lengths the file declares, and trims only when the
// decoded length matches the untrimmed one.
//
// Headless: bytes in, numbers out.

const MP3_DECODER_DELAY = 529; // samples a standard MP3 decoder adds (LAME, FFmpeg)

function ascii(bytes, offset, length) {
  let text = '';
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) text += String.fromCharCode(bytes[offset + index]);
  return text;
}

function u32be(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function indexOfAscii(bytes, text, from = 0, to = bytes.length) {
  const first = text.charCodeAt(0);
  const end = Math.min(to, bytes.length - text.length);
  outer: for (let index = Math.max(0, from); index <= end; index += 1) {
    if (bytes[index] !== first) continue;
    for (let k = 1; k < text.length; k += 1) if (bytes[index + k] !== text.charCodeAt(k)) continue outer;
    return index;
  }
  return -1;
}

function lastIndexOfAscii(bytes, text) {
  for (let index = bytes.length - text.length; index >= 0; index -= 1) {
    let match = true;
    for (let k = 0; k < text.length; k += 1) if (bytes[index + k] !== text.charCodeAt(k)) { match = false; break; }
    if (match) return index;
  }
  return -1;
}

const unknown = (format, note) => ({
  format, known: false, source: null, sampleRate: null,
  delayFrames: 0, paddingFrames: 0, skipFrames: 0, validFrames: null, totalFrames: null, extraLeadFrames: 0, note,
});

/** Skip an ID3v2 tag at the start of an MP3; returns the offset after it. */
function afterId3(bytes) {
  if (ascii(bytes, 0, 3) !== 'ID3' || bytes.length < 10) return 0;
  const size = (bytes[6] & 0x7f) << 21 | (bytes[7] & 0x7f) << 14 | (bytes[8] & 0x7f) << 7 | (bytes[9] & 0x7f);
  const footer = bytes[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
}

const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Parse an MP3 frame header at `offset`; null when it is not one. */
export function parseMp3Header(bytes, offset) {
  if (offset + 4 > bytes.length) return null;
  const [b0, b1, b2, b3] = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const version = (b1 >> 3) & 3; // 3 MPEG1, 2 MPEG2, 0 MPEG2.5
  const layer = (b1 >> 1) & 3; // 1 = Layer III
  const rateIndex = (b2 >> 2) & 3;
  if (version === 1 || layer !== 1 || rateIndex === 3 || ((b2 >> 4) & 0xf) === 0xf) return null;
  const mono = ((b3 >> 6) & 3) === 3;
  const mpeg1 = version === 3;
  return {
    version,
    sampleRate: MP3_RATES[version][rateIndex],
    mono,
    samplesPerFrame: mpeg1 ? 1152 : 576,
    sideInfoBytes: mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17),
  };
}

/** The first MP3 frame header within 64 KiB after any ID3 tag, with its offset, or null. */
function findMp3Frame(bytes) {
  let offset = afterId3(bytes);
  const limit = Math.min(bytes.length - 4, offset + 64 * 1024);
  for (; offset < limit; offset += 1) {
    const header = parseMp3Header(bytes, offset);
    if (header) return { offset, header };
  }
  return null;
}

/** Read the Xing/Info frame count (flag 1) and skip the other flagged fields; returns where the LAME tag starts. */
function readXingFields(bytes, xing) {
  const flags = u32be(bytes, xing + 4);
  let cursor = xing + 8;
  let frames = null;
  if (flags & 1) { frames = u32be(bytes, cursor); cursor += 4; }
  if (flags & 2) cursor += 4;
  if (flags & 4) cursor += 100;
  if (flags & 8) cursor += 4;
  return { frames, cursor };
}

function parseMp3(bytes) {
  const found = findMp3Frame(bytes);
  if (!found) return unknown('mp3', 'no MP3 frame found; nothing trimmed');
  const { offset, header } = found;
  const xing = offset + 4 + header.sideInfoBytes;
  const tag = ascii(bytes, xing, 4);
  if (tag !== 'Xing' && tag !== 'Info') {
    return unknown('mp3', 'no Xing/Info header, so encoder delay and padding are unknown; nothing trimmed');
  }
  const { frames, cursor } = readXingFields(bytes, xing);
  const encoder = ascii(bytes, cursor, 4);
  if (!/^[A-Za-z]{4}$/.test(encoder) || cursor + 24 > bytes.length) {
    return unknown('mp3', 'Xing header without a LAME tag, so encoder delay is unknown; nothing trimmed');
  }
  const d = cursor + 21;
  const delay = (bytes[d] << 4) | (bytes[d + 1] >> 4);
  const padding = ((bytes[d + 1] & 0x0f) << 8) | bytes[d + 2];
  const spf = header.samplesPerFrame;
  const totalFrames = frames === null ? null : frames * spf;
  const validFrames = totalFrames === null ? null : Math.max(0, totalFrames - delay - padding);
  return {
    format: 'mp3',
    known: true,
    source: `${encoder} tag`,
    sampleRate: header.sampleRate,
    delayFrames: delay,
    paddingFrames: padding,
    skipFrames: delay + MP3_DECODER_DELAY,
    validFrames,
    totalFrames,
    // Some decoders emit the Xing/Info frame itself as one frame of silence.
    extraLeadFrames: spf,
    note: `${encoder} tag: ${delay} samples delay, ${padding} samples padding`,
  };
}

function parseMp4(bytes) {
  let sampleRate = null;
  const entry = indexOfAscii(bytes, 'mp4a');
  if (entry >= 0 && entry + 30 <= bytes.length) {
    const rate = (bytes[entry + 28] << 8) | bytes[entry + 29];
    if (rate > 0) sampleRate = rate;
  }
  const name = indexOfAscii(bytes, 'iTunSMPB');
  if (name < 0) return { ...unknown('mp4', 'no iTunSMPB atom, so priming and padding are unknown; nothing trimmed'), sampleRate };
  const data = indexOfAscii(bytes, 'data', name, name + 64);
  if (data < 0) return { ...unknown('mp4', 'iTunSMPB atom without data; nothing trimmed'), sampleRate };
  const size = u32be(bytes, data - 4);
  const text = ascii(bytes, data + 12, Math.max(0, Math.min(256, size - 16)));
  const fields = text.trim().split(/\s+/).map(value => parseInt(value, 16));
  if (fields.length < 4 || fields.slice(0, 4).some(value => !Number.isFinite(value))) {
    return { ...unknown('mp4', 'iTunSMPB value unreadable; nothing trimmed'), sampleRate };
  }
  const [, delay, padding, valid] = fields;
  return {
    format: 'mp4',
    known: true,
    source: 'iTunSMPB',
    sampleRate,
    delayFrames: delay,
    paddingFrames: padding,
    skipFrames: delay,
    validFrames: valid,
    totalFrames: delay + valid + padding,
    extraLeadFrames: 0,
    note: `iTunSMPB: ${delay} samples priming, ${padding} samples padding`,
  };
}

function parseOgg(bytes) {
  const head = indexOfAscii(bytes, 'OpusHead', 0, 4096);
  if (head < 0) {
    if (indexOfAscii(bytes, 'vorbis', 0, 4096) >= 0) {
      return { ...unknown('vorbis', 'Ogg Vorbis: the decoder trims by granule position; nothing extra trimmed'), known: true, source: 'none needed' };
    }
    return unknown('ogg', 'Ogg stream of unknown codec; nothing trimmed');
  }
  const preSkip = bytes[head + 10] | (bytes[head + 11] << 8);
  const lastPage = lastIndexOfAscii(bytes, 'OggS');
  let granule = null;
  if (lastPage >= 0 && lastPage + 14 <= bytes.length) {
    const low = (bytes[lastPage + 6] | (bytes[lastPage + 7] << 8) | (bytes[lastPage + 8] << 16) | (bytes[lastPage + 9] << 24)) >>> 0;
    const high = (bytes[lastPage + 10] | (bytes[lastPage + 11] << 8) | (bytes[lastPage + 12] << 16) | (bytes[lastPage + 13] << 24)) >>> 0;
    if (high !== 0xffffffff) granule = high * 2 ** 32 + low;
  }
  const validFrames = granule === null ? null : Math.max(0, granule - preSkip);
  return {
    format: 'opus',
    known: true,
    source: 'OpusHead',
    sampleRate: 48000,
    delayFrames: preSkip,
    paddingFrames: 0,
    skipFrames: preSkip,
    validFrames,
    totalFrames: granule,
    extraLeadFrames: 0,
    note: `Opus pre-skip ${preSkip} samples`,
  };
}

/**
 * Read encoder delay and padding from a whole file's bytes.
 *
 * Returns `{ format, known, source, sampleRate, delayFrames, paddingFrames,
 * skipFrames, validFrames, totalFrames, extraLeadFrames, note }`. Frames are
 * at the file's own sample rate. `skipFrames` is how much to cut from the
 * start of an untrimmed decode (for MP3 that includes the decoder's own 529).
 */
export function parseTrim(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return unknown(null, 'file too short to read; nothing trimmed');
  const magic4 = ascii(bytes, 0, 4);
  if (magic4 === 'fLaC' || magic4 === 'RIFF' || magic4 === 'FORM') {
    return { ...unknown(magic4 === 'fLaC' ? 'flac' : magic4 === 'RIFF' ? 'wav' : 'aiff', 'lossless: no encoder delay to trim'), known: true, source: 'none needed' };
  }
  if (magic4 === 'OggS') return parseOgg(bytes);
  if (ascii(bytes, 4, 4) === 'ftyp') return parseMp4(bytes);
  if (ascii(bytes, 0, 3) === 'ID3' || parseMp3Header(bytes, 0)) return parseMp3(bytes);
  return unknown(null, 'format has no known delay information; nothing trimmed');
}

/**
 * Decide what to cut from a decoded buffer.
 *
 * `decodedFrames` and `decodedRate` describe what the browser returned (often
 * resampled to the context rate, so all comparisons are in seconds). The file
 * declares an untrimmed length and a trimmed one; the decoded length is
 * matched against each, within 25 ms:
 *   - matches the trimmed length: the browser already trimmed; cut nothing.
 *   - matches the untrimmed length: cut `skipFrames` at the start and keep
 *     `validFrames`.
 *   - matches neither, or the file declares no lengths: cut nothing.
 *
 * Returns `{ startS, endS, applied, reason }`; `endS` null means "to the end".
 */
export function reconcileTrim(trim, decodedFrames, decodedRate) {
  const refusal = trimRefusal(trim, decodedFrames, decodedRate);
  if (refusal !== null) return noTrim(refusal);
  const rate = trim.sampleRate || decodedRate;
  const decodedS = decodedFrames / decodedRate;
  const validS = trim.validFrames / rate;
  const best = closestHypothesis(trimHypotheses(trim, rate, validS), decodedS);
  if (!best || best.distance > 0.025) {
    return noTrim(`${trim.note}; decoded length ${decodedS.toFixed(3)} s matches neither the trimmed nor the untrimmed length, so nothing trimmed`);
  }
  if (best.kind === 'trimmed' || (best.startS === 0 && Math.abs(validS - decodedS) < 1 / rate)) {
    return noTrim(`${trim.note}; the browser decoder already trimmed it`);
  }
  const startS = Math.min(best.startS, decodedS);
  const endS = Math.min(decodedS, startS + validS);
  return { startS, endS, applied: true, reason: `${trim.note}; trimmed by NakliAmp` };
}

/** A reconcile result that cuts nothing, with the reason. */
function noTrim(reason) {
  return { startS: 0, endS: null, applied: false, reason };
}

/** The reason nothing can be trimmed before lengths are compared, or null when the comparison can run. */
function trimRefusal(trim, decodedFrames, decodedRate) {
  if (!trim || !trim.known) return trim?.note || 'no encoder delay information; nothing trimmed';
  if (trim.validFrames === null || trim.validFrames === undefined) {
    if (trim.skipFrames || trim.paddingFrames) return `${trim.note}, but the stream length is unknown, so nothing trimmed`;
    return trim.note;
  }
  if (!(decodedRate > 0) || !(decodedFrames > 0)) return 'decoded length unknown; nothing trimmed';
  return null;
}

/** The decoded lengths the file could have: already trimmed, raw, and raw with an extra lead frame. */
function trimHypotheses(trim, rate, validS) {
  const skipS = trim.skipFrames / rate;
  const totalS = (trim.totalFrames ?? (trim.validFrames + trim.delayFrames + trim.paddingFrames)) / rate;
  const leadS = (trim.extraLeadFrames || 0) / rate;
  const hypotheses = [
    { kind: 'trimmed', lengthS: validS },
    { kind: 'raw', lengthS: totalS, startS: skipS },
  ];
  if (leadS) hypotheses.push({ kind: 'raw', lengthS: totalS + leadS, startS: skipS + leadS });
  return hypotheses;
}

/** The hypothesis whose length is closest to the decoded length, with that distance. */
function closestHypothesis(hypotheses, decodedS) {
  let best = null;
  for (const hypothesis of hypotheses) {
    const distance = Math.abs(decodedS - hypothesis.lengthS);
    if (!best || distance < best.distance) best = { ...hypothesis, distance };
  }
  return best;
}
