// One labelled slider row. input → onInput(value) while dragging (callers coalesce it); a double click
// on the label resets to the default. A disabled slider keeps its row and says why in its tooltip.

import { h } from './dom.js';

const fmt = (v, step) => (step < 1 ? Number(v).toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v)));

export function slider({ label, min, max, step = 1, value = 0, def = 0, command, param, onInput, onCommit }) {
  let dragging = false;
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label, dataset: { command, param } });
  const out = h('output', {}, fmt(value, step));
  const name = h('span', { class: 'sl-name', title: 'Double-click to reset' }, label);
  const row = h('label', { class: 'sl' }, name, input, out);
  const emit = () => { out.textContent = fmt(input.value, step); onInput?.(Number(input.value)); };
  input.addEventListener('pointerdown', () => { dragging = true; });
  input.addEventListener('input', emit);
  input.addEventListener('change', () => { dragging = false; onCommit?.(Number(input.value)); });
  name.addEventListener('dblclick', (e) => { e.preventDefault(); if (input.disabled) return; input.value = def; emit(); onCommit?.(def); });
  return {
    el: row, input,
    get dragging() { return dragging || document.activeElement === input && input.matches(':active'); },
    set(v) { if (dragging) return; input.value = v; out.textContent = fmt(input.value, step); },
    disable(off, why) { input.disabled = off; row.classList.toggle('off', off); row.title = off ? why : ''; },
  };
}
