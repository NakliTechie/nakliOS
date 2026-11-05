// Conformance — desktop widgets (sys/host/widgets.mjs): fixed templates, declared widgets only, and no Crate data on disk.
//
//   node sys/host/test/widgets.test.mjs

import assert from 'node:assert/strict';
import { createWidgetBoard, parseWidgets, cleanSnapshot, MAX_ITEMS } from '../widgets.mjs';

// The few DOM calls the board makes.
function element(tag) {
  const el = { tag, className: '', dataset: {}, children: [], textContent: '', hidden: false, listeners: {},
    ownerDocument: { createElement: element },
    append(...kids) { el.children.push(...kids); }, replaceChildren(...kids) { el.children = kids; },
    addEventListener(type, fn) { el.listeners[type] = fn; } };
  return el;
}
const texts = el => [el.textContent, ...el.children.flatMap(texts)].filter(Boolean);

assert.equal(parseWidgets([{ id: 'x', title: 'X', display: 'html' }]).error, 'x: display must be list, agenda, value');
assert.match(parseWidgets([{ id: '../x', title: 'X', display: 'list' }]).error, /invalid widget id/);
assert.deepEqual(parseWidgets(undefined), { widgets: [] });

const clean = cleanSnapshot('list', { items: Array(12).fill('<img src=x onerror=alert(1)>'), html: '<b>', heading: 'H' });
assert.equal(clean.items.length, MAX_ITEMS); assert.equal(clean.more, 4); assert.ok(!('html' in clean));

let saved = {}; let opened = null; let clock = 1000;
const make = () => { const root = element('div'); return { root, board: createWidgetBoard({
  root, load: async () => saved, save: async (key, value) => { if (value) saved[key] = structuredClone(value); else delete saved[key]; }, open: id => { opened = id; }, now: () => clock }) }; };

{
  const { root, board } = make();
  board.declare('calendar', 'Calendar', [{ id: 'today', title: 'Today', display: 'agenda' }]);
  assert.equal(root.hidden, true, 'no snapshot, no card');
  assert.equal(board.update('calendar', 'other', {}).ok, false, 'only a declared widget');
  assert.equal(board.update('notes', 'today', {}).ok, false, 'an app cannot publish another app\'s widget');
  board.update('calendar', 'today', { items: [{ time: '09:30', title: 'Dentist' }], expires: 2000 });
  await board.flush();
  assert.deepEqual(texts(root.children[0]), ['Today', '09:30', 'Dentist']);
  root.children[0].listeners.click();
  assert.equal(opened, 'calendar');
  assert.ok(saved['calendar/today'], 'a normal snapshot is saved');
}
{
  const { root, board } = make();
  board.declare('calendar', 'Calendar', [{ id: 'today', title: 'Today', display: 'agenda' }]);
  await board.restore();
  assert.deepEqual(texts(root.children[0]), ['Today', '09:30', 'Dentist'], 'the card returns after a reload with the app closed');
  clock = 3000; board.setEnabled(true);
  assert.deepEqual(texts(root.children[0]), ['Today', 'Open Calendar to update'], 'an old day is not shown as today');
  board.update('calendar', 'today', { items: [{ time: '10:00', title: 'Secret' }] }, { persist: false });
  await board.flush();
  assert.equal(saved['calendar/today'], undefined, 'memory-only data leaves nothing on disk');
  assert.deepEqual(texts(root.children[0]), ['Today', '10:00', 'Secret']);
  board.dropMemoryOnly();
  assert.equal(root.hidden, true, 'Crate locks and the card goes');
  board.update('calendar', 'today', { items: [] });
  board.setEnabled(false); await board.flush();
  assert.deepEqual(saved, {}, 'turning widgets off removes the saved copies');
  assert.equal(root.hidden, true);
}
{
  // Two tabs: each writes only its own key, so neither loses the other's widget.
  saved = { 'notes/list': { data: { heading: 'From the other tab', items: [] }, at: 1 } };
  const { board } = make();
  board.declare('calendar', 'Calendar', [{ id: 'today', title: 'Today', display: 'agenda' }]);
  board.update('calendar', 'today', { items: [] }); await board.flush();
  assert.ok(saved['notes/list'] && saved['calendar/today']);
  board.setEnabled(false);
}
console.log('widgets: PASS');
