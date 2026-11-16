/* Reel feature module: subtitles (parity rows T3 to T11, plus a save control for T2).
 * Contract: docs/build/reel-v1-contract.md.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json. */

import { decodeSubtitleBytes, utf8ByteLength } from './decode.mjs';
import { parseSubtitles, detectFormat, cuesFromEngine, serialiseSubtitles, buildAssDocument, MAX_CUES } from './parse.mjs';
import { pgsPacketsToSup, isBitmapCodec } from './pgs.mjs';
import { createStyledRenderer, pickFonts, FONT_LIMITS } from './styled.mjs';
import { createBitmapRenderer } from './bitmap.mjs';
import { CueIndex } from './cues.mjs';
import { matchSidecars, isSubtitleName, stripExtension, describeSidecar, SUBTITLE_EXTENSIONS } from './match.mjs';
import { createCaptions, normaliseStyle, DEFAULT_STYLE, STYLE_LIMITS } from './captions.mjs';

const STYLE_KEY = 'subtitles:style';
const RENDERER_KEY = 'subtitles:renderer';
const DELAY_STEP_S = 0.05;
const DELAY_LIMIT_S = 60;
const MAX_SIDECAR_BYTES = 20 * 1024 * 1024;
const COLOURS = [['#ffffff', 'white'], ['#ffff00', 'yellow'], ['#00ffff', 'cyan'], ['#00ff00', 'green']];

export const COMMANDS = [
  { name: 'subtitle.track', label: 'Subtitle track', scope: 'write', readTwin: 'subtitle.read',
    description: 'Choose the subtitle track by list index (-1 turns subtitles off) or id, or step to the next one, Off included.',
    input: { type: 'object', properties: {
      index: { type: 'integer', minimum: -1, description: 'Position in subtitle.read tracks; -1 is Off' },
      id: { type: 'string', description: 'Track id from subtitle.read' },
      next: { type: 'boolean', description: 'Step to the next track, wrapping through Off' } }, required: [] },
    shortcuts: [{ key: 's', input: { next: true } }] },
  { name: 'subtitle.delay', label: 'Subtitle delay', scope: 'write', readTwin: 'subtitle.read', repeat: true,
    description: 'Set the subtitle delay in seconds (positive shows subtitles later), or change it by a delta. It resets for each file.',
    input: { type: 'object', properties: {
      delayS: { type: 'number', minimum: -DELAY_LIMIT_S, maximum: DELAY_LIMIT_S },
      deltaS: { type: 'number', description: 'Change from the current delay' } }, required: [] },
    shortcuts: [{ key: 'g', input: { deltaS: -DELAY_STEP_S } }, { key: 'h', input: { deltaS: DELAY_STEP_S } }] },
  { name: 'subtitle.style', label: 'Subtitle style', scope: 'write', readTwin: 'subtitle.read',
    description: 'Set caption size, text colour, background opacity and vertical position; the settings persist on this device.',
    input: { type: 'object', properties: {
      size: { type: 'number', minimum: STYLE_LIMITS.size[0], maximum: STYLE_LIMITS.size[1], description: 'Scale; 1 is the default' },
      color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Text colour as #rrggbb' },
      backgroundOpacity: { type: 'number', minimum: 0, maximum: 1 },
      position: { type: 'number', minimum: STYLE_LIMITS.position[0], maximum: STYLE_LIMITS.position[1], description: 'Distance from the bottom of the picture, in percent' },
      reset: { type: 'boolean', description: 'Restore the default style first' } }, required: [] },
  },
  { name: 'subtitle.load-file', label: 'Load subtitles…', scope: 'write', readTwin: 'subtitle.read',
    description: 'Load an SRT, WebVTT, ASS, SSA or PGS (.sup) subtitle file for the current video. With no input it asks the person to pick a file; agents pass name and text (text formats only).',
    input: { type: 'object', properties: {
      name: { type: 'string', description: 'File name, used for the format and the track label' },
      text: { type: 'string', description: 'The subtitle file contents' },
      replaceId: { type: 'string', description: 'Id of a loaded subtitle file track to replace in place (same id, still selected); an unknown id adds a new track' } }, required: [] } },
  { name: 'subtitle.secondary', label: 'Second subtitle track', scope: 'write', readTwin: 'subtitle.read',
    description: 'Show a second text subtitle track at the top of the picture, by list index (-1 turns it off) or id, or step to the next one, Off included.',
    input: { type: 'object', properties: {
      index: { type: 'integer', minimum: -1, description: 'Position in subtitle.read tracks; -1 is Off' },
      id: { type: 'string', description: 'Track id from subtitle.read' },
      next: { type: 'boolean', description: 'Step to the next text track, wrapping through Off' } }, required: [] },
    shortcuts: [{ key: 'alt+s', input: { next: true } }] },
  { name: 'subtitle.renderer', label: 'ASS renderer', scope: 'write', readTwin: 'subtitle.read',
    description: 'Read or set how ASS/SSA subtitles draw: styled (fonts, colours and positions through libass) or plain text. With no input it reports the mode and the renderer in use.',
    input: { type: 'object', properties: {
      mode: { type: 'string', enum: ['styled', 'plain'] } }, required: [] } },
  { name: 'subtitle.read', label: 'Subtitle state', scope: 'read', input: { type: 'object', properties: {}, required: [] },
    description: 'Read the subtitle tracks, the selected track, the delay, the caption style and the text on screen.' },
  { name: 'subtitle.save', label: 'Save subtitles', scope: 'write', readTwin: 'subtitle.read',
    description: 'Save the selected subtitle track as an SRT or WebVTT file, with the current delay applied. download false returns the text instead.',
    input: { type: 'object', properties: {
      format: { type: 'string', enum: ['srt', 'vtt'] },
      download: { type: 'boolean', description: 'Defaults to true' } }, required: [] } },
];

