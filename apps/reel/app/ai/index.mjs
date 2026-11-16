/* Reel feature module: ai (batch 2). Contract: docs/build/reel-v1-contract.md.
 * Rows: Q1 subtitles from speech (ai.transcribe), Q2 subtitle translation (ai.translate), ai.read.
 *
 * The AI is removable: with no model and no NakliOS host, every other feature works and ai.read says
 * "absent". Inside NakliOS the host's speech model is the default route for Q1 and the person's chosen
 * chat model is the only route for Q2. Outside NakliOS, Q1 runs Whisper tiny on this device after a
 * one-time download the person agrees to; Q2 has no local model.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json.
 * Pure logic lives in ./logic.mjs (tested in Node by test/ai.test.mjs). */

import {
  WINDOW_S, OVERLAP_S, SAMPLE_RATE, LANGUAGES, languageName, languageCode,
  planWindows, isSilent, assembleCues, formatSrt, parseSrt,
  mergeCuesIntoSentences, translationMessages, parseNumberedLines, applyTranslation, batches, stripExtension,
} from './logic.mjs';
import { SPEECH, speechStatus, downloadSpeech, transcribeLocal, stopSpeech, speechMB } from './speech.mjs';

const TRANSLATE_BATCH = 30;
const panelFlag = { type: 'boolean', description: 'true opens the AI panel, false closes it' };

export const COMMANDS = [
  { name: 'ai.transcribe', label: 'Generate subtitles', scope: 'write', readTwin: 'ai.read',
    description: 'Generate subtitles from the speech in the current video, in 30-second windows, and load them as an editable SRT track named "(generated)". Inside NakliOS the host speech model is the default; route "local" runs Whisper tiny on this device. The one-time local model download is a person-only act: from an agent it refuses unless the model is already kept. cancel stops a running job.',
    input: { type: 'object', properties: {
      route: { type: 'string', enum: ['auto', 'host', 'local'], description: 'Defaults to auto (host inside NakliOS, else local)' },
      language: { type: 'string', description: 'Spoken language code such as "en" or "hi"; omitted lets Whisper detect it' },
      fromS: { type: 'number', minimum: 0, description: 'Start of the range to transcribe; defaults to 0' },
      toS: { type: 'number', minimum: 0, description: 'End of the range; defaults to the end of the video' },
      cancel: { type: 'boolean', description: 'Cancel the running job' } }, required: [] } },
  { name: 'ai.translate', label: 'Translate subtitles', scope: 'write', readTwin: 'ai.read',
    description: 'Translate the selected subtitle track into a language with the NakliOS host model, keeping cue times, and load it as a new track named "(translated)". Outside NakliOS there is no translation model and it refuses. cancel stops a running job.',
    input: { type: 'object', properties: {
      language: { type: 'string', description: 'Target language code or name, such as "fr" or "French"' },
      trackIndex: { type: 'integer', minimum: 0, description: 'Subtitle track position from subtitle.read; defaults to the selected track' },
      cancel: { type: 'boolean', description: 'Cancel the running job' } }, required: [] } },
  { name: 'ai.read', label: 'AI state', scope: 'read',
    description: 'Read the local speech model state (absent, cached, loading, loaded), the route for transcription and translation (host, local or none), the running job and its progress, and the last generated track. panel opens or closes the AI panel.',
    input: { type: 'object', properties: { panel: panelFlag }, required: [] } },
];

