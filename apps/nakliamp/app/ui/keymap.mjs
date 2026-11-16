// keymap.mjs — the keyboard-map overlay (K2), generated from the command list.
// keymapRows() groups every shortcut in commands.mjs; a search box filters by
// action or key.

import { keymapRows } from '../commands/run.mjs';
import { GROUP_LABELS } from '../commands/commands.mjs';
import { h, injectCss, nextId } from './dialog.mjs';

// ---------------------------------------------------------------- pure ----

export const isMac = () => {
  try {
    const platform = globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? '';
    return /mac|iphone|ipad/i.test(platform);
  } catch { return false; }
};

/** Groups whose rows match `query` on the action, the group or a key; empty groups drop out. */
export function filterKeymap(groups, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map(group => {
      const groupHit = group.groupLabel.toLowerCase().includes(q);
      const rows = groupHit ? group.rows : group.rows.filter(row =>
        row.label.toLowerCase().includes(q) || row.keys.some(key => key.toLowerCase() === q || key.toLowerCase().includes(q)));
      return { ...group, rows };
    })
    .filter(group => group.rows.length);
}

// ------------------------------------------------------------------ CSS ----

const CSS = `
.nk-keys,.nk-keys *{box-sizing:border-box}
.nk-keys{--c-ink:var(--ink,var(--text));color:var(--c-ink);display:grid;gap:12px;min-width:0}
.nk-keys input[type=search]{width:100%;min-height:36px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel-2);color:var(--c-ink);font:inherit}
.nk-keys .groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px}
.nk-keys section{border:1px solid var(--line);border-radius:12px;background:var(--panel-2);padding:10px 12px;min-width:0}
.nk-keys h3{margin:0 0 6px;font-size:13px;color:var(--accent)}
.nk-keys dl{display:grid;grid-template-columns:auto 1fr;gap:5px 12px;margin:0;align-items:baseline}
.nk-keys dt{white-space:nowrap}
.nk-keys dd{margin:0;font-size:13px;overflow-wrap:anywhere;min-width:0}
.nk-keys kbd{font:11px var(--mono,monospace);padding:2px 6px;border:1px solid var(--line);border-bottom-width:2px;border-radius:5px;background:var(--panel);color:var(--c-ink)}
.nk-keys .none{color:var(--muted)}
.nk-keys .hint{color:var(--muted);font-size:12px;margin:0}
`;

// ------------------------------------------------------------------- UI ----

export function mountKeymap(root) {
  injectCss('keymap', CSS);
  const id = nextId('keys');
  const groups = keymapRows({ mac: isMac(), groupLabels: GROUP_LABELS });
  const search = h('input', { type: 'search', id: `${id}-q`, placeholder: 'Find a shortcut', 'aria-label': 'Find a shortcut', autocomplete: 'off' });
  const output = h('div', { className: 'groups' });
  const count = h('p', { className: 'hint', role: 'status', 'aria-live': 'polite' });
  const container = h('div', { className: 'nk-keys' }, search, count, output,
    h('p', { className: 'hint', textContent: 'Shortcuts do nothing while you type in a text box. Press Esc to close this list.' }));
  root.append(container);

  function render() {
    const shown = filterKeymap(groups, search.value);
    const rows = shown.reduce((n, g) => n + g.rows.length, 0);
    count.textContent = search.value.trim() ? `${rows} shortcut${rows === 1 ? '' : 's'} match.` : '';
    if (!shown.length) { output.replaceChildren(h('p', { className: 'none', textContent: 'No shortcut matches that.' })); return; }
    output.replaceChildren(...shown.map(group => {
      const headingId = nextId('keys-g');
      return h('section', { 'aria-labelledby': headingId },
        h('h3', { id: headingId, textContent: group.groupLabel }),
        h('dl', {}, group.rows.flatMap(row => [
          h('dt', {}, row.keys.flatMap((key, i) => [i ? ' or ' : null, h('kbd', { textContent: key })])),
          h('dd', { textContent: row.label }),
        ])));
    }));
  }

  search.addEventListener('input', render);
  render();

  return {
    update(state) {
      if (state && typeof state.query === 'string') { search.value = state.query; render(); }
    },
    destroy() { container.remove(); },
  };
}
