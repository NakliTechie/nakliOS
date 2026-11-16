/* Reel feature module: subtitles (parity rows T3 to T7, plus a save control for T2).
 * Contract: docs/build/reel-v1-contract.md.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json. */

import { decodeSubtitleBytes } from './decode.mjs';
import { parseSubtitles, detectFormat, cuesFromEngine, serialiseSubtitles } from './parse.mjs';
import { CueIndex } from './cues.mjs';
import { matchSidecars, isSubtitleName, stripExtension, describeSidecar, SUBTITLE_EXTENSIONS } from './match.mjs';
import { createCaptions, normaliseStyle, DEFAULT_STYLE, STYLE_LIMITS } from './captions.mjs';

const STYLE_KEY = 'subtitles:style';
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
  { name: 'subtitle.delay', label: 'Subtitle delay', scope: 'write', readTwin: 'subtitle.read',
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
  { name: 'subtitle.loadFile', label: 'Load subtitles…', scope: 'write', readTwin: 'subtitle.read',
    description: 'Load an SRT, WebVTT, ASS or SSA subtitle file for the current video. With no input it asks the person to pick a file; agents pass name and text.',
    input: { type: 'object', properties: {
      name: { type: 'string', description: 'File name, used for the format and the track label' },
      text: { type: 'string', description: 'The subtitle file contents' } }, required: [] } },
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
  'subtitles.error.notSubtitle': '{name} is not an SRT, WebVTT, ASS or SSA file.',
  'subtitles.error.load': 'Subtitles could not be read',
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
  };
  const captions = createCaptions(ctx);
  captions.setStyle(S.style);

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
          cues = cuesFromEngine(await engineSubs.cues(track.embeddedIndex), track.codec);
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
      captions.setIndex(null);
      if (ctx.store.tracks?.selected) ctx.store.tracks.selected.subtitle = -1;
      if (announce) ctx.toast(t('subtitles.toast.off'));
      publish();
      return;
    }
    const track = S.tracks.find(candidate => candidate.id === id);
    if (!track) throw new RangeError(t('subtitles.error.unknownTrack'));
    S.selectedId = id;
    publish();
    const index = await ensureCues(track);
    if (gen !== S.gen || S.selectedId !== id) return;
    captions.setIndex(index);
    if (ctx.store.tracks?.selected) ctx.store.tracks.selected.subtitle = track.kind === 'embedded' ? track.embeddedIndex : -1;
    if (announce) ctx.toast(t('subtitles.toast.track', { label: track.label }));
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
    const { text, encoding } = decodeSubtitleBytes(await blob.arrayBuffer());
    return addSidecarText(name, text, { key, encoding, origin });
  }

  function addSidecarText(name, text, { key = `${name}\0text\0${text.length}`, encoding = 'utf-8', origin = 'user' } = {}) {
    if (!S.name) throw new Error(t('subtitles.error.noMedia'));
    const format = detectFormat(text, name);
    const cues = parseSubtitles(text, format);
    if (!cues.length) throw new Error(t('subtitles.error.empty', { name }));
    const info = describeSidecar(S.name, name);
    S.sidecarCount += 1;
    const track = {
      id: `file:${S.sidecarCount}`,
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
      index: new CueIndex(cues),
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
  ctx.onFrame(state => captions.frame(state));
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
        ...(track.kind === 'embedded' ? { embeddedIndex: track.embeddedIndex } : { fileName: track.fileName, encoding: track.encoding }),
      })),
      selected: current ? S.tracks.indexOf(current) : -1,
      selectedId: S.selectedId,
      cueCount: current?.index ? current.index.length : null,
      delayS: S.delayS,
      style: { ...S.style },
      text: captions.text(),
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

  r.handle('subtitle.loadFile', async ({ name, text, file } = {}) => {
    if (!S.name) throw new Error(t('subtitles.error.noMedia'));
    let track;
    if (file && typeof file.arrayBuffer === 'function') {
      track = await addSidecar(file);
    } else if (typeof text === 'string') {
      const fileName = name || 'subtitles.srt';
      if (!isSubtitleName(fileName)) throw new TypeError(t('subtitles.error.notSubtitle', { name: fileName }));
      track = addSidecarText(fileName, text, { origin: 'agent' });
    } else {
      fileInput.click();
      return { picker: true, ...read() };
    }
    await select(track.id, { announce: false });
    ctx.toast(t('subtitles.toast.loaded', { name: track.fileName }));
    return read();
  });

  r.handle('subtitle.read', () => read());

  r.handle('subtitle.save', async ({ format, download = true } = {}) => {
    const track = selected();
    if (!track) throw new Error(t('subtitles.error.noTrack'));
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
  styleSet.append(size.label, colourLabel, background.label, position.label, styleReset);

  const fileRow = row();
  const load = actionButton(t('subtitles.menu.load'), null, 'subtitle.loadFile', () => run('subtitle.loadFile', {}));
  const saveSrt = actionButton(t('subtitles.menu.saveSrt'), null, 'subtitle.save', () => run('subtitle.save', { format: 'srt' }));
  const saveVtt = actionButton(t('subtitles.menu.saveVtt'), null, 'subtitle.save', () => run('subtitle.save', { format: 'vtt' }));
  fileRow.append(load, saveSrt, saveVtt);

  panel.append(trackSet, delaySet, styleSet, fileRow);

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

  function renderPanel() {
    const options = [{ id: null, label: t('subtitles.menu.off') }, ...S.tracks];
    const focusedId = trackList.contains(document.activeElement) ? document.activeElement.value : null;
    trackList.replaceChildren(...options.map(option => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'reel-subs-track';
      input.dataset.command = 'subtitle.track';
      input.value = option.id ?? '';
      input.checked = option.id === S.selectedId;
      input.addEventListener('change', () => {
        if (input.checked) run('subtitle.track', option.id === null ? { index: -1 } : { id: option.id });
      });
      label.append(input, document.createTextNode(option.label));
      return label;
    }));
    if (focusedId !== null) trackList.querySelector(`input[value="${CSS.escape(focusedId)}"]`)?.focus();
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
    saveSrt.disabled = !hasTrack;
    saveVtt.disabled = !hasTrack;
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
