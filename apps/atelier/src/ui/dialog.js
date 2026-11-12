// Styled dialogs: Atelier never calls the browser's alert, confirm or prompt (NakliOS acceptance gate
// item 7). One modal at a time; Escape answers the cancel value. Each returns a promise of the answer.

import { h } from './dom.js';

export function createDialogs(root = document.body) {
  let chain = Promise.resolve();
  let openCount = 0;

  // body: a node; actions: [{ label, value, primary?, danger? }]; cancel: the value Escape answers.
  function open({ title, body, actions, cancel = null, onOpen }) {
    const run = () => new Promise((resolve) => {
      const dlg = h('dialog', { class: 'dlg', 'aria-label': title });
      const done = (v) => { dlg.close(); dlg.remove(); openCount--; resolve(v); };
      const form = h('form', { method: 'dialog', onsubmit: (e) => { e.preventDefault(); const p = actions.find((a) => a.primary); done(p ? (typeof p.value === 'function' ? p.value() : p.value) : cancel); } },
        h('h3', {}, title), body,
        h('div', { class: 'dlg-actions' }, actions.map((a) => h('button', {
          type: a.primary ? 'submit' : 'button', class: [a.primary ? 'primary' : '', a.danger ? 'danger' : ''].join(' ').trim() || null,
          dataset: { answer: String(a.label) },
          onclick: a.primary ? null : () => done(typeof a.value === 'function' ? a.value() : a.value),
        }, a.label))));
      dlg.append(form);
      dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(cancel); });
      root.append(dlg); openCount++;
      dlg.showModal();
      onOpen?.(dlg);
      (dlg.querySelector('[autofocus]') || dlg.querySelector('button.primary') || dlg.querySelector('button'))?.focus();
    });
    const p = chain.then(run);
    chain = p.catch(() => {});
    return p;
  }

  const text = (s) => h('p', {}, s);
  return {
    get open() { return openCount > 0; },
    raw: open,
    // A message with one OK button.
    info: (title, message) => open({ title, body: text(message), actions: [{ label: 'OK', value: true, primary: true }], cancel: true }),
    // Choices: [{ label, value, primary?, danger? }].
    ask: (title, message, choices, cancel = null) => open({ title, body: typeof message === 'string' ? text(message) : message, actions: choices, cancel }),
    // One text field; answers the string or null.
    promptText(title, label, value = '') {
      const input = h('input', { type: 'text', value, autofocus: true, 'aria-label': label });
      return open({ title, body: h('label', { class: 'field' }, h('span', {}, label), input), actions: [{ label: 'Cancel', value: null }, { label: 'OK', value: () => input.value, primary: true }], onOpen: () => input.select() });
    },
  };
}