export const STRINGS = {
  'subtitles.button': 'Subtitles',
  'subtitles.button.text': 'CC',
  'subtitles.panel.title': 'Subtitles',
  'subtitles.menu.tracks': 'Track',
  'subtitles.menu.off': 'Off',
  'subtitles.menu.none': 'This video has no subtitle tracks. Load a file or drop one on the player.',
  'subtitles.menu.delay': 'Delay',
  'subtitles.menu.delayValue': '{value} s',
  'subtitles.menu.delayLater': 'Show subtitles 50 ms later (H)',
  'subtitles.menu.delayEarlier': 'Show subtitles 50 ms earlier (G)',
  'subtitles.menu.earlierShort': '−50 ms',
  'subtitles.menu.laterShort': '+50 ms',
  'subtitles.menu.delayReset': 'Reset delay',
  'subtitles.menu.style': 'Style',
  'subtitles.menu.size': 'Size',
  'subtitles.menu.color': 'Text colour',
  'subtitles.menu.background': 'Background opacity',
  'subtitles.menu.position': 'Height above the bottom',
  'subtitles.menu.styleReset': 'Reset style',
  'subtitles.menu.load': 'Load subtitles…',
  'subtitles.menu.saveSrt': 'Save as SRT',
  'subtitles.menu.saveVtt': 'Save as VTT',
  'subtitles.color.white': 'White',
  'subtitles.color.yellow': 'Yellow',
  'subtitles.color.cyan': 'Cyan',
  'subtitles.color.green': 'Green',
  'subtitles.track.embedded': 'Track {n}',
  'subtitles.track.forced': 'forced',
  'subtitles.track.file': 'file',
  'subtitles.live.label': 'Captions',
  'subtitles.toast.track': 'Subtitles: {label}',
  'subtitles.toast.off': 'Subtitles off',
  'subtitles.toast.delay': 'Subtitle delay {value} ms',
  'subtitles.toast.loaded': 'Loaded subtitles: {name}',
  'subtitles.toast.matched': 'Found subtitles beside the video: {name}',
  'subtitles.toast.saved': 'Saved {name}',
  'subtitles.error.noMedia': 'Open a video before loading subtitles.',
  'subtitles.error.noTrack': 'Choose a subtitle track first.',
  'subtitles.error.unknownTrack': 'There is no subtitle track with that index or id.',
  'subtitles.error.empty': 'No subtitles were found in {name}.',
  'subtitles.error.tooLarge': '{name} is larger than 20 MB, so Reel does not read it as subtitles.',
  'subtitles.error.notSubtitle': '{name} is not an SRT, WebVTT, ASS, SSA or PGS (.sup) file.',
  'subtitles.error.replace': 'replaceId must name a loaded text subtitle file, not an embedded or bitmap track.',
  'subtitles.error.bitmapSave': 'A bitmap (PGS) track has no text to save.',
  'subtitles.error.bitmapSecondary': 'Only text tracks can show as the second track.',
  'subtitles.error.bitmapText': 'Send PGS files as a file, not as text.',
  'subtitles.error.styled': 'Styled subtitles could not start, so Reel shows them as plain text',
  'subtitles.error.bitmap': 'Bitmap subtitles could not be shown',
  'subtitles.menu.secondary': 'Second track (top)',
  'subtitles.menu.styled': 'Styled ASS (fonts, colours, positions)',
  'subtitles.track.bitmap': 'image',
  'subtitles.toast.secondary': 'Second subtitles: {label}',
  'subtitles.toast.secondaryOff': 'Second subtitles off',
  'subtitles.error.load': 'Subtitles could not be read',
  'subtitles.error.styledStopped': 'Styled subtitles stopped, so Reel shows them as plain text',
  'subtitles.error.bitmapStopped': 'Bitmap subtitles stopped',
  'subtitles.toast.fontsDropped': 'Some fonts in this file were not loaded, so some lines use the fallback font',
  'subtitles.toast.fontsDroppedDetail': '{count} skipped; Reel loads at most {files} fonts and {mb} MB of fonts.',
  'subtitles.toast.fontsUnread': 'The fonts in this file could not be read, so subtitles use the fallback font',
  'subtitles.toast.truncated': 'Reel loaded the first {count} subtitles of {name}; the rest are not shown.',
};

