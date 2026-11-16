// pip.mjs — the mini player in a Document Picture-in-Picture window (UX review, minor 5).
//
// Chromium (116 and later) offers `documentPictureInPicture.requestWindow()`, an
// always-on-top window that holds ordinary DOM from the opener. NakliAmp moves its player
// bar element into that window and back. Moving keeps every event listener on the bar's
// controls, and the shell finds those controls through references it took at start
// (index.html, `playerParts`), so the controls keep working in either document.
//
// The pop-out document gets clones of the page's style elements, the root element's
// theme (`data-theme` and the inline custom properties a NakliOS host theme sets), the
// `mini` layout class and a few rules of its own. A MutationObserver keeps the theme in
// step while the window is open. Closing the window, by its own close button or by
// `close()`, puts the bar back where it was. Media Session stays with the opener, so the
// system media keys keep working. Where the API is missing, `supported` is false and the
// shell hides the control.

export const PIP_SIZE = Object.freeze({ width: 380, height: 380 });

/** Classes the opener's root carries that the pop-out document must not copy. */
const OPENER_ONLY = new Set(['pip-out']);

/** Rules the pop-out document adds on top of the page's own CSS (the mini player rules). */
export const PIP_CSS = [
  'html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text)}',
  'html.pip-window .playerbar{max-width:none;width:100%;margin:0;border:0;border-radius:0;min-height:100vh;box-sizing:border-box;align-content:start}',
  'html.pip-window #mini-pop,html.pip-window #mini-pop:not([hidden]){display:none}',
  // A short pop-out window (Chrome remembers the size the person last gave it) drops the
  // visualiser strip first, so the controls always fit without scrolling.
  'html.pip-window .playerbar{gap:8px;padding:10px 12px}',
  '@media (max-height:330px){html.pip-window .playerbar .vis-slot-bar{display:none}}',
].join('\n');

/** True when this browser can open a Document Picture-in-Picture window. */
export function pipSupported(env = globalThis) {
  return typeof env?.documentPictureInPicture?.requestWindow === 'function';
}

/**
 * The root attributes the pop-out document takes from the opener's root: its theme,
 * its inline style (host theme tokens), and its classes minus the opener-only ones, plus
 * `extra`. Pure: works on plain `{ theme, style, classes }` records.
 */
export function pipRootAttributes({ theme = null, style = '', classes = [] } = {}, extra = ['mini', 'pip-window']) {
  const list = [...classes.filter(name => name && !OPENER_ONLY.has(name) && !extra.includes(name)), ...extra];
  return { theme, style: style || '', classes: list };
}

function readRoot(root) {
  return { theme: root.getAttribute('data-theme'), style: root.getAttribute('style') ?? '', classes: [...root.classList] };
}

function writeRoot(root, { theme, style, classes }) {
  if (theme) root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  if (style) root.setAttribute('style', style);
  else root.removeAttribute('style');
  root.className = classes.join(' ');
}

/** The style sources to clone into the pop-out document, in document order. */
export function styleSources(doc) {
  return [...doc.querySelectorAll('style, link[rel="stylesheet"]')];
}

/**
 * Pop `element` out into a Picture-in-Picture window and back.
 * `onOpen(win)` and `onClose()` let the shell repaint; `onKeydown` receives key presses
 * in the pop-out window, so shortcuts work there too. `open()` must run inside a click.
 */
export function createPopOut({
  element,
  env = globalThis,
  doc = env.document,
  size = PIP_SIZE,
  css = PIP_CSS,
  title = 'NakliAmp',
  onOpen = () => {},
  onClose = () => {},
  onKeydown = null,
} = {}) {
  if (!element) throw new TypeError('createPopOut needs the element to move');
  let win = null;
  let home = null;
  let observer = null;
  let opening = null;

  function mirrorTheme() {
    if (win) writeRoot(win.document.documentElement, pipRootAttributes(readRoot(doc.documentElement)));
  }

  function fill(next) {
    const pipDoc = next.document;
    for (const node of styleSources(doc)) pipDoc.head.append(node.cloneNode(true));
    const own = pipDoc.createElement('style');
    own.id = 'nakliamp-css-pip';
    own.textContent = css;
    pipDoc.head.append(own);
    pipDoc.title = title;
    home = doc.createComment('nakliamp: the player bar returns here');
    element.before(home);
    pipDoc.body.append(element);
  }

  // Put the bar back. Runs once per window, from close() or the window's own pagehide.
  function restore() {
    if (!win) return false;
    const was = win;
    win = null;
    if (home) { home.replaceWith(element); home = null; }
    observer?.disconnect();
    observer = null;
    try { onClose(was); } catch (error) { console.warn('[nakliamp] pop-out close handler failed', error); }
    return true;
  }

  async function requestAndFill() {
    const next = await env.documentPictureInPicture.requestWindow({ width: size.width, height: size.height });
    win = next;
    fill(next);
    mirrorTheme();
    if (typeof env.MutationObserver === 'function') {
      observer = new env.MutationObserver(mirrorTheme);
      observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    }
    next.addEventListener('pagehide', restore, { once: true });
    if (typeof onKeydown === 'function') next.addEventListener('keydown', onKeydown);
    onOpen(next);
    return next;
  }

  return {
    get supported() { return pipSupported(env); },
    isOpen: () => win !== null,
    window: () => win,
    /** Open the window and move the element into it; resolves with the window. */
    async open() {
      if (win) return win;
      if (opening) return opening;
      if (!pipSupported(env)) throw new Error('This browser has no Document Picture-in-Picture.');
      opening = requestAndFill().finally(() => { opening = null; });
      return opening;
    },
    /** Move the element back and close the window. False when nothing was open. */
    close() {
      const was = win;
      if (!restore()) return false;
      try { was.close(); } catch { /* already closing */ }
      return true;
    },
  };
}
