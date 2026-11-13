// The Export dialog: format, quality, size and colour space, sent as one export_image call. The autosaver
// flushes first, so the export and the saved document agree. Replacing an existing file comes back
// `staged` and waits in the staged-actions bar for the person's Confirm.

import { h } from './dom.js';
import { plainError } from './send.js';

const FORMATS = [['jpeg', 'JPEG'], ['png', 'PNG'], ['webp', 'WebP'], ['avif', 'AVIF'], ['tiff16', 'TIFF 16-bit'], ['cmyk-tiff', 'TIFF CMYK 8-bit (built-in press)']];
const SPACES = [['srgb', 'sRGB'], ['display-p3', 'Display P3'], ['rec2020', 'Rec. 2020']];

export function exportFields(doc, last = {}) {
  const stem = (doc?.title || 'export').replace(/\.[^.]+$/, '');
  return { name: last.name ?? `exports/${stem}`, format: last.format ?? 'jpeg', quality: last.quality ?? 90, maxEdge: last.maxEdge ?? '', colorSpace: last.colorSpace ?? 'srgb' };
}

// Form values → export_image arguments (without revision). Throws a message for a bad field.
export function exportArgs(v) {
  const args = { path: String(v.name).trim(), format: v.format };
  if (!args.path) throw new Error('Name the file.');
  if (['jpeg', 'webp', 'avif'].includes(v.format)) args.quality = Math.min(100, Math.max(1, Math.round(Number(v.quality) || 90)));
  if (v.maxEdge !== '' && v.maxEdge != null) { const m = Math.round(Number(v.maxEdge)); if (!(m >= 16)) throw new Error('Long edge is at least 16 px, or empty for full size.'); args.maxEdge = m; }
  if (v.colorSpace && v.colorSpace !== 'srgb') args.colorSpace = v.colorSpace;
  return args;
}

// Form values → export_cmyk_tiff arguments (without revision): the path takes .tif when it has no TIFF extension.
export function cmykArgs(v) {
  let path = String(v.name).trim();
  if (!path) throw new Error('Name the file.');
  if (!/\.tiff?$/i.test(path)) path += '.tif';
  const profile = String(v.profile ?? '').trim();
  let args;
  if (profile) {   // through the person's CMYK ICC profile (a workspace .icc or .icm file): no ink limit, 8 or 16 bits
    if (!/\.(icc|icm)$/i.test(profile)) throw new Error('The profile is a workspace path ending in .icc or .icm.');
    args = { path, profile, bits: Number(v.bits) === 16 ? 16 : 8 };
  } else {
    const tac = Math.round(Number(v.tac) || 300);
    if (!(tac >= 100 && tac <= 400)) throw new Error('Total ink is 100 to 400 percent.');
    args = { path, tac };
  }
  if (v.maxEdge !== '' && v.maxEdge != null) { const m = Math.round(Number(v.maxEdge)); if (!(m >= 64)) throw new Error('Long edge is at least 64 px for CMYK, or empty for full size.'); args.maxEdge = m; }
  return args;
}

const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', psd: 'image/vnd.adobe.photoshop', gif: 'image/gif', webm: 'video/webm' };

// With "This browser" storage an exported file sits in the browser's private storage, where no other app
// can reach it, so Atelier also hands the person a copy as a download. A folder or NakliOS storage already
// puts the file on their disk. Returns true when a download was started.
export async function downloadExport(ui, path) {
  const s = ui.ctx.storage();
  if (!s || s.kind !== 'browser') return false;
  const bytes = await s.readBinary(path);
  const name = path.split('/').pop();
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return true;
}

