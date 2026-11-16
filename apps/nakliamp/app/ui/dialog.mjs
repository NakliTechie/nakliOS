// dialog.mjs — the shared accessible modal for NakliAmp's dialog layer (panel agent C).
//
// openDialog() builds role=dialog with aria-modal and aria-labelledby, traps Tab
// inside, closes on Escape (without letting the key reach the page's shortcuts),
// and returns focus to the element that had it when the dialog opened.
// mountInDialog() wraps any panel (`mount<Name>(root, ctx)`) in one.
// confirmCommand() is the `confirm` that bindCommands takes for destructive commands.
//
// Also exports the two helpers every panel C module uses: h() and injectCss().
// Nothing here touches `document` at import time, so Node tests can import the module.

/** Create an element. `attrs`: properties (className, textContent, on* handlers) and attributes. */
const PROPERTY_KEYS = new Set(['className', 'textContent', 'value', 'checked', 'htmlFor']);
const isAbsent = value => value === undefined || value === null || value === false;

function applyAttr(el, key, value) {
  if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
  else if (PROPERTY_KEYS.has(key)) el[key] = value;
  else if (key === 'dataset') Object.assign(el.dataset, value);
  else el.setAttribute(key, value === true ? '' : String(value));
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (!isAbsent(value)) applyAttr(el, key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (!isAbsent(child)) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** Add one <style id="nakliamp-css-<name>"> to the document head, once. */
export function injectCss(name, css) {
  if (typeof document === 'undefined') return;
  const id = `nakliamp-css-${name}`;
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = css;
  document.head.append(style);
}

let uid = 0;
/** A document-unique id with a readable prefix. */
export const nextId = prefix => `nk-${prefix}-${++uid}`;

export const reducedMotion = () => {
  try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; }
};

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Focusable descendants in tab order, skipping hidden ones. */
export function focusables(container) {
  return [...container.querySelectorAll(FOCUSABLE)].filter(el => !el.closest('[hidden]') && el.getClientRects().length > 0);
}

/**
 * Which element Tab or Shift+Tab should move to, or null to let the browser move.
 * Pure, so the wrap-around rule is unit-tested.
 */
export function trapTarget(list, active, shift) {
  if (!list.length) return 'container';
  const index = list.indexOf(active);
  if (shift && (index <= 0)) return list[list.length - 1];
  if (!shift && (index === -1 || index === list.length - 1)) return list[0];
  return null;
}

const CSS = `
.nk-dlg-backdrop,.nk-dlg-backdrop *{box-sizing:border-box}
.nk-dlg-backdrop{position:fixed;inset:0;z-index:80;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--bg) 62%,transparent);backdrop-filter:blur(4px)}
.nk-dlg{--c-ink:var(--ink,var(--text));width:min(640px,100%);max-height:min(88vh,900px);display:flex;flex-direction:column;background:var(--panel);color:var(--c-ink);border:1px solid var(--line);border-radius:14px;box-shadow:0 30px 80px -30px rgba(0,0,0,.55);overflow:hidden}
.nk-dlg.wide{width:min(860px,100%)}
.nk-dlg-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--line)}
.nk-dlg-head h2{margin:0;font-size:17px;font-weight:750;flex:1;min-width:0;overflow-wrap:anywhere}
.nk-dlg-x{min-width:36px;min-height:36px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);color:inherit;cursor:pointer;font-size:16px;line-height:1}
.nk-dlg-body{padding:14px 16px;overflow:auto;min-height:0}
.nk-dlg-foot{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;padding:12px 16px;border-top:1px solid var(--line)}
.nk-dlg-foot:empty{display:none}
.nk-btn{min-height:38px;padding:7px 14px;border:1px solid var(--line);border-radius:9px;background:var(--panel-2);color:var(--c-ink,var(--text));cursor:pointer;font:inherit}
.nk-btn:hover{border-color:var(--accent)}
.nk-btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink,#1a1206);font-weight:700}
.nk-btn.danger{border-color:var(--refuse,#c0392b);color:var(--refuse,#c0392b)}
.nk-btn[disabled]{opacity:.5;cursor:not-allowed}
.nk-dlg :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.nk-confirm ul{margin:6px 0 12px;padding-left:20px;line-height:1.55;overflow-wrap:anywhere}
.nk-confirm .note{color:var(--warn,var(--muted));}
.nk-confirm h3{font-size:13px;margin:12px 0 4px;color:var(--muted)}
@media(max-width:480px){.nk-dlg-backdrop{padding:8px;align-items:end}.nk-dlg{max-height:92vh}}
`;

/**
 * Open a modal.
 * options: { title, layer (element to render in; default document.body), wide, labelClose,
 *            onClose(result), closeOnBackdrop (default true) }
 * Returns { element, body, footer, close(result), closed: Promise<result> }.
 */
export function openDialog({ title = 'Dialog', layer = null, wide = false, closeLabel = 'Close', onClose = null, closeOnBackdrop = true } = {}) {
  injectCss('dialog', CSS);
  const opener = document.activeElement;
  const titleId = nextId('dlg-title');
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });

  const heading = h('h2', { id: titleId, textContent: title });
  const closeButton = h('button', { type: 'button', className: 'nk-dlg-x', 'aria-label': closeLabel, textContent: '×' });
  const body = h('div', { className: 'nk-dlg-body' });
  const footer = h('div', { className: 'nk-dlg-foot' });
  const element = h('div', {
    className: `nk-dlg${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1',
  }, h('div', { className: 'nk-dlg-head' }, heading, closeButton), body, footer);
  const backdrop = h('div', { className: 'nk-dlg-backdrop' }, element);

  let open = true;
  function close(result) {
    if (!open) return;
    open = false;
    backdrop.remove();
    try { onClose?.(result); } catch (error) { console.warn('[nakliamp] dialog onClose failed', error); }
    if (opener && typeof opener.focus === 'function' && opener.isConnected) opener.focus();
    resolveClosed(result);
  }

  closeButton.addEventListener('click', () => close(undefined));
  backdrop.addEventListener('mousedown', event => { if (closeOnBackdrop && event.target === backdrop) close(undefined); });
  element.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(undefined);
      return;
    }
    if (event.key !== 'Tab') return;
    const target = trapTarget(focusables(element), document.activeElement, event.shiftKey);
    if (target === 'container') { event.preventDefault(); element.focus(); }
    else if (target) { event.preventDefault(); target.focus(); }
  });
  // Keys typed inside a dialog belong to it, not to the page's single-letter shortcuts.
  element.addEventListener('keyup', event => event.stopPropagation());

  (layer ?? document.body).append(backdrop);
  queueMicrotask(() => {
    const first = focusables(body)[0] ?? focusables(element)[0] ?? element;
    first.focus();
  });
  return { element, body, footer, heading, close, closed };
}

/**
 * Mount a panel inside a modal. `mount` is a mount<Name>(root, ctx) function.
 * Returns { dialog, panel, close }. Closing destroys the panel.
 */
export function mountInDialog(mount, ctx, { title, layer = null, wide = false, state } = {}) {
  let panel = null;
  const dialog = openDialog({
    title, layer, wide,
    onClose: () => { try { panel?.destroy(); } catch (error) { console.warn('[nakliamp] panel destroy failed', error); } },
  });
  panel = mount(dialog.body, { ...ctx, close: () => dialog.close(), dialog });
  if (state !== undefined) panel.update?.(state);
  return { dialog, panel, close: () => dialog.close() };
}

/**
 * Plain lines for a destructive command's confirm step. Accepts the shapes the
 * panels and the tags module produce: { lines, notes, files: [{ name, lines, notes, skipped }] }
 * or a plain string or array.
 */
export function confirmSections(diff) {
  if (diff === null || diff === undefined) return [];
  if (typeof diff === 'string') return [{ heading: null, lines: [diff], kind: 'change' }];
  if (Array.isArray(diff)) return [{ heading: null, lines: diff.map(String), kind: 'change' }];
  return [...summarySections(diff), ...fileSections(diff.files ?? [])];
}

function summarySections(diff) {
  const sections = [];
  const notes = diff.notes ?? [];
  if (diff.summary) sections.push({ heading: null, lines: [String(diff.summary)], kind: 'summary' });
  const lines = (diff.lines ?? []).filter(line => !notes.includes(line));
  if (lines.length) sections.push({ heading: diff.linesHeading ?? null, lines, kind: 'change' });
  if (notes.length) sections.push({ heading: 'Notes', lines: notes.map(String), kind: 'note' });
  return sections;
}

function fileSections(files) {
  const sections = files
    .filter(file => !file.skipped && file.lines?.length)
    .map(file => ({ heading: file.name, lines: file.lines.map(String), kind: 'change' }));
  const skipped = files.filter(file => file.skipped);
  if (skipped.length) {
    sections.push({ heading: 'Skipped', lines: skipped.map(file => `${file.name}: ${file.reason ?? 'cannot be written'}`), kind: 'note' });
  }
  return sections;
}

function renderConfirmBody(body, sections, label) {
  if (!sections.length) body.append(h('p', { textContent: `${label} cannot be undone from NakliAmp. Go ahead?` }));
  for (const section of sections) {
    if (section.heading) body.append(h('h3', { textContent: section.heading }));
    if (section.kind === 'summary') body.append(h('p', { textContent: section.lines[0] }));
    else body.append(h('ul', { className: section.kind === 'note' ? 'note' : '' }, section.lines.map(line => h('li', { textContent: line }))));
  }
}

/**
 * The `confirm` for bindCommands: shows the diff and resolves true only on the
 * approve button. Usage: bindCommands(handlers, { confirm: confirmCommand }).
 */
function confirmLabels(label, diff, name) {
  return {
    title: diff?.title ?? `${label}?`,
    wide: Boolean(diff?.files?.length > 1),
    approveLabel: diff?.approveLabel ?? (name === 'track.edit_tags' ? 'Write tags' : label),
  };
}

export function confirmCommand({ label = 'Confirm', diff = null, name = '' } = {}, { layer = null } = {}) {
  const { title, wide, approveLabel } = confirmLabels(label, diff, name);
  const dialog = openDialog({ title, layer, wide });
  dialog.body.classList.add('nk-confirm');
  renderConfirmBody(dialog.body, confirmSections(diff), label);
  const cancel = h('button', { type: 'button', className: 'nk-btn', textContent: 'Cancel', onclick: () => dialog.close(false) });
  const approve = h('button', { type: 'button', className: 'nk-btn primary', textContent: approveLabel, onclick: () => dialog.close(true) });
  if (diff?.unchanged === true) approve.disabled = true;
  dialog.footer.append(cancel, approve);
  queueMicrotask(() => (approve.disabled ? cancel : approve).focus());
  return dialog.closed.then(result => result === true);
}
