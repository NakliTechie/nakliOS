// Follow-ups (apps/followups/core.mjs) on Emergic's shared follow-ups corpus with a fixed clock: promises found by the
// rules become follow-ups, a second read adds nothing, a later reply in the thread closes them, typed ones get their
// day from the rules, and the desktop card counts what is late and due. Dates never come from a model. B6 in
// plan/2026-11-22-emergic-on-naklios-workplan.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEmergicRules } from '../sys/emergic-rules/rules.mjs';
import * as F from '../apps/followups/core.mjs';

const root = new URL('../', import.meta.url);
const rules = await loadEmergicRules(await readFile(new URL('sys/emergic-rules/emergic-rules.wasm', root)));
const corpus = JSON.parse(await readFile(new URL('sys/emergic-rules/test/fixtures/promises_labelled.json', root), 'utf8'));
const TODAY = '2026-10-16', NOW = Date.parse('2026-10-16T09:00:00+05:30');

// What Mail's mail.read answers for one fixture row (Mail runs the same rules on the same fields).
function mailRead(row, i, extra = {}) {
  const promises = rules.promisesIn({ from: row.from, to: row.to, reply_to: '', body: row.body, sent_on: row.sent.slice(0, 10) }, corpus.me)
    .map(({ direction, who, what, due, inferred }) => ({ direction, who, what, due, inferred }));
  return { id: `m${i}`, threadId: `t${i}`, from: row.from, subject: `Row ${i}`, date: `${row.sent}:00+05:30`, text: row.body, me: corpus.me, promises, ...extra };
}

test('every labelled promise in the corpus becomes one open follow-up with the labelled day', () => {
  let store = [], expected = 0;
  corpus.rows.forEach((row, i) => {
    const found = F.fromMail(mailRead(row, i), NOW);
    assert.deepEqual(found.map(f => [f.direction, f.due]), row.expect.map(e => [e.direction, e.due]), `row ${i}: ${row.body}`);
    store = F.merge(store, found).items;
    expected += row.expect.length;
  });
  assert.equal(store.length, expected);
  assert.ok(expected >= 20, `the corpus carries ${expected} promises`);
  assert.ok(store.every(f => f.status === 'open' && f.source.kind === 'mail'));
  // A second read of the same mail adds nothing.
  const again = F.merge(store, corpus.rows.flatMap((row, i) => F.fromMail(mailRead(row, i), NOW + 1)));
  assert.equal(again.added, 0);
});

test('buckets sort open follow-ups by their day against a fixed today', () => {
  const store = corpus.rows.flatMap((row, i) => F.fromMail(mailRead(row, i), NOW));
  const b = F.buckets(store, TODAY);
  assert.ok(b.overdue.every(f => f.due < TODAY) && b.today.every(f => f.due === TODAY) && b.upcoming.every(f => f.due > TODAY));
  assert.equal(b.overdue.length + b.today.length + b.upcoming.length + b.undated.length, store.length);
  for (const list of [b.overdue, b.upcoming]) assert.deepEqual(list.map(f => f.due), [...list.map(f => f.due)].sort());
  const card = F.dueCard(store, TODAY);
  assert.equal(card.heading, `${b.overdue.length + b.today.length} due, ${b.overdue.length} late`);
  assert.ok(card.items.length <= 6);
  assert.match(card.items[0], /^Late · /);
  assert.deepEqual(F.dueCard([], TODAY), { heading: 'Nothing due', items: [], empty: 'Nothing due today' });
});

