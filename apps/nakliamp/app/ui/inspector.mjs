// inspector.mjs — the track inspector (L10): every tag, the file, ReplayGain and
// measured loudness, listening history, and for the playing track the rung that
// played it and the sound chain's state (from ctx.engine.state()).
//
// update({ trackId }) or update({ track }) picks the track; with neither it shows
// the queue's current track.

import { getLoudness, loudnessKey } from '../library/store.mjs';
import { h, injectCss, nextId } from './dialog.mjs';

// ---------------------------------------------------------------- pure ----

export const RUNG_LABELS = Object.freeze({
  r1: 'Rung 1: WebCodecs decoder into an AudioWorklet',
  r2: "Rung 2: the browser's own media player",
  r3: 'Rung 3: software decoder (WebAssembly)',
  lane: 'Gapless lane: decoded in full, played through Web Audio',
});

export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return `${n} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]} (${n.toLocaleString('en-GB')} bytes)`;
}

export function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return null;
  const total = Math.round(s);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

export function formatDate(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  try {
    return new Date(n).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(n).toISOString();
  }
}

const signedDb = db => (Number.isFinite(db) ? `${db > 0 ? '+' : db < 0 ? '−' : ''}${Math.abs(Math.round(db * 100) / 100)} dB` : null);
const peak = p => (Number.isFinite(p) ? `peak ${Math.round(p * 10000) / 10000}` : null);
const pair = (no, total) => (no ? (total ? `${no} of ${total}` : String(no)) : null);
const channelsText = c => (c === 1 ? 'Mono' : c === 2 ? 'Stereo' : Number.isFinite(c) ? `${c} channels` : null);

const NONE = 'Not set';
const row = (label, value) => ({ label, value: value === null || value === undefined || value === '' ? NONE : String(value) });

function tagRows(track) {
  return [
    row('Title', track.title), row('Artist', track.artist), row('Album', track.album),
    row('Album artist', track.albumArtist), row('Track', pair(track.trackNo, track.trackTotal)),
    row('Disc', pair(track.discNo, track.discTotal)), row('Year', track.year), row('Genre', track.genre),
    row('Lyrics in file', track.hasLyrics ? 'Yes' : 'No'),
    row('Embedded art', track.artKey ? 'Yes' : track.dirArtKey ? 'No (folder image used)' : 'No'),
  ];
}

function fileRows(track) {
  return [
    row('Path', track.path), row('Size', formatBytes(track.size)),
    row('Format', track.container ? String(track.container).toUpperCase() : null),
    row('Sample rate', Number.isFinite(track.sampleRate) && track.sampleRate ? `${track.sampleRate.toLocaleString('en-GB')} Hz` : null),
    row('Channels', channelsText(track.channels)), row('Duration', formatDuration(track.durationS)),
    row('Modified', formatDate(track.lastModified)),
  ];
}

const gainText = (rg, gainDb, peakValue) => (rg ? [signedDb(gainDb), peak(peakValue)].filter(Boolean).join(', ') || null : null);

function loudnessRows(track, loudness) {
  const rg = track.replayGain ?? null;
  return [
    row('Track gain', gainText(rg, rg?.trackGainDb, rg?.trackPeak)),
    row('Album gain', gainText(rg, rg?.albumGainDb, rg?.albumPeak)),
    row('Measured loudness', loudness && Number.isFinite(loudness.integratedLufs)
      ? `${Math.round(loudness.integratedLufs * 10) / 10} LUFS, true peak ${Math.round((loudness.truePeak ?? 0) * 10) / 10} dBTP, gain ${signedDb(loudness.gainDb) ?? '0 dB'}`
      : 'Not measured yet'),
  ];
}

function listeningRows(track) {
  return [
    row('Rating', track.rating ? `${track.rating} of 5 stars` : 'No rating'),
    row('Favourite', track.bookmarked ? 'Yes' : 'No'),
    row('Play count', String(track.playCount ?? 0)),
    row('Last played', formatDate(track.lastPlayedAt) ?? 'Never'),
    row('Added', formatDate(track.addedAt)),
  ];
}

function nextTrackText(dsp) {
  if (dsp.crossfading) return 'Crossfading now';
  if (dsp.gapless) return 'Gapless';
  return dsp.next && dsp.next !== 'none' ? dsp.next : 'Not prepared';
}

function dspRows(dsp) {
  const rows = [
    row('Sound chain', dsp.chain === 'on' ? 'On' : 'Off'),
    row('Gain applied', `${signedDb(dsp.gainDb) ?? '0 dB'}${dsp.gainSource ? ` (${dsp.gainSource})` : ''}${dsp.clipLimited ? ', limited by the peak' : ''}`),
    row('Equaliser', dsp.eq?.enabled ? `On, ${dsp.eq.preset}` : 'Off'),
    row('Next track', nextTrackText(dsp)),
  ];
  if (dsp.trim) rows.push(row('Encoder delay trim', dsp.trim));
  return rows;
}