export const STRINGS = {
  'ai.button': 'Generate or translate subtitles',
  'ai.button.text': 'AI',
  'ai.panel.title': 'Subtitles from speech',
  'ai.route.label': 'Speech model',
  'ai.route.auto': 'Automatic',
  'ai.route.host': 'NakliOS host model',
  'ai.route.local': 'Whisper tiny on this device',
  'ai.language.label': 'Spoken language',
  'ai.language.auto': 'Detect',
  'ai.state.host': 'Route: the NakliOS host speech model. Cue times are spread over each 30-second window, so check them before you save.',
  'ai.state.absent': 'Route: Whisper tiny on this device. The model is not downloaded.',
  'ai.state.cached': 'Route: Whisper tiny on this device. The model is kept in this browser.',
  'ai.state.loading': 'Route: Whisper tiny on this device. The model is loading.',
  'ai.state.loaded': 'Route: Whisper tiny on this device. The model is loaded.',
  'ai.state.unavailable': 'No speech model is available here: this page cannot keep a download.',
  'ai.consent': 'Reel downloads {name} and its runtime, about {mb} MB, once, from Sonella\'s folder on this site, checks each file against a pinned SHA-256, and keeps it in this browser for Sonella, Montella and Reel. Speech is transcribed on this device; no audio leaves the browser.',
  'ai.generate': 'Generate subtitles',
  'ai.generate.download': 'Download {mb} MB and generate',
  'ai.cancel': 'Cancel',
  'ai.progress.download': 'Downloading the speech model: {pct}%',
  'ai.progress.load': 'Loading the speech model',
  'ai.progress.window': 'Transcribing {done} of {total} windows',
  'ai.progress.translate': 'Translating {done} of {total} batches',
  'ai.progress.done': '{count} cues ready',
  'ai.progress.cancelled': 'Cancelled',
  'ai.editor.label': 'Generated subtitles (SRT, editable)',
  'ai.editor.apply': 'Apply edits',
  'ai.editor.save': 'Save SRT',
  'ai.editor.invalid': 'The SRT has {count} unreadable blocks; the first: {first}',
  'ai.translate.title': 'Translate subtitles',
  'ai.translate.target': 'Translate the selected track into',
  'ai.translate.run': 'Translate',
  'ai.translate.noLocal': 'Translation needs the NakliOS host model. Outside NakliOS this browser has no translation model, so Reel offers none.',
  'ai.translate.noAccess': 'NakliOS has not given Reel access to its AI model. Allow it in NakliOS, then try again.',
  'ai.toast.generated': 'Generated {count} subtitle cues',
  'ai.toast.translated': 'Translated {count} cues into {language}',
  'ai.error.noMedia': 'Open a video first.',
  'ai.error.busy': 'An AI job is already running. Cancel it first.',
  'ai.error.noPcm': 'This engine build cannot extract audio for transcription (Engine.audioPcm is missing).',
  'ai.error.consent': 'The speech model (Whisper tiny, about {mb} MB) is not downloaded. Downloading it is the person\'s choice: they choose Generate subtitles in the AI panel and agree to the download.',
  'ai.error.noHostSpeech': 'The NakliOS host speech model is not available to Reel here.',
  'ai.error.host': 'The NakliOS speech model refused: {message}. Turn on the assistant\'s model in NakliOS, or choose Whisper tiny on this device.',
  'ai.error.noTrack': 'Select a subtitle track to translate first.',
  'ai.error.noLanguage': 'Choose a language to translate into.',
  'ai.error.empty': 'No speech was found in this range.',
  'ai.error.noGenerated': 'Generate subtitles first.',
};

