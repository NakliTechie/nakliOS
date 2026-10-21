// The status strip at the foot of the page, and the global error surface.
//
// Every failure has to show up here. A core flow that fails silently is worse than one that
// fails loudly, so uncaught errors and rejected promises are caught at the window level and
// written to the same strip the app uses for ordinary progress messages.

const el = () => document.getElementById('status');

let stickyError = false;

function write(kind, text, detail) {
  const node = el();
  if (!node) return;
  node.className = 'show' + (kind ? ' ' + kind : '');
  node.textContent = text;
  if (detail) {
    const span = document.createElement('span');
    span.className = 'detail';
    span.textContent = ' — ' + detail;
    node.appendChild(span);
  }
}

/** Progress message, replaced by the next call. */
export function busy(text) {
  if (stickyError) return;
  write('busy', text);
}

/** Neutral message that stays until something replaces it. */
export function info(text) {
  if (stickyError) return;
  write('', text);
}

/** Something to be aware of, but the action succeeded. */
export function warn(text, detail) {
  if (stickyError) return;
  write('warn', text, detail);
}

/** The action failed. Sticks until `clear()` so a later success cannot hide it. */
export function fail(text, detail) {
  stickyError = true;
  write('err', text, detail);
}

export function clear() {
  stickyError = false;
  const node = el();
  if (node) { node.className = ''; node.textContent = ''; }
}

function describe(value) {
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

/** Route uncaught errors to the strip. Call once, as early as possible. */
export function installGlobalErrorSurface() {
  window.addEventListener('error', (e) => {
    const where = e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : 'unknown location';
    fail('Something broke and the app may be in a bad state.', `${describe(e.error || e.message)} (${where})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    fail('An operation failed and nothing handled it.', describe(e.reason));
  });
}
