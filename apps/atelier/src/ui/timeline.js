// Timeline panel (P58): frame rate and length, a frame scrubber, play and stop in the canvas, keyframes
// on the active layer (visibility, opacity, position, scale, rotation), frame-animation capture, video
// layers, and export to animated GIF, animated WebP or WebM. Mounted in the side panel by src/ui/index.js.

import { h } from './dom.js';

const PROPS = [['opacity', 'Opacity %'], ['visible', 'Visible'], ['x', 'X offset px'], ['y', 'Y offset px'], ['scale', 'Scale ×'], ['rotation', 'Rotation°']];

export function createTimelinePanel(root, ui) {
  const fps = h('input', { type: 'number', min: 1, max: 60, value: 12, 'aria-label': 'Frames per second' });
  const frames = h('input', { type: 'number', min: 1, max: 3600, value: 24, 'aria-label': 'Frames' });
  const scrub = h('input', { type: 'range', min: 0, max: 23, value: 0, 'aria-label': 'Frame', dataset: { command: 'go_to_frame' }, oninput: () => go(+scrub.value) });
  const at = h('span', { class: 'dim' }, 'frame 0');
  const prop = h('select', { 'aria-label': 'Property' }, PROPS.map(([v, l]) => h('option', { value: v }, l)));
  const val = h('input', { type: 'text', value: '100', 'aria-label': 'Key value', size: 6 });
  const easeSel = h('select', { 'aria-label': 'Ease' }, ['linear', 'ease', 'hold'].map((v) => h('option', { value: v }, v)));
  const keys = h('div', { class: 'dim tl-keys' });
  const fmt = h('select', { 'aria-label': 'Export format' }, ['gif', 'webp', 'webm'].map((v) => h('option', { value: v }, v.toUpperCase())));
  const play = h('button', { dataset: { command: 'play_timeline' }, onclick: () => toggle() }, 'Play');
  let playing = false;

  const layer = () => ui.store.doc?.activeLayerId;
  const frame = () => +scrub.value;
  async function refresh() {
    const r = await ui.read('get_timeline');
    const tl = r.status === 'ok' ? r.result.timeline : null;
    if (!tl) { keys.textContent = ui.store.doc ? 'No timeline yet: set the frame rate and length, then Create.' : 'Open a document first.'; return; }
    fps.value = tl.fps; frames.value = tl.frames; scrub.max = tl.frames - 1; scrub.value = r.result.frame; at.textContent = `frame ${r.result.frame} · ${(r.result.frame / tl.fps).toFixed(2)} s`;
    const names = Object.fromEntries((ui.store.doc?.layers || []).map((l) => [l.id, l.name]));
    keys.replaceChildren(...Object.entries(tl.tracks).map(([id, t]) => h('div', {}, `${names[id] ?? id}: `, Object.entries(t).map(([p, k]) => `${p} @ ${k.map((x) => x[0]).join(', ')}`).join(' · '))));
  }
  async function go(f) { const r = await ui.send('go_to_frame', { frame: f }); if (r.status === 'ok') at.textContent = `frame ${f} · ${r.result.time.toFixed(2)} s`; }
  async function toggle() {
    playing = !playing;
    const r = await ui.send('play_timeline', { play: playing });
    if (r.status !== 'ok') playing = false;
    play.textContent = playing ? 'Stop' : 'Play';
  }
  ui.ctx.onFrame = (f) => { scrub.value = f; at.textContent = `frame ${f}`; };
  async function key() {
    const p = prop.value; const raw = val.value.trim();
    const value = p === 'visible' ? raw === 'true' || raw === '1' || raw === 'on' : Number(raw);
    const r = await ui.send('set_keyframe', { layerId: layer(), property: p, frame: frame(), value, ease: easeSel.value });
    if (r.status === 'ok') { ui.say(`Keyed ${p} at frame ${frame()}.`); await refresh(); await go(frame()); }
  }
  async function exportAnim() {
    const name = (await ui.dialogs.promptText('Export animation', 'Path', `exports/${(ui.store.doc?.title || 'animation').replace(/\.[^.]+$/, '')}.${fmt.value}`))?.trim();
    if (!name) return;
    ui.say(`Exporting ${fmt.value.toUpperCase()}…`);
    const r = await ui.send('export_animation', { path: name, format: fmt.value });
    if (r.status === 'ok') ui.say(`Wrote ${r.result.path}: ${r.result.frames} frames, ${r.result.width} × ${r.result.height}, ${r.result.bytes} bytes.`);
  }
  async function importVideo() {
    const p = ui.filmstrip?.selected?.[0] || (await ui.dialogs.promptText('Import video as a layer', 'Workspace path of the video file'))?.trim();
    if (!p) return;
    const r = await ui.send('import_video', { path: p, offset: frame() });
    if (r.status === 'ok') { ui.say(`Video layer ${r.result.layer.name}: ${r.result.video.width} × ${r.result.video.height}, ${r.result.video.duration.toFixed(2)} s.`); await refresh(); ui.render(); }
  }

  root.replaceChildren(h('details', { class: 'timeline-panel' },
    h('summary', { dataset: { view: 'timeline-panel' }, onclick: () => refresh() }, 'Timeline'),
    h('div', { class: 'row' }, h('label', { class: 'opt' }, 'fps', fps), h('label', { class: 'opt' }, 'Frames', frames),
      h('button', { dataset: { command: 'set_timeline' }, onclick: async () => { const r = await ui.send('set_timeline', { fps: +fps.value, frames: Math.round(+frames.value) }); if (r.status === 'ok') refresh(); } }, 'Create / update')),
    h('div', { class: 'row' }, scrub, at),
    h('div', { class: 'row' }, play,
      h('button', { dataset: { command: 'go_to_frame' }, onclick: () => { const f = Math.max(0, frame() - 1); scrub.value = f; go(f); } }, '◀'),
      h('button', { dataset: { command: 'go_to_frame' }, onclick: () => { const f = Math.min(+scrub.max, frame() + 1); scrub.value = f; go(f); } }, '▶')),
    h('div', { class: 'row' }, prop, val, easeSel, h('button', { dataset: { command: 'set_keyframe' }, title: 'Key the active layer at this frame', onclick: key }, 'Key')),
    h('div', { class: 'row' },
      h('button', { dataset: { command: 'delete_keyframe' }, onclick: async () => { const r = await ui.send('delete_keyframe', { layerId: layer(), property: prop.value, frame: frame() }); if (r.status === 'ok') refresh(); } }, 'Delete key'),
      h('button', { dataset: { command: 'capture_frame' }, title: 'Frame animation: record every layer\'s visibility and opacity at this frame', onclick: async () => { const r = await ui.send('capture_frame', { frame: frame() }); if (r.status === 'ok') { ui.say(`Captured frame ${frame()}.`); refresh(); } } }, 'Capture frame'),
      h('button', { dataset: { command: 'import_video' }, onclick: importVideo }, 'Video layer…')),
    keys,
    h('div', { class: 'row' }, fmt, h('button', { class: 'primary', dataset: { command: 'export_animation' }, onclick: exportAnim }, 'Export animation…'))));
  return { refresh };
}