export function createExport(ui) {
  ui.downloadExport = (path) => downloadExport(ui, path).catch((e) => { ui.say(`Exported ${path}, but the download failed: ${e.message}`); return false; });
  let last = {};
  return async function openExport() {
    const doc = ui.store.doc;
    if (!doc) { ui.say('Open a photo or document before exporting.'); return null; }
    const v = exportFields(doc, last);
    const name = h('input', { type: 'text', value: v.name, 'aria-label': 'File' });
    const format = h('select', { 'aria-label': 'Format' }, FORMATS.map(([k, t]) => h('option', { value: k, selected: k === v.format }, t)));
    const quality = h('input', { type: 'number', min: 1, max: 100, value: v.quality, 'aria-label': 'Quality' });
    const maxEdge = h('input', { type: 'number', min: 16, placeholder: `${Math.max(doc.width, doc.height)} (full size)`, value: v.maxEdge, 'aria-label': 'Long edge in pixels' });
    const space = h('select', { 'aria-label': 'Colour space' }, SPACES.map(([k, t]) => h('option', { value: k, selected: k === v.colorSpace }, t)));
    const spaceRow = h('label', { class: 'field' }, h('span', {}, 'Colour space'), space);
    const qRow = h('label', { class: 'field' }, h('span', {}, 'Quality'), quality);
    const tac = h('input', { type: 'number', min: 100, max: 400, step: 10, value: last.tac ?? 300, 'aria-label': 'Total ink limit' });
    const tacRow = h('label', { class: 'field', dataset: { command: 'export_cmyk_tiff' } }, h('span', {}, 'Total ink (%)'), tac);
    const profile = h('input', { type: 'text', value: last.profile ?? '', placeholder: 'empty: built-in press', 'aria-label': 'CMYK ICC profile (workspace path)' });
    const bits = h('select', { 'aria-label': 'Bits per ink' }, h('option', { value: '8' }, '8-bit'), h('option', { value: '16', selected: String(last.bits) === '16' }, '16-bit (needs a profile)'));
    const profRow = h('label', { class: 'field', dataset: { command: 'export_cmyk_tiff' } }, h('span', {}, 'ICC profile'), profile, bits);
    const sync = () => { qRow.hidden = !['jpeg', 'webp', 'avif'].includes(format.value); tacRow.hidden = profRow.hidden = format.value !== 'cmyk-tiff'; spaceRow.hidden = format.value === 'cmyk-tiff'; };
    format.addEventListener('change', sync); sync();
    const body = h('div', { class: 'form', dataset: { command: 'export_image' } },
      h('label', { class: 'field' }, h('span', {}, 'File'), name),
      h('label', { class: 'field' }, h('span', {}, 'Format'), format), qRow,
      h('label', { class: 'field' }, h('span', {}, 'Long edge (px)'), maxEdge),
      spaceRow, tacRow, profRow,
      h('p', { class: 'hint' }, `${doc.width} × ${doc.height} px. ${ui.ctx.storage()?.kind === 'browser' ? 'Your browser also downloads a copy.' : `The file is saved in ${ui.ctx.storage()?.label ?? 'your storage'}, in the exports folder unless the name says otherwise.`}`));
    const answer = await ui.dialogs.raw({ title: 'Export', body, actions: [{ label: 'Cancel', value: null }, { label: 'Export', primary: true, value: () => ({ name: name.value, format: format.value, quality: quality.value, maxEdge: maxEdge.value, colorSpace: space.value, tac: tac.value, profile: profile.value, bits: bits.value }) }] });
    if (!answer) return null;
    last = answer;
    const cmyk = answer.format === 'cmyk-tiff';
    let args;
    try { args = cmyk ? cmykArgs(answer) : exportArgs(answer); } catch (e) { await ui.dialogs.info('Export', e.message); return null; }
    await ui.flush?.();
    ui.say('Exporting…');
    const r = cmyk ? await ui.send('export_cmyk_tiff', args) : await ui.send('export_image', args);
    if (r.status === 'ok') {
      const got = await ui.downloadExport(r.result.path);
      ui.say(`Exported ${r.result.path} (${r.result.width} × ${r.result.height}, ${Math.round(r.result.bytes / 1024)} KB)${got ? '; your browser is downloading a copy' : ''}.`);
    }
    else if (r.status === 'staged') ui.say('The export replaces a file that exists: confirm or discard it in the bar below.');
    else await ui.dialogs.info('Export did not run', plainError(r));
    return r;
  };
}