export function install(ctx) {
  const t = ctx.t;
  const S = {
    gen: 0,
    name: null,
    tracks: [],
    selectedId: null,
    delayS: 0,
    style: { ...DEFAULT_STYLE },
    userChose: false,
    pendingSiblings: null,
    seenSidecars: new Set(),
    sidecarCount: 0,
    secondaryId: null,
    rendererMode: 'styled',
    active: null,
  };
  const captions = createCaptions(ctx);
  captions.setStyle(S.style);
  const styled = createStyledRenderer({
    layer: captions.layer,
    onLayout: fn => captions.onLayout(fn),
    onFailure: message => rendererStopped('styled', message),
  });
  const bitmap = createBitmapRenderer({ layer: captions.layer, onLayout: fn => captions.onLayout(fn), onFailure: message => rendererStopped('bitmap', message) });

  /* A canvas renderer failed after it started (a worker error or a watchdog): show plain text
   * again where there is any, and tell the person. */
  function rendererStopped(kind, message) {
    if (S.active !== kind) return;
    S.active = null;
    captions.setPrimaryHidden(false);
    ctx.toast(t(kind === 'styled' ? 'subtitles.error.styledStopped' : 'subtitles.error.bitmapStopped'), 'err', message);
    publish();
  }

  Promise.resolve(ctx.Storage?.get?.(RENDERER_KEY)).then(saved => {
    if (saved === 'plain' || saved === 'styled') { S.rendererMode = saved; publish(); }
  }).catch(() => {});

  Promise.resolve(ctx.Storage?.get?.(STYLE_KEY)).then(saved => {
    if (saved && typeof saved === 'object') {
      S.style = normaliseStyle(saved);
      captions.setStyle(S.style);
      syncStyleControls();
      publish();
    }
  }).catch(() => {});

  /* ---------- track model ---------- */

  function embeddedTracks(metadata) {
    const fromStore = ctx.store.tracks?.subtitle;
    const list = Array.isArray(fromStore) && fromStore.length
      ? fromStore
      : (metadata?.tracks || []).filter(track => track.type === 'subtitle');
    return list.map((track, index) => ({
      id: `embedded:${index}`,
      kind: 'embedded',
      embeddedIndex: index,
      label: embeddedLabel(track, index),
      language: track.language && track.language !== 'und' ? track.language : null,
      codec: String(track.codec || 'srt').toLowerCase(),
      bitmap: isBitmapCodec(track.codec) || isBitmapCodec(track.codecParameter),
      header: typeof track.initialization === 'string'
        ? track.initialization
        : track.initialization ? decodeSubtitleBytes(track.initialization).text : '',
      forced: !!track.disposition?.forced,
      isDefault: !!track.disposition?.default,
      index: null,
      loading: null,
    }));
  }

  function embeddedLabel(track, index) {
    const parts = [track.name || t('subtitles.track.embedded', { n: index + 1 })];
    if (track.language && track.language !== 'und' && track.language !== track.name) parts.push(track.language);
    if (track.disposition?.forced) parts.push(t('subtitles.track.forced'));
    if (isBitmapCodec(track.codec) || isBitmapCodec(track.codecParameter)) parts.push(t('subtitles.track.bitmap'));
    return parts.length > 1 ? `${parts[0]} (${parts.slice(1).join(', ')})` : parts[0];
  }

  function selected() { return S.tracks.find(track => track.id === S.selectedId) || null; }

  async function ensureCues(track) {
    if (track.index) return track.index;
    if (!track.loading) {
      track.loading = (async () => {
        const engineSubs = ctx.Engine.subtitles || {};
        let cues;
        if (typeof engineSubs.cues === 'function') {
          track.rawCues = await engineSubs.cues(track.embeddedIndex);
          cues = cuesFromEngine(track.rawCues, track.codec);
        } else {
          // Older engine: the export path returns the whole track as SRT or VTT text.
          const format = track.codec === 'webvtt' ? 'vtt' : 'srt';
          const exported = await engineSubs.export({ trackIndex: track.embeddedIndex, format });
          cues = parseSubtitles(exported.text, format);
        }
        track.index = new CueIndex(cues);
        return track.index;
      })();
      track.loading.catch(() => { track.loading = null; });
    }
    return track.loading;
  }

  async function select(id, { announce = true, byUser = true } = {}) {
    const gen = S.gen;
    if (byUser) S.userChose = true;
    if (id === null) {
      S.selectedId = null;
      stopRenderers();
      captions.setIndex(null);
      if (ctx.store.tracks?.selected) ctx.store.tracks.selected.subtitle = -1;
      if (announce) ctx.toast(t('subtitles.toast.off'));
      publish();
      return;
    }
    const track = S.tracks.find(candidate => candidate.id === id);
    if (!track) throw new RangeError(t('subtitles.error.unknownTrack'));
    S.selectedId = id;
    stopRenderers();
    publish();
    if (track.bitmap) {
      captions.setIndex(null);
      if (ctx.store.tracks?.selected) ctx.store.tracks.selected.subtitle = track.kind === 'embedded' ? track.embeddedIndex : -1;
      if (announce) ctx.toast(t('subtitles.toast.track', { label: track.label }));
      await startBitmap(track, gen);
      return;
    }
    const index = await ensureCues(track);
    if (gen !== S.gen || S.selectedId !== id) return;
    captions.setIndex(index);
    if (ctx.store.tracks?.selected) ctx.store.tracks.selected.subtitle = track.kind === 'embedded' ? track.embeddedIndex : -1;
    if (announce) ctx.toast(t('subtitles.toast.track', { label: track.label }));
    publish();
    if (isAss(track) && S.rendererMode === 'styled') startStyled(track, gen);
  }

  /* ---------- canvas renderers: styled ASS (T9) and PGS bitmaps (T11) ---------- */

  function isAss(track) { return track && (track.codec === 'ass' || track.codec === 'ssa'); }

  function stopRenderers() {
    styled.reset();
    bitmap.reset();
    S.active = null;
    captions.setPrimaryHidden(false);
  }

  /* The file's attached fonts, capped (review finding V17). The person hears about fonts that
   * were left out, because libass then draws those lines in the fallback font. The returned
   * arrays are views of the engine's bytes; this module keeps no copy after the start. */
  async function attachedFonts() {
    if (typeof ctx.Engine.attachments !== 'function') return [];
    let list;
    try {
      list = await ctx.Engine.attachments();
    } catch (error) {
      ctx.toast(t('subtitles.toast.fontsUnread'), 'info', error?.message || String(error));
      return [];
    }
    const { fonts, dropped } = pickFonts(list);
    const engineDropped = Number(list?.dropped) || 0;
    if (dropped + engineDropped > 0) {
      ctx.toast(t('subtitles.toast.fontsDropped'), 'info', t('subtitles.toast.fontsDroppedDetail', {
        count: dropped + engineDropped, files: FONT_LIMITS.files, mb: FONT_LIMITS.bytes / (1024 * 1024),
      }));
    }
    return fonts;
  }

  async function startStyled(track, gen) {
    try {
      const content = track.rawText ?? buildAssDocument(track.header, track.rawCues || []);
      const fonts = track.kind === 'embedded' ? await attachedFonts() : [];
      if (gen !== S.gen || S.selectedId !== track.id) return;
      S.active = 'styled';
      publish();
      const started = await styled.start({ content, fonts });
      if (gen !== S.gen || S.selectedId !== track.id) return;
      // A superseded start (track A, B, then A again) returns early while the newest start is
      // still loading; plain text stays until the renderer reports ready (V49).
      if (started === 'ready' && styled.status() === 'ready') captions.setPrimaryHidden(true);
      publish();
    } catch (error) {
      if (gen !== S.gen || S.selectedId !== track.id) return;
      S.active = null;
      captions.setPrimaryHidden(false);
      ctx.toast(t('subtitles.error.styled'), 'err', error?.message || String(error));
      publish();
    }
  }

  async function bitmapBytes(track) {
    if (track.bytes) return track.bytes;
    const engineSubs = ctx.Engine.subtitles || {};
    if (typeof engineSubs.packets !== 'function') throw new Error('This engine does not expose bitmap subtitle packets.');
    track.bytes = pgsPacketsToSup(await engineSubs.packets(track.embeddedIndex));
    return track.bytes;
  }

  async function startBitmap(track, gen) {
    try {
      const bytes = await bitmapBytes(track);
      if (gen !== S.gen || S.selectedId !== track.id) return;
      S.active = 'bitmap';
      publish();
      await bitmap.start(bytes);
      publish();
    } catch (error) {
      if (gen !== S.gen || S.selectedId !== track.id) return;
      S.active = null;
      ctx.toast(t('subtitles.error.bitmap'), 'err', error?.message || String(error));
      publish();
      throw error;
    }
  }

  /* ---------- second track (T10) ---------- */

  async function selectSecondary(id, { announce = true } = {}) {
    const gen = S.gen;
    if (id === null) {
      S.secondaryId = null;
      captions.setSecondary(null);
      if (announce) ctx.toast(t('subtitles.toast.secondaryOff'));
      publish();
      return;
    }
    const track = S.tracks.find(candidate => candidate.id === id);
    if (!track) throw new RangeError(t('subtitles.error.unknownTrack'));
    if (track.bitmap) throw new TypeError(t('subtitles.error.bitmapSecondary'));
    S.secondaryId = id;
    publish();
    const index = await ensureCues(track);
    if (gen !== S.gen || S.secondaryId !== id) return;
    captions.setSecondary(index);
    if (announce) ctx.toast(t('subtitles.toast.secondary', { label: track.label }));
    publish();
  }

  function autoSelect(id) {
    select(id, { announce: false, byUser: false })
      .catch(error => ctx.toast(t('subtitles.error.load'), 'err', error?.message || String(error)));
  }

  /* ---------- sidecar files ---------- */

  async function addSidecar(file, { origin = 'user' } = {}) {
    if (!S.name) throw new Error(t('subtitles.error.noMedia'));
    const blob = file && typeof file.getFile === 'function' ? await file.getFile() : file;
    const name = blob?.name || 'subtitles.srt';
    if (!isSubtitleName(name)) throw new TypeError(t('subtitles.error.notSubtitle', { name }));
    if (blob.size > MAX_SIDECAR_BYTES) throw new RangeError(t('subtitles.error.tooLarge', { name }));
    const key = `${name}\0${blob.size}\0${blob.lastModified || 0}`;
    const existing = S.tracks.find(track => track.key === key);
    if (existing) return existing;
    if (/\.sup$/i.test(name)) return addSidecarBitmap(name, new Uint8Array(await blob.arrayBuffer()), { key, origin });
    const { text, encoding } = decodeSubtitleBytes(await blob.arrayBuffer());
    return addSidecarText(name, text, { key, encoding, origin });
  }

  function addSidecarText(name, text, { key = `${name}\0text\0${text.length}`, encoding = 'utf-8', origin = 'user', replace = null } = {}) {
    if (!S.name) throw new Error(t('subtitles.error.noMedia'));
    // Every load path passes here, so the 20 MB cap holds for agent text too (V16).
    if (utf8ByteLength(text, MAX_SIDECAR_BYTES) > MAX_SIDECAR_BYTES) throw new RangeError(t('subtitles.error.tooLarge', { name }));
    const format = detectFormat(text, name);
    const cues = parseSubtitles(text, format);
    if (!cues.length) throw new Error(t('subtitles.error.empty', { name }));
    if (cues.truncated) ctx.toast(t('subtitles.toast.truncated', { count: MAX_CUES.toLocaleString(), name }), 'info');
    const info = describeSidecar(S.name, name);
    if (!replace) S.sidecarCount += 1;
    const track = {
      id: replace ? replace.id : `file:${S.sidecarCount}`,
      key,
      kind: 'sidecar',
      label: `${name} (${t('subtitles.track.file')})`,
      fileName: name,
      language: info?.language || null,
      codec: format,
      encoding,
      origin,
      forced: !!info?.forced,
      isDefault: false,
      bitmap: false,
      rawText: format === 'ass' ? text : null,
      index: new CueIndex(cues),
      loading: null,
    };
    if (replace) S.tracks[S.tracks.indexOf(replace)] = track;
    else S.tracks.push(track);
    publish();
    return track;
  }

  /* The loaded file track that replaceId names, or null when the id is unknown (for example a
   * track from a previous video), so the caller adds a new track instead. */
  function replaceTarget(replaceId) {
    if (typeof replaceId !== 'string') return null;
    const target = S.tracks.find(track => track.id === replaceId);
    if (!target) return null;
    if (target.kind !== 'sidecar' || target.bitmap) throw new TypeError(t('subtitles.error.replace'));
    return target;
  }

  function addSidecarBitmap(name, bytes, { key, origin }) {
    if (bytes.length < 13 || bytes[0] !== 0x50 || bytes[1] !== 0x47) throw new Error(t('subtitles.error.empty', { name }));
    const info = describeSidecar(S.name, name);
    S.sidecarCount += 1;
    const track = {
      id: `file:${S.sidecarCount}`,
      key,
      kind: 'sidecar',
      label: `${name} (${t('subtitles.track.file')}, ${t('subtitles.track.bitmap')})`,
      fileName: name,
      language: info?.language || null,
      codec: 'pgs',
      encoding: null,
      origin,
      forced: !!info?.forced,
      isDefault: false,
      bitmap: true,
      bytes,
      index: null,
      loading: null,
    };
    S.tracks.push(track);
    publish();
    return track;
  }

  async function loadUserFiles(files) {
    let last = null;
    for (const file of files) {
      try {
        last = await addSidecar(file);
      } catch (error) {
        ctx.toast(t('subtitles.error.load'), 'err', error?.message || String(error));
      }
    }
    if (last) {
      await select(last.id, { announce: false });
      ctx.toast(t('subtitles.toast.loaded', { name: last.fileName }));
    }
    return last;
  }

  function siblingsFrom(value) {
    if (!value) return null;
    if (Array.isArray(value)) return { videoName: S.name, files: value };
    if (Array.isArray(value.files)) return { videoName: value.videoName || S.name, files: value.files };
    return null;
  }

  async function applySiblings(detail, { live = false } = {}) {
    const siblings = siblingsFrom(detail);
    if (!siblings) return;
    if (!S.name || siblings.videoName !== S.name) { S.pendingSiblings = siblings; return; }
    S.pendingSiblings = null;
    const gen = S.gen;
    // Subtitle files handed over while their video already plays (a NakliOS "Send to" with
    // subtitles only) are an explicit choice, so they load whatever their names are.
    const explicit = live && siblings.files.length > 0 && siblings.files.every(file => isSubtitleName(file?.name));
    if (explicit) {
      for (const file of siblings.files) S.seenSidecars.add(`${file.name}\0${file.size ?? ''}`);
      await loadUserFiles(siblings.files);
      return;
    }
    const languages = globalThis.navigator?.languages || [];
    const matches = matchSidecars(S.name, siblings.files, [...languages]);
    const added = [];
    for (const { file } of matches) {
      const seenKey = `${file.name}\0${file.size ?? ''}`;
      if (S.seenSidecars.has(seenKey)) continue;
      S.seenSidecars.add(seenKey);
      try {
        const track = await addSidecar(file, { origin: 'folder' });
        if (gen !== S.gen) return;
        added.push(track);
      } catch (error) {
        if (gen === S.gen) ctx.toast(t('subtitles.error.load'), 'err', error?.message || String(error));
      }
    }
    if (added.length && !S.userChose && gen === S.gen) {
      autoSelect(added[0].id);
      ctx.toast(t('subtitles.toast.matched', { name: added[0].fileName }));
    }
  }

  /* ---------- file lifecycle ---------- */

  function reset() {
    S.gen += 1;
    S.name = null;
    S.tracks = [];
    S.selectedId = null;
    S.delayS = 0;
    S.userChose = false;
    S.seenSidecars = new Set();
    S.sidecarCount = 0;
    S.secondaryId = null;
    stopRenderers();
    captions.clear();
    captions.setDelay(0);
  }

  ctx.on('ui:media-loaded', ({ name, metadata } = {}) => {
    reset();
    S.name = name || ctx.store.media?.name || null;
    S.tracks = embeddedTracks(metadata);
    const preferred = S.tracks.find(track => track.forced) || S.tracks.find(track => track.isDefault);
    if (preferred) autoSelect(preferred.id);
    publish();
    const pending = S.pendingSiblings;
    S.pendingSiblings = null;
    const fromStore = siblingsFrom(ctx.store.ui?.queue?.siblings);
    const source = pending && pending.videoName === S.name ? pending : fromStore;
    if (source) applySiblings(source).catch(() => {});
  });

  ctx.on('ui:media-cleared', () => { reset(); S.pendingSiblings = null; publish(); });
  ctx.on('queue:siblings', detail => { applySiblings(detail, { live: true }).catch(() => {}); });
  ctx.onFrame(state => {
    captions.frame(state);
    if (!S.active) return;
    const timeS = (Number(state?.clock?.positionS) || 0) - S.delayS;
    if (S.active === 'styled') styled.frame(timeS, { paused: !state?.clock?.playing, rate: state?.clock?.rate || 1 });
    else if (S.active === 'bitmap') bitmap.frame(timeS);
  });
  ctx.on('playback:seek', () => captions.refresh());

  /* ---------- reading state ---------- */

  function read() {
    const current = selected();
    return {
      tracks: S.tracks.map((track, index) => ({
        index,
        id: track.id,
        kind: track.kind,
        label: track.label,
        language: track.language,
        codec: track.codec,
        forced: track.forced,
        default: track.isDefault,
        bitmap: !!track.bitmap,
        ...(track.kind === 'embedded' ? { embeddedIndex: track.embeddedIndex } : { fileName: track.fileName, encoding: track.encoding }),
      })),
      selected: current ? S.tracks.indexOf(current) : -1,
      selectedId: S.selectedId,
      secondary: S.secondaryId ? S.tracks.findIndex(track => track.id === S.secondaryId) : -1,
      secondaryId: S.secondaryId,
      renderer: rendererState(),
      cueCount: current?.index ? current.index.length : null,
      delayS: S.delayS,
      style: { ...S.style },
      text: captions.text(),
    };
  }

  function rendererState() {
    const current = selected();
    const active = S.active === 'styled'
      ? (styled.status() === 'ready' ? 'styled' : 'plain')
      : S.active === 'bitmap' || current?.bitmap ? 'bitmap' : current ? 'plain' : null;
    return {
      mode: S.rendererMode,
      active,
      styledStatus: styled.status(),
      styledError: styled.error(),
      bitmapStatus: bitmap.status(),
      bitmapError: bitmap.error(),
      // Control-bar clearance in CSS pixels: the bar's inset on the stage, and how much of it covers the picture.
      // styledLiftPx and bitmapLiftPx: how far each canvas renderer moved its bottom lines, in canvas pixels.
      clearance: { ...captions.clearance(), styledLiftPx: styled.lift(), bitmapLiftPx: bitmap.lift() },
    };
  }

  function publish() {
    ctx.store.ui.subtitles = { selectedId: S.selectedId, delayS: S.delayS, trackCount: S.tracks.length };
    renderPanel();
  }

  /* ---------- commands ---------- */

  const r = ctx.registry;
  r.handle('subtitle.track', async ({ index, id, next } = {}) => {
    if (next) {
      const order = [null, ...S.tracks.map(track => track.id)];
      const at = order.indexOf(S.selectedId);
      await select(order[(at + 1) % order.length]);
    } else if (typeof id === 'string') {
      await select(id);
    } else if (Number.isInteger(index)) {
      if (index === -1) await select(null);
      else if (S.tracks[index]) await select(S.tracks[index].id);
      else throw new RangeError(t('subtitles.error.unknownTrack'));
    } else {
      throw new TypeError(t('subtitles.error.unknownTrack'));
    }
    return read();
  });

  r.handle('subtitle.delay', ({ delayS, deltaS } = {}) => {
    const target = Number.isFinite(delayS) ? delayS : S.delayS + (Number(deltaS) || 0);
    S.delayS = Math.round(Math.max(-DELAY_LIMIT_S, Math.min(DELAY_LIMIT_S, target)) * 1000) / 1000;
    captions.setDelay(S.delayS);
    const ms = Math.round(S.delayS * 1000);
    ctx.toast(t('subtitles.toast.delay', { value: ms > 0 ? `+${ms}` : String(ms) }));
    publish();
    return { delayS: S.delayS };
  });

  r.handle('subtitle.style', input => {
    S.style = normaliseStyle(input, input.reset ? DEFAULT_STYLE : S.style);
    captions.setStyle(S.style);
    syncStyleControls();
    ctx.Storage?.set?.(STYLE_KEY, { ...S.style })?.catch?.(() => {});
    publish();
    return { style: { ...S.style } };
  });

  r.handle('subtitle.load-file', async ({ name, text, file, replaceId } = {}) => {
    if (!S.name) throw new Error(t('subtitles.error.noMedia'));
    const replace = replaceTarget(replaceId);
    let track;
    if (file && typeof file.arrayBuffer === 'function' && replace) {
      const fileName = file.name || name || 'subtitles.srt';
      if (/\.sup$/i.test(fileName)) throw new TypeError(t('subtitles.error.replace'));
      if (file.size > MAX_SIDECAR_BYTES) throw new RangeError(t('subtitles.error.tooLarge', { name: fileName }));
      const { text: decoded, encoding } = decodeSubtitleBytes(await file.arrayBuffer());
      track = addSidecarText(fileName, decoded, { encoding, origin: replace.origin, replace });
    } else if (file && typeof file.arrayBuffer === 'function') {
      track = await addSidecar(file);
    } else if (typeof text === 'string') {
      const fileName = name || replace?.fileName || 'subtitles.srt';
      if (!isSubtitleName(fileName)) throw new TypeError(t('subtitles.error.notSubtitle', { name: fileName }));
      if (/\.sup$/i.test(fileName)) throw new TypeError(t('subtitles.error.bitmapText'));
      track = addSidecarText(fileName, text, { origin: replace ? replace.origin : 'agent', replace });
    } else {
      fileInput.click();
      return { picker: true, ...read() };
    }
    await select(track.id, { announce: false });
    if (replace && S.secondaryId === track.id) {
      // The replaced track is now the primary; showing it twice would duplicate every line.
      S.secondaryId = null;
      captions.setSecondary(null);
      publish();
    }
    ctx.toast(t('subtitles.toast.loaded', { name: track.fileName }));
    return { trackId: track.id, replaced: !!replace, ...read() };
  });

  r.handle('subtitle.read', () => read());

  r.handle('subtitle.secondary', async ({ index, id, next } = {}) => {
    if (next) {
      const order = [null, ...S.tracks.filter(track => !track.bitmap && track.id !== S.selectedId).map(track => track.id)];
      const at = order.indexOf(S.secondaryId);
      await selectSecondary(order[(at + 1) % order.length]);
    } else if (typeof id === 'string') {
      await selectSecondary(id);
    } else if (Number.isInteger(index)) {
      if (index === -1) await selectSecondary(null);
      else if (S.tracks[index]) await selectSecondary(S.tracks[index].id);
      else throw new RangeError(t('subtitles.error.unknownTrack'));
    } else {
      throw new TypeError(t('subtitles.error.unknownTrack'));
    }
    return read();
  });

  r.handle('subtitle.renderer', async ({ mode } = {}) => {
    if (mode === 'styled' || mode === 'plain') {
      const changed = mode !== S.rendererMode;
      S.rendererMode = mode;
      ctx.Storage?.set?.(RENDERER_KEY, mode)?.catch?.(() => {});
      const track = selected();
      if (changed && isAss(track)) {
        stopRenderers();
        if (mode === 'styled') await startStyled(track, S.gen);
      }
      publish();
    }
    return rendererState();
  });

  r.handle('subtitle.save', async ({ format, download = true } = {}) => {
    const track = selected();
    if (!track) throw new Error(t('subtitles.error.noTrack'));
    if (track.bitmap) throw new TypeError(t('subtitles.error.bitmapSave'));
    const index = await ensureCues(track);
    const outFormat = format || (track.codec === 'webvtt' || track.codec === 'vtt' ? 'vtt' : 'srt');
    const text = serialiseSubtitles(index.cues, outFormat, S.delayS);
    const stem = stripExtension(S.name || 'subtitles');
    const filename = `${stem}${track.language ? `.${track.language}` : ''}.${outFormat}`;
    const result = { filename, format: outFormat, cueCount: index.length, delayS: S.delayS };
    if (!download) return { ...result, text };
    const saved = await saveText(filename, text, outFormat);
    if (saved) ctx.toast(t('subtitles.toast.saved', { name: filename }));
    return { ...result, saved };
  });

  async function saveText(filename, text, format) {
    const type = format === 'vtt' ? 'text/vtt' : 'application/x-subrip';
    if (typeof globalThis.showSaveFilePicker === 'function') {
      try {
        const handle = await globalThis.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: format.toUpperCase(), accept: { [type]: [`.${format}`] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(new Blob([text], { type }));
        await writable.close();
        return true;
      } catch (error) {
        if (error?.name === 'AbortError') return false;
        // Cross-origin frames (the NakliOS mirror) refuse the picker; fall back to a download.
      }
    }
    const url = URL.createObjectURL(new Blob([text], { type }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  }

  /* ---------- controls, panel, drop ---------- */

  const run = (name, input) => Promise.resolve(ctx.registry.run(name, input))
    .catch(error => ctx.toast(t('subtitles.error.load'), 'err', error?.message || String(error)));

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = SUBTITLE_EXTENSIONS.join(',');
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.setAttribute('aria-hidden', 'true');
  fileInput.tabIndex = -1;
  fileInput.addEventListener('change', () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    if (files.length) loadUserFiles(files);
  });
  (ctx.mounts.dialogs || document.body).append(fileInput);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reel-subs-button';
  button.textContent = t('subtitles.button.text');
  button.setAttribute('aria-label', t('subtitles.button'));
  button.title = `${t('subtitles.button')} (S)`;
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'mount-panels');
  button.dataset.command = 'subtitle.track';
  button.addEventListener('click', () => ctx.panels.toggle('subtitles'));
  ctx.mounts.controlsRight.append(button);
  ctx.on('ui:panel', ({ id } = {}) => button.setAttribute('aria-expanded', String(id === 'subtitles')));

  ctx.addStyle(`
.reel-subs-panel{display:flex;flex-direction:column;gap:14px;font-size:13px}
.reel-subs-panel fieldset{border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:6px}
.reel-subs-panel legend{font-weight:600;margin-bottom:6px}
.reel-subs-panel label{display:flex;align-items:center;gap:8px}
.reel-subs-panel .reel-subs-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.reel-subs-panel input[type=range]{flex:1;min-width:0}
.reel-subs-panel button:focus-visible,.reel-subs-panel input:focus-visible,.reel-subs-panel select:focus-visible,.reel-subs-button:focus-visible{outline:2px solid var(--accent,#7aa2ff);outline-offset:2px}
.reel-subs-panel .reel-subs-note{color:var(--dim,#999)}
`);

  const body = ctx.panels.register('subtitles', t('subtitles.panel.title'));
  const panel = document.createElement('div');
  panel.className = 'reel-subs-panel';
  body.append(panel);

  const trackSet = fieldset(t('subtitles.menu.tracks'));
  const trackList = document.createElement('div');
  trackList.setAttribute('role', 'radiogroup');
  trackList.setAttribute('aria-label', t('subtitles.menu.tracks'));
  trackSet.append(trackList);

  const secondarySet = fieldset(t('subtitles.menu.secondary'));
  const secondaryList = document.createElement('div');
  secondaryList.setAttribute('role', 'radiogroup');
  secondaryList.setAttribute('aria-label', t('subtitles.menu.secondary'));
  secondarySet.append(secondaryList);

  const rendererLabel = document.createElement('label');
  const rendererToggle = document.createElement('input');
  rendererToggle.type = 'checkbox';
  rendererToggle.dataset.command = 'subtitle.renderer';
  rendererToggle.addEventListener('change', () => run('subtitle.renderer', { mode: rendererToggle.checked ? 'styled' : 'plain' }));
  rendererLabel.append(rendererToggle, document.createTextNode(t('subtitles.menu.styled')));

  const delaySet = fieldset(t('subtitles.menu.delay'));
  const delayRow = row();
  const earlier = actionButton(t('subtitles.menu.earlierShort'), t('subtitles.menu.delayEarlier'), 'subtitle.delay', () => run('subtitle.delay', { deltaS: -DELAY_STEP_S }));
  const delayValue = document.createElement('output');
  delayValue.setAttribute('aria-live', 'polite');
  const later = actionButton(t('subtitles.menu.laterShort'), t('subtitles.menu.delayLater'), 'subtitle.delay', () => run('subtitle.delay', { deltaS: DELAY_STEP_S }));
  const delayReset = actionButton(t('subtitles.menu.delayReset'), null, 'subtitle.delay', () => run('subtitle.delay', { delayS: 0 }));
  delayRow.append(earlier, delayValue, later, delayReset);
  delaySet.append(delayRow);

  const styleSet = fieldset(t('subtitles.menu.style'));
  const size = range(t('subtitles.menu.size'), STYLE_LIMITS.size, 0.1, value => run('subtitle.style', { size: value }));
  const background = range(t('subtitles.menu.background'), STYLE_LIMITS.backgroundOpacity, 0.1, value => run('subtitle.style', { backgroundOpacity: value }));
  const position = range(t('subtitles.menu.position'), STYLE_LIMITS.position, 1, value => run('subtitle.style', { position: value }));
  const colourLabel = document.createElement('label');
  colourLabel.append(document.createTextNode(t('subtitles.menu.color')));
  const colour = document.createElement('select');
  colour.dataset.command = 'subtitle.style';
  for (const [value, key] of COLOURS) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = t(`subtitles.color.${key}`);
    colour.append(option);
  }
  colour.addEventListener('change', () => run('subtitle.style', { color: colour.value }));
  colourLabel.append(colour);
  const styleReset = actionButton(t('subtitles.menu.styleReset'), null, 'subtitle.style', () => run('subtitle.style', { reset: true }));
  styleSet.append(size.label, colourLabel, background.label, position.label, rendererLabel, styleReset);

  const fileRow = row();
  const load = actionButton(t('subtitles.menu.load'), null, 'subtitle.load-file', () => run('subtitle.load-file', {}));
  const saveSrt = actionButton(t('subtitles.menu.saveSrt'), null, 'subtitle.save', () => run('subtitle.save', { format: 'srt' }));
  const saveVtt = actionButton(t('subtitles.menu.saveVtt'), null, 'subtitle.save', () => run('subtitle.save', { format: 'vtt' }));
  fileRow.append(load, saveSrt, saveVtt);

  panel.append(trackSet, secondarySet, delaySet, styleSet, fileRow);

  function fieldset(title) {
    const set = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = title;
    set.append(legend);
    return set;
  }
  function row() {
    const div = document.createElement('div');
    div.className = 'reel-subs-row';
    return div;
  }
  function actionButton(text, label, command, onClick) {
    const el = document.createElement('button');
    el.dataset.command = command;
    el.type = 'button';
    el.textContent = text;
    if (label) el.setAttribute('aria-label', label);
    el.addEventListener('click', onClick);
    return el;
  }
  function range(text, [min, max], step, onInput) {
    const label = document.createElement('label');
    label.append(document.createTextNode(text));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.command = 'subtitle.style';
    input.addEventListener('input', () => onInput(Number(input.value)));
    label.append(input);
    return { label, input };
  }

  function syncStyleControls() {
    size.input.value = String(S.style.size);
    background.input.value = String(S.style.backgroundOpacity);
    position.input.value = String(S.style.position);
    colour.value = S.style.color;
    if (colour.value !== S.style.color) {
      const option = document.createElement('option');
      option.value = S.style.color;
      option.textContent = S.style.color;
      colour.append(option);
      colour.value = S.style.color;
    }
  }

  function radios(list, name, command, options, currentId) {
    const focusedId = list.contains(document.activeElement) ? document.activeElement.value : null;
    list.replaceChildren(...options.map(option => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.dataset.command = command;
      input.value = option.id ?? '';
      input.checked = option.id === currentId;
      input.addEventListener('change', () => {
        if (input.checked) run(command, option.id === null ? { index: -1 } : { id: option.id });
      });
      label.append(input, document.createTextNode(option.label));
      return label;
    }));
    if (focusedId !== null) list.querySelector(`input[value="${CSS.escape(focusedId)}"]`)?.focus();
  }

  function renderPanel() {
    const off = { id: null, label: t('subtitles.menu.off') };
    radios(trackList, 'reel-subs-track', 'subtitle.track', [off, ...S.tracks], S.selectedId);
    const textTracks = S.tracks.filter(track => !track.bitmap);
    radios(secondaryList, 'reel-subs-secondary', 'subtitle.secondary', [off, ...textTracks], S.secondaryId);
    secondarySet.hidden = textTracks.length < 2 && !S.secondaryId;
    rendererToggle.checked = S.rendererMode === 'styled';
    if (!S.tracks.length) {
      const note = document.createElement('p');
      note.className = 'reel-subs-note';
      note.textContent = t('subtitles.menu.none');
      trackList.append(note);
    }
    const ms = Math.round(S.delayS * 1000);
    delayValue.textContent = t('subtitles.menu.delayValue', { value: (S.delayS > 0 ? '+' : '') + S.delayS.toFixed(2) });
    delayValue.dataset.ms = String(ms);
    const hasTrack = !!S.selectedId;
    const textTrack = hasTrack && !selected()?.bitmap;
    saveSrt.disabled = !textTrack;
    saveVtt.disabled = !textTrack;
    load.disabled = !S.name;
  }

  syncStyleControls();
  renderPanel();

  // Drop a subtitle file anywhere on the player screen. Only drags that carry files are
  // accepted, and only subtitle files are consumed, so the start-screen drop zone is untouched.
  const playerScreen = ctx.$('#player');
  if (playerScreen) {
    playerScreen.addEventListener('dragover', event => {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    });
    playerScreen.addEventListener('drop', event => {
      const files = [...(event.dataTransfer?.files || [])].filter(file => isSubtitleName(file.name));
      if (!files.length) return;
      event.preventDefault();
      event.stopPropagation();
      if (!S.name) { ctx.toast(t('subtitles.error.noMedia'), 'err'); return; }
      loadUserFiles(files);
    });
  }

  publish();
}
