// sound-panel.mjs — Sound settings (S1 ReplayGain, S3 EQ, S4 crossfade, gapless, S2 loudness scan).
//
// Every change goes through a command where one exists (eq.preset, eq.enable,
// sound.replaygain, sound.crossfade, sound.gapless); the shell's handlers save the
// setting and apply it to the engine. The loudness scan has no command, so it goes
// through ctx.settings.set. When a command has no handler in this build, the panel
// falls back to ctx.settings.set with the same value.

import { EQ_BANDS_HZ, EQ_PRESETS, EQ_PRESET_IDS, EQ_MIN_DB, EQ_MAX_DB, normaliseCustom } from '../audio/eq-presets.mjs';
import { h, injectCss, nextId } from './dialog.mjs';

export const EQ_STEP_DB = 0.5;

// ---------------------------------------------------------------- pure ----

/** A slider's string value to dB, clamped to -12..12 and rounded to the 0.5 dB step. */
export function sliderToDb(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const clamped = Math.max(EQ_MIN_DB, Math.min(EQ_MAX_DB, number));
  return Math.round(clamped / EQ_STEP_DB) * EQ_STEP_DB;
}

/** "+3 dB", "-4.5 dB", "0 dB". Uses a real minus sign for screen readers and display. */
export function formatDb(db) {
  const value = Math.round(Number(db) * 10) / 10;
  if (!value) return '0 dB';
  return `${value > 0 ? '+' : '−'}${Math.abs(value)} dB`;
}

/** "70 Hz", "1 kHz", "12 kHz". */
export function formatHz(hz) {
  return hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
}

/** Short band label under a slider: "70", "1k", "12k". */
export function shortHz(hz) {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz);
}

/** Short value above a slider: "+3", "\u22124.5", "0". */
export function shortDb(db) {
  return formatDb(db).replace(' dB', '');
}

/** The ten gains the sliders show for an EQ setting (shown even while the EQ is off). */
export function displayedCurve(eq = {}) {
  if (eq.preset === 'custom') return normaliseCustom(eq.custom);
  return [...(EQ_PRESETS[eq.preset] ?? EQ_PRESETS.flat).gains];
}

/**
 * The settings change for moving one band: the curve on screen becomes the custom
 * curve with that band changed, and the EQ turns on (moving a slider means you want
 * to hear it).
 */
export function editBand(eq, index, db) {
  const custom = displayedCurve(eq);
  custom[index] = sliderToDb(db);
  return { enabled: true, preset: 'custom', custom };
}

export function presetLabel(id) {
  return id === 'custom' ? 'Custom' : (EQ_PRESETS[id]?.label ?? id);
}

export function crossfadeText(seconds) {
  const s = Number(seconds) || 0;
  return s <= 0 ? 'Off' : `${s} s`;
}