test('a later reply in the same thread closes what it answers; an earlier, other-thread or put-off reply does not', () => {
  const owed = mailRead({ from: 'Ravi Kumar <ravi@vendor.in>', to: ['chirag@atrium.in'], sent: '2026-10-15T10:00', body: 'Will share the revised quote by Monday.' }, 1);
  let store = F.fromMail(owed, NOW);
  assert.equal(store.length, 1);
  assert.equal(store[0].due, '2026-10-19');
  const reply = (body, extra = {}) => ({ id: 'r1', threadId: 't1', from: 'Ravi Kumar <ravi@vendor.in>', date: '2026-10-16T11:00:00+05:30', text: body, ...extra });
  assert.equal(F.applyReply(store, reply('Still working on it, small delay.'), corpus.me, rules, NOW).closed, 0);
  assert.equal(F.applyReply(store, reply('Attached is the revised quote.', { threadId: 't9' }), corpus.me, rules, NOW).closed, 0);
  assert.equal(F.applyReply(store, reply('Attached is the revised quote.', { date: '2026-10-14T11:00:00+05:30' }), corpus.me, rules, NOW).closed, 0);
  const done = F.applyReply(store, reply('Attached is the revised quote.'), corpus.me, rules, NOW);
  assert.equal(done.closed, 1);
  assert.equal(done.items[0].status, 'answered');
  assert.deepEqual(done.items[0].closedBy, { kind: 'mail', id: 'r1', from: 'Ravi Kumar <ravi@vendor.in>' });
  // A closed one stays closed when the same mail is read again.
  store = F.merge(done.items, F.fromMail(owed, NOW + 5)).items;
  assert.equal(store[0].status, 'answered');
});

test('typed follow-ups take their day from the rules; no day named means no date', () => {
  const f = F.typed('Send Ravi the PO by Friday', { today: TODAY, now: NOW, rules });
  assert.equal(f.direction, 'i_owe');
  assert.equal(f.due, '2026-10-16'); // 16 Oct 2026 is a Friday
  const next = F.typed('Ravi owes the balance statement next Monday', { today: TODAY, now: NOW + 1, rules, owed: true, who: 'Ravi Kumar <ravi@vendor.in>' });
  assert.equal(next.direction, 'owed_to_me');
  assert.equal(next.due, '2026-10-19');
  assert.equal(F.line(next), 'Ravi Kumar owes you: Ravi owes the balance statement next Monday');
  const none = F.typed('Call the bank about the locker', { today: TODAY, now: NOW + 2, rules });
  assert.equal(none.due, null);
  assert.throws(() => F.typed('   ', { today: TODAY, now: NOW, rules }), /Write what/);
});

test('the person closes with a status or their own word, and can reopen', () => {
  const f = F.typed('Pay the plumber by tomorrow', { today: TODAY, now: NOW, rules });
  let store = F.setStatus([f], f.key, 'done', { rules, now: NOW + 1 });
  assert.equal(store[0].status, 'done');
  store = F.setStatus(store, f.key, 'open', { rules, now: NOW + 2 });
  assert.equal(store[0].status, 'open');
  assert.equal(store[0].closedAt, undefined);
  assert.equal(F.setStatus(store, f.key, 'drop', { rules, now: NOW + 3 })[0].status, 'dropped');
  assert.throws(() => F.setStatus(store, f.key, 'maybe later', { rules, now: NOW }), /not done, dropped or open/);
  assert.throws(() => F.setStatus(store, 'nope', 'done', { rules, now: NOW }), /No follow-up/);
});

test('wiring: the page reads mail only through Mail\'s commands, asks no model, and every command has a handler', async () => {
  const html = await readFile(new URL('apps/followups/index.html', root), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('apps/followups/commands.json', root), 'utf8'));
  const host = await readFile(new URL('index.html', root), 'utf8');
  assert.match(html, /call\('mail\.mail\.search'/);
  assert.match(html, /call\('mail\.mail\.read'/);
  assert.doesNotMatch(html, /naklios\.ai|gmail\.googleapis|experimental_auth/);
  assert.match(html, /import\('\.\.\/\.\.\/sys\/emergic-rules\/rules\.mjs'\)/);
  assert.deepEqual(manifest.commands.map(c => c.name), ['followups.list', 'followups.add', 'followups.close', 'followups.check']);
  for (const c of manifest.commands) assert.ok(html.includes(`'${c.name}'`), `${c.name} has a handler`);
  assert.deepEqual(manifest.widgets.map(w => w.id), ['due']);
  assert.match(host, /\{ id:'followups', name:'Follow-ups', kind:'system',/);
  // Mail answers the thread id and the mailbox address that closing by reply needs.
  const mail = await readFile(new URL('apps/mail/index.html', root), 'utf8');
  assert.match(mail, /const row=m=>\(\{id:m\.id,threadId:m\.threadId,/);
  assert.match(mail, /return\{\.\.\.row\(msg\),me,/);
});