function playingRows(engine) {
  const dsp = engine.dsp ?? null;
  const honesty = engine.honesty ?? {};
  const rows = [
    row('Rung', RUNG_LABELS[engine.path] ?? engine.path),
    row('Codec', engine.track?.codec ?? honesty.codec),
    row('Decode', honesty.decode), row('Output', honesty.output),
  ];
  if (honesty.fellBackFrom) rows.push(row('Fell back from', RUNG_LABELS[honesty.fellBackFrom] ?? honesty.fellBackFrom));
  if (dsp) rows.push(...dspRows(dsp));
  return rows;
}

/**
 * Sections for a track: [{ title, rows: [{ label, value }] }]. Rows with no value
 * say "Not set" so the inspector shows every field, empty or not.
 * `loudness` is the store's cached measurement or null; `engine` is engine.state()
 * when this track is the one playing, else null.
 */
export function inspectorSections(track, { loudness = null, engine = null } = {}) {
  if (!track) return [];
  const sections = [
    { title: 'Tags', rows: tagRows(track) },
    { title: 'File', rows: fileRows(track) },
    { title: 'Loudness', rows: loudnessRows(track, loudness) },
    { title: 'Listening', rows: listeningRows(track) },
  ];
  if (engine) sections.push({ title: 'Playing now', rows: playingRows(engine) });
  return sections;
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-insp,.nk-insp *{box-sizing:border-box}
.nk-insp{--c-ink:var(--ink,var(--text));color:var(--c-ink);display:grid;gap:14px;min-width:0}
.nk-insp section{border:1px solid var(--line);border-radius:12px;background:var(--panel-2);padding:10px 14px;min-width:0}
.nk-insp h3{margin:0 0 6px;font-size:13px;color:var(--accent)}
.nk-insp dl{display:grid;grid-template-columns:minmax(96px,34%) 1fr;gap:4px 12px;margin:0}
.nk-insp dt{color:var(--muted);font-size:12px}
.nk-insp dd{margin:0;font-size:13px;overflow-wrap:anywhere;min-width:0}
.nk-insp dd.none{color:var(--faint,var(--muted))}
.nk-insp .empty{color:var(--muted)}
@media(max-width:420px){.nk-insp dl{grid-template-columns:1fr}.nk-insp dd{margin-bottom:6px}}
`;

// ------------------------------------------------------------------- UI ----

export function mountInspector(root, ctx) {
  injectCss('inspector', CSS);
  const container = h('div', { className: 'nk-insp', 'aria-live': 'off' });
  root.append(container);
  let wanted = null;
  let token = 0;
  let timer = 0;
  let lastSignature = '';

  function currentTrack() {
    if (wanted?.track) return wanted.track;
    const id = wanted?.trackId ?? ctx.queue?.current?.() ?? null;
    return id ? ctx.library.getTrack(id) : null;
  }

  async function render() {
    const mine = ++token;
    const track = currentTrack();
    if (!track) {
      lastSignature = '';
      container.replaceChildren(h('p', { className: 'empty', textContent: 'Nothing is playing. Pick a track to inspect it.' }));
      return;
    }
    let loudness = null;
    try { loudness = await getLoudness(loudnessKey(track)); } catch { loudness = null; }
    if (mine !== token) return;
    let engine = null;
    if (ctx.queue?.current?.() === track.id) {
      try { engine = ctx.engine?.state?.() ?? null; } catch { engine = null; }
    }
    const sections = inspectorSections(track, { loudness, engine });
    const signature = JSON.stringify(sections);
    if (signature === lastSignature) return;
    lastSignature = signature;
    container.replaceChildren(...sections.map(section => {
      const headingId = nextId('insp');
      return h('section', { 'aria-labelledby': headingId },
        h('h3', { id: headingId, textContent: section.title }),
        h('dl', {}, section.rows.flatMap(r => [
          h('dt', { textContent: r.label }),
          h('dd', { className: r.value === 'Not set' ? 'none' : '', textContent: r.value }),
        ])));
    }));
  }

  // The playing-now rows change as playback moves on (gapless, crossfade, gain).
  timer = setInterval(() => { if (!wanted?.track && !wanted?.trackId) render(); }, 2000);
  const offLibrary = ctx.library.onChange?.(() => render());
  render();

  return {
    update(state) {
      if (state && (state.track || state.trackId)) wanted = { track: state.track ?? null, trackId: state.trackId ?? null };
      else if (state && 'trackId' in state) wanted = null;
      render();
    },
    destroy() {
      clearInterval(timer);
      if (typeof offLibrary === 'function') offLibrary();
      token += 1;
      container.remove();
    },
  };
}