/** Plain words for the loudness scanner's status object (or string) the shell passes in. */
export function loudnessStatusText(setting, status) {
  if (setting === 'off') return 'Off. Tracks without ReplayGain tags play at their own level.';
  if (!status) return 'Measures tracks without ReplayGain tags while nothing else is decoding.';
  const s = typeof status === 'string' ? { state: status } : status;
  const counts = Number.isFinite(s.total) && s.total > 0 ? ` ${s.done ?? 0} of ${s.total} measured.` : '';
  if (s.state === 'running') return `Measuring loudness.${counts}`;
  if (s.state === 'paused') return `Paused while playback decodes.${counts}`;
  if (s.state === 'done') return `Every track has a loudness value.${counts}`;
  if (s.state === 'error') return `Stopped: ${s.message ?? 'a track could not be measured'}.`;
  return `Waiting for an idle moment.${counts}`;
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-sound,.nk-sound *{box-sizing:border-box}
.nk-sound{--c-ink:var(--ink,var(--text));color:var(--c-ink);display:grid;gap:18px;min-width:0}
.nk-sound section{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--panel-2);min-width:0}
.nk-sound h3{margin:0 0 10px;font-size:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.nk-sound .row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:8px 0}
.nk-sound label{color:var(--c-ink)}
.nk-sound .hint{color:var(--muted);font-size:12px;line-height:1.5;margin:6px 0 0}
.nk-sound select,.nk-sound input[type=number]{min-height:34px;padding:4px 8px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--c-ink);font:inherit;max-width:100%}
.nk-sound input[type=range]{accent-color:var(--accent)}
.nk-sound .switch{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.nk-eq{display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:4px;align-items:end;margin-top:6px}
.nk-eq .band{display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
.nk-eq input[type=range]{writing-mode:vertical-lr;direction:rtl;width:28px;height:140px;margin:0;padding:0}
.nk-eq .val{font:10px var(--mono,monospace);color:var(--muted);white-space:nowrap}
.nk-eq .hz{font:10px var(--mono,monospace);color:var(--c-ink);white-space:nowrap}
.nk-eq.off input[type=range]{opacity:.55}
.nk-sound .wide-range{flex:1;min-width:140px}
.nk-sound output{font:12px var(--mono,monospace);min-width:52px;color:var(--muted)}
.nk-sound .live{font:11px var(--mono,monospace);color:var(--muted);overflow-wrap:anywhere}
.nk-sound fieldset{border:0;margin:0;padding:0;display:flex;gap:4px 12px;flex-wrap:wrap}
.nk-sound legend{padding:0;margin-bottom:4px;color:var(--muted);font-size:12px}
@media(max-width:420px){.nk-eq input[type=range]{height:120px;width:22px}.nk-eq .val{font-size:9px}.nk-eq .hz{font-size:9px}}
`;

// ------------------------------------------------------------------- UI ----

function liveText(dsp) {
  const parts = [`Sound chain ${dsp.chain === 'on' ? 'on' : 'off'}`];
  if (Number.isFinite(dsp.gainDb)) parts.push(`gain ${formatDb(dsp.gainDb)}${dsp.gainSource ? ` from ${dsp.gainSource}` : ''}${dsp.clipLimited ? ', limited by the peak' : ''}`);
  if (dsp.crossfading) parts.push('crossfading');
  else if (dsp.gapless) parts.push('gapless to the next track');
  return `Playing now: ${parts.join(', ')}.`;
}

export function mountSoundPanel(root, ctx) {
  injectCss('sound-panel', CSS);
  const id = nextId('sound');
  let settings = ctx.settings.get();
  let loudnessStatus = null;
  let pendingEq = null;
  let eqTimer = 0;

  async function act(name, input, patch) {
    try {
      if (typeof ctx.run !== 'function') throw Object.assign(new Error('no runner'), { code: 'not-found' });
      await ctx.run(name, input);
    } catch (error) {
      if (error?.code === 'not-found') ctx.settings.set(patch);
      else ctx.toast?.(String(error?.message ?? error));
    }
  }

  // ---- EQ
  const eqOn = h('input', { type: 'checkbox', id: `${id}-eq-on` });
  const presetSelect = h('select', { id: `${id}-preset`, 'aria-label': 'Equaliser preset' },
    EQ_PRESET_IDS.map(p => h('option', { value: p, textContent: presetLabel(p) })));
  const bands = EQ_BANDS_HZ.map((hz, index) => {
    const valueId = `${id}-band-${index}-val`; // value text is aria-valuetext on the slider
    const input = h('input', {
      type: 'range', min: EQ_MIN_DB, max: EQ_MAX_DB, step: EQ_STEP_DB, orient: 'vertical',
      'aria-label': `${formatHz(hz)} band`,
    });
    const value = h('span', { className: 'val', id: valueId, 'aria-hidden': 'true' });
    input.addEventListener('input', () => {
      const db = sliderToDb(input.value);
      value.textContent = shortDb(db);
      input.setAttribute('aria-valuetext', formatDb(db));
      pendingEq = editBand(pendingEq ?? settings.eq, index, db);
      presetSelect.value = 'custom';
      eqOn.checked = true;
      clearTimeout(eqTimer);
      eqTimer = setTimeout(flushEq, 120);
    });
    input.addEventListener('change', flushEq);
    return { input, value, wrap: h('div', { className: 'band' }, value, input, h('span', { className: 'hz', 'aria-hidden': 'true', textContent: shortHz(hz) })) };
  });
  const eqGrid = h('div', { className: 'nk-eq', role: 'group', 'aria-label': 'Equaliser bands, -12 to +12 dB' }, bands.map(b => b.wrap));

  function flushEq() {
    clearTimeout(eqTimer);
    if (!pendingEq) return;
    const next = pendingEq;
    pendingEq = null;
    act('eq.preset', { preset: 'custom', custom: next.custom }, { eq: next })
      .then(() => (settings.eq.enabled ? null : act('eq.enable', { enabled: true }, { eq: { enabled: true } })));
  }

  eqOn.addEventListener('change', () => act('eq.enable', { enabled: eqOn.checked }, { eq: { enabled: eqOn.checked } }));
  presetSelect.addEventListener('change', () => {
    const preset = presetSelect.value;
    act('eq.preset', { preset }, { eq: { preset } });
  });
  const resetButton = h('button', {
    type: 'button', className: 'nk-btn', textContent: 'Flat',
    'aria-label': 'Reset the equaliser to flat', onclick: () => act('eq.preset', { preset: 'flat' }, { eq: { preset: 'flat' } }),
  });

  const eqSection = h('section', { 'aria-labelledby': `${id}-eq-h` },
    h('h3', { id: `${id}-eq-h` }, 'Equaliser',
      h('label', { className: 'switch', htmlFor: `${id}-eq-on` }, eqOn, 'On')),
    h('div', { className: 'row' }, h('label', { htmlFor: `${id}-preset`, textContent: 'Preset' }), presetSelect, resetButton),
    eqGrid,
    h('p', { className: 'hint', textContent: 'Bands in hertz (k = kHz), gains in dB. Moving a band saves your curve as Custom. Arrow keys move a band by 0.5 dB; Page Up and Page Down move it further.' }));

  // ---- ReplayGain
  const rgModes = [['off', 'Off'], ['track', 'Track'], ['album', 'Album'], ['auto', 'Auto']];
  const rgRadios = rgModes.map(([value, label]) => {
    const input = h('input', { type: 'radio', name: `${id}-rg`, value, id: `${id}-rg-${value}` });
    input.addEventListener('change', () => { if (input.checked) act('sound.replaygain', { mode: value }, { replayGain: { mode: value } }); });
    return { value, input, label: h('label', { className: 'switch', htmlFor: `${id}-rg-${value}` }, input, label) };
  });
  const preamp = h('input', { type: 'range', min: -15, max: 15, step: 0.5, id: `${id}-preamp`, className: 'wide-range' });
  const preampOut = h('output', { htmlFor: `${id}-preamp` });
  preamp.addEventListener('input', () => {
    preampOut.textContent = formatDb(preamp.value);
    preamp.setAttribute('aria-valuetext', formatDb(preamp.value));
  });
  preamp.addEventListener('change', () => {
    const preampDb = Number(preamp.value);
    act('sound.replaygain', { preampDb }, { replayGain: { preampDb } });
  });
  const clip = h('input', { type: 'checkbox', id: `${id}-clip` });
  clip.addEventListener('change', () => act('sound.replaygain', { preventClipping: clip.checked }, { replayGain: { preventClipping: clip.checked } }));

  const rgSection = h('section', { 'aria-labelledby': `${id}-rg-h` },
    h('h3', { id: `${id}-rg-h`, textContent: 'ReplayGain' }),
    h('fieldset', {}, h('legend', { textContent: 'Mode' }), rgRadios.map(r => r.label)),
    h('p', { className: 'hint', textContent: 'Auto uses album gain while an album plays in order, and track gain otherwise.' }),
    h('div', { className: 'row' }, h('label', { htmlFor: `${id}-preamp`, textContent: 'Preamp' }), preamp, preampOut),
    h('div', { className: 'row' }, h('label', { className: 'switch', htmlFor: `${id}-clip` }, clip, 'Prevent clipping (lower the gain when the peak would clip)')));

  // ---- Crossfade and gapless
  const crossfade = h('input', { type: 'range', min: 0, max: 12, step: 1, id: `${id}-xf`, className: 'wide-range' });
  const crossfadeOut = h('output', { htmlFor: `${id}-xf` });
  crossfade.addEventListener('input', () => {
    crossfadeOut.textContent = crossfadeText(crossfade.value);
    crossfade.setAttribute('aria-valuetext', crossfadeText(crossfade.value));
  });
  crossfade.addEventListener('change', () => {
    const seconds = Number(crossfade.value);
    act('sound.crossfade', { seconds }, { crossfadeS: seconds });
  });
  const gapless = h('select', { id: `${id}-gapless` },
    [['off', 'Off'], ['albums', 'Within an album'], ['always', 'Always']].map(([value, label]) => h('option', { value, textContent: label })));
  gapless.addEventListener('change', () => act('sound.gapless', { mode: gapless.value }, { gapless: gapless.value }));

  const flowSection = h('section', { 'aria-labelledby': `${id}-flow-h` },
    h('h3', { id: `${id}-flow-h`, textContent: 'Between tracks' }),
    h('div', { className: 'row' }, h('label', { htmlFor: `${id}-xf`, textContent: 'Crossfade' }), crossfade, crossfadeOut),
    h('div', { className: 'row' }, h('label', { htmlFor: `${id}-gapless`, textContent: 'Gapless' }), gapless),
    h('p', { className: 'hint', textContent: 'Tracks of one album never crossfade while gapless applies to them.' }));

  // ---- Loudness scan
  const scan = h('select', { id: `${id}-scan` },
    [['idle', 'When idle'], ['off', 'Off']].map(([value, label]) => h('option', { value, textContent: label })));
  const scanStatus = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  scan.addEventListener('change', () => ctx.settings.set({ loudnessScan: scan.value }));
  const scanSection = h('section', { 'aria-labelledby': `${id}-scan-h` },
    h('h3', { id: `${id}-scan-h`, textContent: 'Loudness scan' }),
    h('div', { className: 'row' }, h('label', { htmlFor: `${id}-scan`, textContent: 'Measure loudness' }), scan),
    scanStatus);

  const live = h('p', { className: 'live', 'aria-live': 'off' });
  const container = h('div', { className: 'nk-sound' }, eqSection, rgSection, flowSection, scanSection, live);
  root.append(container);

  function render() {
    const s = settings;
    eqOn.checked = Boolean(s.eq.enabled);
    presetSelect.value = s.eq.preset;
    eqGrid.classList.toggle('off', !s.eq.enabled);
    const curve = displayedCurve(pendingEq ?? s.eq);
    bands.forEach((band, index) => {
      if (document.activeElement !== band.input || !pendingEq) band.input.value = String(curve[index]);
      band.value.textContent = shortDb(curve[index]);
      band.input.setAttribute('aria-valuetext', formatDb(curve[index]));
    });
    for (const r of rgRadios) r.input.checked = s.replayGain.mode === r.value;
    preamp.value = String(s.replayGain.preampDb);
    preampOut.textContent = formatDb(s.replayGain.preampDb);
    preamp.setAttribute('aria-valuetext', formatDb(s.replayGain.preampDb));
    clip.checked = Boolean(s.replayGain.preventClipping);
    crossfade.value = String(s.crossfadeS);
    crossfadeOut.textContent = crossfadeText(s.crossfadeS);
    crossfade.setAttribute('aria-valuetext', crossfadeText(s.crossfadeS));
    gapless.value = s.gapless;
    scan.value = s.loudnessScan;
    scanStatus.textContent = loudnessStatusText(s.loudnessScan, loudnessStatus);
    renderLive();
  }

  function engineDsp() {
    try { return ctx.engine?.state?.()?.dsp ?? null; } catch { return null; }
  }

  function renderLive() {
    const dsp = engineDsp();
    live.textContent = dsp ? liveText(dsp) : '';
  }

  const offSettings = ctx.settings.on?.(next => { settings = next; render(); });
  render();

  return {
    update(state) {
      if (state && 'loudnessScan' in state) loudnessStatus = state.loudnessScan;
      settings = ctx.settings.get();
      render();
    },
    destroy() {
      flushEq();
      clearTimeout(eqTimer);
      if (typeof offSettings === 'function') offSettings();
      container.remove();
    },
  };
}
