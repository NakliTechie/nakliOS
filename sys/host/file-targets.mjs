// "Open with" and "Send to" from what apps declare (common rail step 4, docs/file-handoff-v1.md). An app lists the file
// extensions it takes in commands.json under `accepts`; the host builds the menu from that, never from a fixed list.

export const ACCEPT_ACTIONS = Object.freeze(['edit', 'import']);
const EXTENSION = /^\.[a-z0-9]{1,12}$/;

const MIME = Object.freeze({
  '.pdf': 'application/pdf', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.md': 'text/markdown', '.txt': 'text/plain',
  '.json': 'application/json', '.ics': 'text/calendar', '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
});

export const extensionOf = name => /\.[^./]+$/.exec(String(name).toLowerCase())?.[0] || '';
export const mimeOf = name => MIME[extensionOf(name)] || 'application/octet-stream';

export function parseAccepts(defs) {
  if (defs === undefined) return { accepts: [] };
  if (!Array.isArray(defs)) return { error: 'accepts must be a list' };
  const accepts = [];
  for (const raw of defs) {
    if (!raw || !ACCEPT_ACTIONS.includes(raw.action)) return { error: `accepts action must be ${ACCEPT_ACTIONS.join(' or ')}` };
    if (!Array.isArray(raw.extensions) || !raw.extensions.length || !raw.extensions.every(e => EXTENSION.test(e))) return { error: 'accepts needs extensions such as ".pdf"' };
    if (typeof raw.label !== 'string' || !raw.label.trim()) return { error: 'accepts needs a label' };
    accepts.push({ action: raw.action, extensions: raw.extensions, label: raw.label.trim().slice(0, 40) });
  }
  return { accepts };
}

/** @param {string} name a file name @param {Array<{ id: string, name: string, accepts: object[] }>} apps */
export function targetsFor(name, apps) {
  const extension = extensionOf(name);
  return apps.flatMap(app => app.accepts.filter(accept => accept.extensions.includes(extension))
    .map(accept => ({ appId: app.id, name: app.name, action: accept.action, label: accept.label })));
}