export function install(ctx) {
  const { t, registry: r } = ctx;
  const devHooks = { recogniser: null, pcm: null, host: undefined };
  let job = null;          // { kind, phase, done, total, route, error, controller }
  let generated = null;    // { name, trackId, cueCount, saved, text }
  let personAct = false;   // set only by this module's own buttons, read once by the handler
  let localState = 'absent';
  let noChat = true;       // no host chat model, so translation is off

  const running = () => job && !['done', 'cancelled', 'error'].includes(job.phase);
  const takePersonAct = () => { const value = personAct; personAct = false; return value; };
  const stem = () => stripExtension(ctx.store.media?.name || 'video');
  const fail = (message, code = 'REFUSED') => Object.assign(new Error(message), { code });

  async function hostBridge() {
    if (devHooks.host !== undefined) return devHooks.host;
    try { return await ctx.nakliosBridge(); } catch { return null; }
  }
  const hostCanTranscribe = host => typeof host?.ai?.experimental_transcribe === 'function';
  const hostCanChat = host => typeof host?.ai?.chat?.completions?.create === 'function';

  async function chooseRoute(requested = 'auto') {
    if (devHooks.recogniser) return 'stub';
    const host = await hostBridge();
    if (requested === 'host') { if (!hostCanTranscribe(host)) throw fail(t('ai.error.noHostSpeech')); return 'host'; }
    if (requested === 'local') return 'local';
    return hostCanTranscribe(host) ? 'host' : 'local';
  }

  async function read() {
    let model;
    try { model = await speechStatus(); } catch { model = { state: 'absent', available: false, bytes: 0 }; }
    localState = model.state;
    const host = await hostBridge();
    const transcribeRoute = devHooks.recogniser ? 'stub' : hostCanTranscribe(host) ? 'host' : model.available ? 'local' : 'none';
    return {
      model: { name: SPEECH.name, state: model.state, bytes: model.bytes, cache: SPEECH.cache, refusedRequests: model.refusedRequests ?? 0 },
      route: { transcribe: transcribeRoute, translate: hostCanChat(host) ? 'host' : 'none' },
      pcm: typeof ctx.Engine?.audioPcm === 'function' || Boolean(devHooks.pcm),
      job: job ? { kind: job.kind, phase: job.phase, done: job.done, total: job.total, fraction: job.total ? job.done / job.total : 0, route: job.route, error: job.error || null } : null,
      generated: generated ? { name: generated.name, trackId: generated.trackId, cueCount: generated.cueCount, saved: generated.saved } : null,
      panelOpen: ctx.panels.current() === 'ai',
    };
  }

  function setJob(patch) {
    job = { ...job, ...patch };
    ctx.store.ui.ai = { phase: job.phase, kind: job.kind, done: job.done, total: job.total };
    renderProgress();
  }

  function cancelJob() {
    if (!running()) return { cancelled: false };
    job.controller.abort();
    if (job.route === 'local') stopSpeech();
    setJob({ phase: 'cancelled' });
    return { cancelled: true };
  }

  async function pcmFor(fromS, toS) {
    if (devHooks.pcm) return devHooks.pcm({ fromS, toS, sampleRate: SAMPLE_RATE });
    return ctx.Engine.audioPcm({ fromS, toS, sampleRate: SAMPLE_RATE });
  }

  /* ---------- Q1 ---------- */
  async function transcribe(input, person) {
    if (input.cancel) return cancelJob();
    if (running()) throw fail(t('ai.error.busy'));
    if (!ctx.store.media?.name) throw fail(t('ai.error.noMedia'));
    const duration = Number(ctx.store.media.duration || ctx.Engine.state()?.duration || 0);
    const fromS = Math.max(0, Number(input.fromS) || 0);
    const toS = Math.min(duration || Infinity, Number.isFinite(input.toS) ? input.toS : duration);
    const route = await chooseRoute(input.route || 'auto');
    const language = input.language ? languageCode(input.language) : null;
    // The download is the person's act: refuse an agent before anything else, so the reason is clear.
    if (route === 'local' && !person && !(await speechStatus()).downloaded) throw fail(t('ai.error.consent', { mb: speechMB() }));
    if (!devHooks.pcm && typeof ctx.Engine?.audioPcm !== 'function') throw fail(t('ai.error.noPcm'));
    const controller = new AbortController();
    job = { kind: 'transcribe', phase: 'start', done: 0, total: 0, route, error: null, controller };
    try {
      let recognise;
      if (route === 'stub') {
        recognise = (pcm, w) => devHooks.recogniser(pcm, { language, fromS: w.fromS, toS: w.toS });
      } else if (route === 'host') {
        const host = await hostBridge();
        recognise = async pcm => {
          try { const out = await host.ai.experimental_transcribe(pcm); return { text: String(out?.text || ''), chunks: null }; }
          catch (error) { throw fail(t('ai.error.host', { message: error?.message || String(error) })); }
        };
      } else {
        const status = await speechStatus();
        if (!status.available) throw fail(t('ai.state.unavailable'));
        if (!status.downloaded) {
          if (!person) throw fail(t('ai.error.consent', { mb: speechMB() }));
          setJob({ phase: 'download', done: 0, total: 100 });
          await downloadSpeech({ signal: controller.signal, onProgress: f => setJob({ done: Math.round(f * 100) }) });
        }
        setJob({ phase: 'load', done: 0, total: 0 });
        recognise = pcm => transcribeLocal(pcm, { language });
      }
      const windows = planWindows(toS - fromS, { windowS: WINDOW_S, overlapS: OVERLAP_S })
        .map(w => ({ ...w, fromS: w.fromS + fromS, toS: w.toS + fromS, keepFromS: w.keepFromS + fromS, keepToS: w.keepToS + fromS }));
      setJob({ phase: 'recognise', done: 0, total: windows.length });
      const results = [];
      for (const w of windows) {
        if (controller.signal.aborted) throw fail(t('ai.progress.cancelled'), 'CANCELLED');
        const pcm = await pcmFor(w.fromS, w.toS);
        if (controller.signal.aborted) throw fail(t('ai.progress.cancelled'), 'CANCELLED');
        const out = isSilent(pcm) ? { text: '', chunks: [] } : await recognise(pcm, w);
        if (controller.signal.aborted) throw fail(t('ai.progress.cancelled'), 'CANCELLED');
        results.push({ window: w, chunks: out.chunks, text: out.text });
        setJob({ done: results.length });
      }
      const cues = assembleCues(results, { overlapS: OVERLAP_S });
      if (!cues.length) throw fail(t('ai.error.empty'), 'EMPTY');
      const text = formatSrt(cues);
      const name = `${stem()} (generated).srt`;
      const loaded = await r.run('subtitle.load-file', { name, text });
      generated = { name, trackId: loaded?.selectedId ?? null, cueCount: cues.length, saved: false, text };
      editor.value = text;
      editorBox.hidden = false;
      setJob({ phase: 'done', count: cues.length });
      ctx.toast(t('ai.toast.generated', { count: cues.length }));
      return { route, windows: windows.length, cueCount: cues.length, trackName: name, trackId: generated.trackId, text };
    } catch (error) {
      if (job.phase !== 'cancelled') setJob({ phase: error.code === 'CANCELLED' ? 'cancelled' : 'error', error: error.message });
      throw error;
    }
  }

  /* ---------- Q2 ---------- */
  async function translateBatch(create, lines, language, signal) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw fail(t('ai.progress.cancelled'), 'CANCELLED');
      const reply = await create({ messages: translationMessages(lines, language), signal });
      const content = reply?.choices?.[0]?.message?.content ?? '';
      try { return parseNumberedLines(content, lines.length); } catch (error) {
        if (error.code !== 'LINE_COUNT') throw error;
        if (lines.length === 1 && attempt === 1) return [content.replace(/^\s*1\s*[.):-]\s*/, '').trim() || lines[0]];
      }
    }
    // Two replies with the wrong line count: halve the batch until counts match.
    const mid = Math.ceil(lines.length / 2);
    return [...await translateBatch(create, lines.slice(0, mid), language, signal), ...await translateBatch(create, lines.slice(mid), language, signal)];
  }

  async function translate(input) {
    if (input.cancel) return cancelJob();
    if (running()) throw fail(t('ai.error.busy'));
    if (!ctx.store.media?.name) throw fail(t('ai.error.noMedia'));
    if (!input.language) throw fail(t('ai.error.noLanguage'));
    const host = await hostBridge();
    if (!hostCanChat(host)) throw fail(t('ai.translate.noLocal'));
    if (host.capabilities && host.capabilities.ai === false) throw fail(t('ai.translate.noAccess'));
    if (Number.isInteger(input.trackIndex)) await r.run('subtitle.track', { index: input.trackIndex });
    const state = await r.run('subtitle.read');
    if (!(state?.selected >= 0)) throw fail(t('ai.error.noTrack'));
    const source = state.tracks[state.selected];
    const saved = await r.run('subtitle.save', { format: 'srt', download: false });
    const delayS = Number(saved?.delayS) || 0;
    const cues = parseSrt(saved?.text || '').cues.map(c => ({ ...c, startS: Math.max(0, c.startS - delayS), endS: Math.max(0, c.endS - delayS) }));
    if (!cues.length) throw fail(t('ai.error.noTrack'));
    const code = languageCode(input.language);
    const language = languageName(input.language);
    const groups = mergeCuesIntoSentences(cues);
    const parts = batches(groups, TRANSLATE_BATCH);
    const controller = new AbortController();
    job = { kind: 'translate', phase: 'translate', done: 0, total: parts.length, route: 'host', error: null, controller };
    setJob({});
    try {
      const create = options => host.ai.chat.completions.create(options);
      const translations = [];
      for (const part of parts) {
        translations.push(...await translateBatch(create, part.map(g => g.text), language, controller.signal));
        setJob({ done: job.done + 1 });
      }
      if (controller.signal.aborted) throw fail(t('ai.progress.cancelled'), 'CANCELLED');
      const out = applyTranslation(cues, groups, translations);
      const text = formatSrt(out);
      const name = `${stem()}.${code} (translated).srt`;
      const loaded = await r.run('subtitle.load-file', { name, text });
      setJob({ phase: 'done', count: out.length });
      ctx.toast(t('ai.toast.translated', { count: out.length, language }));
      return { route: 'host', language, sourceTrack: source?.label || source?.fileName || null, sentences: groups.length, batches: parts.length, cueCount: out.length, trackName: name, trackId: loaded?.selectedId ?? null, text };
    } catch (error) {
      if (job.phase !== 'cancelled') setJob({ phase: error.code === 'CANCELLED' ? 'cancelled' : 'error', error: error.message });
      throw error;
    }
  }

  r.handle('ai.transcribe', (input = {}) => transcribe(input, takePersonAct()));
  r.handle('ai.translate', (input = {}) => translate(input));
  r.handle('ai.read', async ({ panel } = {}) => {
    if (panel === true) { ctx.panels.open('ai'); await renderStatus(); }
    if (panel === false && ctx.panels.current() === 'ai') ctx.panels.close();
    return read();
  });

  /* ---------- UI ---------- */
  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k in node && k !== 'list') node[k] = v;
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  };
  const option = (value, label) => el('option', { value, textContent: label });
  const body = ctx.panels.register('ai', t('ai.panel.title'));

  const routeSelect = el('select', { id: 'reel-ai-route' }, [option('auto', t('ai.route.auto')), option('host', t('ai.route.host')), option('local', t('ai.route.local'))]);
  const langSelect = el('select', { id: 'reel-ai-language' }, [option('', t('ai.language.auto')), ...LANGUAGES.map(l => option(l.code, l.name))]);
  const status = el('p', { className: 'reel-ai-status', role: 'status' });
  const consent = el('p', { className: 'reel-ai-consent', hidden: true });
  const generateButton = el('button', { type: 'button', className: 'reel-ai-primary', dataset: { command: 'ai.transcribe' }, textContent: t('ai.generate') });
  const cancelButton = el('button', { type: 'button', hidden: true, dataset: { command: 'ai.transcribe' }, textContent: t('ai.cancel') });
  const progress = el('progress', { className: 'reel-ai-progress', max: 1, value: 0, hidden: true });
  const progressText = el('p', { className: 'reel-ai-progress-text', 'aria-live': 'polite' });
  const editor = el('textarea', { id: 'reel-ai-editor', rows: 10, spellcheck: false });
  const applyButton = el('button', { type: 'button', dataset: { command: 'subtitle.load-file' }, textContent: t('ai.editor.apply') });
  const saveButton = el('button', { type: 'button', dataset: { command: 'subtitle.save' }, textContent: t('ai.editor.save') });
  const editorBox = el('div', { className: 'reel-ai-editor', hidden: true }, [
    el('label', { htmlFor: 'reel-ai-editor', textContent: t('ai.editor.label') }), editor,
    el('div', { className: 'reel-ai-row' }, [applyButton, saveButton]),
  ]);
  const targetSelect = el('select', { id: 'reel-ai-target' }, LANGUAGES.map(l => option(l.code, l.name)));
  const translateButton = el('button', { type: 'button', dataset: { command: 'ai.translate' }, textContent: t('ai.translate.run') });
  const translateNote = el('p', { className: 'reel-ai-note' });
  body.append(
    el('div', { className: 'reel-ai-field' }, [el('label', { htmlFor: 'reel-ai-route', textContent: t('ai.route.label') }), routeSelect]),
    el('div', { className: 'reel-ai-field' }, [el('label', { htmlFor: 'reel-ai-language', textContent: t('ai.language.label') }), langSelect]),
    status, consent,
    el('div', { className: 'reel-ai-row' }, [generateButton, cancelButton]),
    progress, progressText, editorBox,
    el('h3', { textContent: t('ai.translate.title') }),
    el('div', { className: 'reel-ai-field' }, [el('label', { htmlFor: 'reel-ai-target', textContent: t('ai.translate.target') }), targetSelect]),
    el('div', { className: 'reel-ai-row' }, [translateButton]),
    translateNote,
  );

  async function renderStatus() {
    const state = await read();
    const requested = routeSelect.value;
    const route = state.route.transcribe === 'stub' ? 'stub'
      : requested === 'local' ? 'local' : requested === 'host' ? 'host' : state.route.transcribe;
    status.textContent = route === 'host' ? t('ai.state.host')
      : route === 'none' ? t('ai.state.unavailable')
      : route === 'stub' ? 'Route: development stub recogniser.'
      : t(`ai.state.${state.model.state}`);
    const needsDownload = route === 'local' && state.model.state === 'absent';
    consent.hidden = !needsDownload;
    consent.textContent = t('ai.consent', { name: SPEECH.name, mb: speechMB() });
    generateButton.textContent = needsDownload ? t('ai.generate.download', { mb: speechMB() }) : t('ai.generate');
    noChat = state.route.translate === 'none';
    translateButton.disabled = noChat;
    targetSelect.disabled = noChat;
    translateNote.textContent = noChat ? t('ai.translate.noLocal') : '';
    renderProgress();
    return state;
  }

  function renderProgress() {
    const busy = running();
    cancelButton.hidden = !busy;
    generateButton.disabled = Boolean(busy);
    translateButton.disabled = Boolean(busy) || noChat;
    if (!job) { progress.hidden = true; progressText.textContent = ''; return; }
    progress.hidden = !busy;
    progress.value = job.total ? job.done / job.total : 0;
    if (!job.total && busy) progress.removeAttribute('value');
    progressText.textContent = job.phase === 'download' ? t('ai.progress.download', { pct: job.done })
      : job.phase === 'load' ? t('ai.progress.load')
      : job.phase === 'recognise' ? t('ai.progress.window', { done: job.done, total: job.total })
      : job.phase === 'translate' ? t('ai.progress.translate', { done: job.done, total: job.total })
      : job.phase === 'done' ? t('ai.progress.done', { count: job.count ?? 0 })
      : job.phase === 'cancelled' ? t('ai.progress.cancelled')
      : job.phase === 'error' ? job.error : '';
  }

  const report = error => { if (error?.code !== 'CANCELLED') ctx.surface('ai', error); renderStatus(); };

  generateButton.addEventListener('click', () => {
    personAct = true;
    const input = { route: routeSelect.value };
    if (langSelect.value) input.language = langSelect.value;
    Promise.resolve(r.run('ai.transcribe', input)).then(renderStatus, report).finally(() => { personAct = false; });
  });
  cancelButton.addEventListener('click', () => {
    const kind = job?.kind === 'translate' ? 'ai.translate' : 'ai.transcribe';
    Promise.resolve(r.run(kind, { cancel: true })).then(renderStatus, report);
  });
  translateButton.addEventListener('click', () => {
    Promise.resolve(r.run('ai.translate', { language: targetSelect.value })).then(renderStatus, report);
  });
  routeSelect.addEventListener('change', () => renderStatus());

  function checkedText() {
    const { cues, errors } = parseSrt(editor.value);
    if (errors.length) throw fail(t('ai.editor.invalid', { count: errors.length, first: errors[0] }));
    if (!cues.length) throw fail(t('ai.error.noGenerated'));
    return formatSrt(cues);
  }
  applyButton.addEventListener('click', async () => {
    try {
      if (!generated) throw fail(t('ai.error.noGenerated'));
      const text = checkedText();
      const loaded = await r.run('subtitle.load-file', { name: generated.name, text, replaceId: generated.trackId });
      generated = { ...generated, text, trackId: loaded?.selectedId ?? generated.trackId };
    } catch (error) { report(error); }
  });
  saveButton.addEventListener('click', async () => {
    try {
      if (!generated) throw fail(t('ai.error.noGenerated'));
      const text = checkedText();
      // Saved: the track loses its "(generated)" mark, then subtitles saves the selected track as SRT.
      const name = `${stem()}.srt`;
      const loaded = await r.run('subtitle.load-file', { name, text, replaceId: generated.trackId });
      const result = await r.run('subtitle.save', { format: 'srt' });
      generated = { ...generated, name, text, trackId: loaded?.selectedId ?? generated.trackId, saved: Boolean(result?.saved) };
    } catch (error) { report(error); }
  });

  const button = el('button', {
    type: 'button', className: 'reel-ai-button', textContent: t('ai.button.text'), title: t('ai.button'),
    'aria-label': t('ai.button'), 'aria-expanded': 'false', 'aria-controls': 'mount-panels', dataset: { command: 'ai.read' },
  });
  button.addEventListener('click', () => {
    Promise.resolve(r.run('ai.read', { panel: ctx.panels.current() !== 'ai' })).catch(report);
  });
  ctx.mounts.controlsRight.append(button);
  ctx.on('ui:panel', ({ id } = {}) => button.setAttribute('aria-expanded', String(id === 'ai')));
  ctx.on('ui:media-cleared', () => { if (running()) cancelJob(); generated = null; editor.value = ''; editorBox.hidden = true; });
  ctx.on('ui:media-loaded', () => { if (running()) cancelJob(); generated = null; editor.value = ''; editorBox.hidden = true; job = null; renderProgress(); });

  ctx.addStyle(`
    .reel-ai-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;font-size:12px}
    .reel-ai-field select{font:inherit;padding:4px}
    .reel-ai-row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
    .reel-ai-status,.reel-ai-consent,.reel-ai-note,.reel-ai-progress-text{font-size:12px;line-height:1.45;margin:6px 0}
    .reel-ai-consent{opacity:.85}
    .reel-ai-progress{width:100%}
    .reel-ai-editor{display:flex;flex-direction:column;gap:4px;font-size:12px;margin-top:8px}
    .reel-ai-editor textarea{font:12px/1.4 ui-monospace,monospace;width:100%;resize:vertical}
    [data-panel="ai"] h3{font-size:12px;font-weight:600;margin:14px 0 6px}
    [data-panel="ai"] button:focus-visible,[data-panel="ai"] select:focus-visible,[data-panel="ai"] textarea:focus-visible,.reel-ai-button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
  `);

  // Development hook (?dev=1 only): checks inject a stub recogniser, a PCM source or a stub host,
  // so the pipeline runs without downloading the model.
  try {
    if (new URLSearchParams(location.search).get('dev') === '1') {
      globalThis.__reelAiDev = Object.freeze({
        setRecogniser(fn) { devHooks.recogniser = typeof fn === 'function' ? fn : null; },
        setPcm(fn) { devHooks.pcm = typeof fn === 'function' ? fn : null; },
        setHost(host) { devHooks.host = host === undefined ? undefined : host; },
        reset() { devHooks.recogniser = null; devHooks.pcm = null; devHooks.host = undefined; },
        localState: () => localState,
      });
    }
  } catch { /* no location */ }

  renderStatus().catch(() => {});
}
