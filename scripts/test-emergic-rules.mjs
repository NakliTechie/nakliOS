// Emergic's common rules as WebAssembly (sys/emergic-rules): every row of Emergic's shared follow-ups
// corpus (copied from the emergic repo, tests/fixtures/followups at d50c085) gives the same answer
// through the wasm as the crate's own tests/corpus.rs requires. This is the B3 verifier in
// plan/2026-11-22-emergic-on-naklios-workplan.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadEmergicRules } from '../sys/emergic-rules/rules.mjs';

const root = new URL('../sys/emergic-rules/', import.meta.url);
const rules = await loadEmergicRules(await readFile(new URL('emergic-rules.wasm', root)));
const load = async name => JSON.parse(await readFile(new URL('test/fixtures/' + name, root), 'utf8'));
const day = s => String(s).slice(0, 10);

// What promisesIn finds in one corpus message, in Vaak's record shape (corpus.rs `found`).
function found(m, me) {
  const mail = { from: m.from || '', to: m.to || [], reply_to: '', body: m.body || '', sent_on: day(m.sent) };
  return rules.promisesIn(mail, me).map(p => {
    assert.ok(mail.body.slice(p.quote_start, p.quote_end).startsWith(p.what.split(' ')[0]), `quote span for ${JSON.stringify(p.what)}`);
    return { direction: p.direction, who: p.who, what: p.what, due: p.due, inferred: p.inferred };
  });
}

test('deadline words name the day, in meetings and in mail', async () => {
  const d = await load('dates.json');
  const wrong = [];
  for (const [reading, read] of [['meeting', rules.due], ['mail', rules.dueInMail]]) {
    for (const r of d[reading]) {
      const got = read(r.words, day(r.day));
      const want = r.due == null ? null : { due: r.due, inferred: r.inferred };
      if (JSON.stringify(got) !== JSON.stringify(want)) wrong.push(`${reading} ${JSON.stringify(r.words)} on ${r.day}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }
  for (const w of d.has_time_words.yes) assert.equal(rules.hasTimeWords(w), true, w);
  for (const w of d.has_time_words.no) assert.equal(rules.hasTimeWords(w), false, w);
  assert.deepEqual(wrong, []);
  assert.ok(d.meeting.length + d.mail.length > 40, 'the corpus has its rows');
});

test('promises match the outside labels and Vaak, on all 52 labelled sentences', async () => {
  const d = await load('promises_labelled.json');
  const label = [], parity = [];
  for (const r of d.rows) {
    const got = found(r, d.me);
    const short = got.map(p => ({ direction: p.direction, due: p.due }));
    if (JSON.stringify(short) !== JSON.stringify(r.expect)) label.push(`${JSON.stringify(r.body)}: got ${JSON.stringify(short)}, want ${JSON.stringify(r.expect)}`);
    if (JSON.stringify(got) !== JSON.stringify(r.vaak)) parity.push(`${JSON.stringify(r.body)}: got ${JSON.stringify(got)}, vaak ${JSON.stringify(r.vaak)}`);
  }
  assert.equal(d.rows.length, 52);
  assert.deepEqual(label, []);
  assert.deepEqual(parity, []);
});

test('labelled mail gives the promises Vaak gave', async () => {
  const d = await load('mail_labelled.json');
  const rows = [...d.pileups, ...d.bills, ...d.receipts.flatMap(c => c.messages)];
  const wrong = rows.map(m => ({ m, got: found(m, d.me) }))
    .filter(({ m, got }) => JSON.stringify(got) !== JSON.stringify(m.vaak_promises))
    .map(({ m, got }) => `${m.id}: got ${JSON.stringify(got)}, vaak ${JSON.stringify(m.vaak_promises)}`);
  assert.ok(rows.length > 70, `${rows.length} messages`);
  assert.deepEqual(wrong, []);
});

test('closing a promise: a reply from the owing side closes it, a put-off does not, and the person\'s own words', () => {
  const [p] = rules.promisesIn({ from: 'Ravi Kumar <ravi@vendor.in>', to: ['chirag@atrium.in'], reply_to: '', body: 'Will send the revised quote by Friday.', sent_on: '2026-11-19' }, 'chirag@atrium.in');
  assert.equal(p.direction, 'owed_to_me');
  assert.equal(p.due, '2026-11-20');
  assert.equal(rules.closes(p, { from: 'Ravi Kumar <ravi@vendor.in>', body: 'Attached is the revised quote.', draft: false }, 'chirag@atrium.in'), 'answered');
  assert.equal(rules.closes(p, { from: 'Ravi Kumar <ravi@vendor.in>', body: 'Still working on it, small delay.', draft: false }, 'chirag@atrium.in'), null);
  assert.equal(rules.closes(p, { from: 'Ravi Kumar <ravi@vendor.in>', body: 'Attached.', draft: true }, 'chirag@atrium.in'), null);
  assert.equal(rules.closedFromWord('Done'), 'done');
  assert.equal(rules.closedFromWord('drop'), 'dropped');
  assert.equal(rules.closedFromWord('later'), null);
});

test('reminder moments, and a bad request is an error the page can read, not a crash', () => {
  assert.equal(rules.when('tomorrow at 3pm', '2026-11-23T10:00'), '2026-11-24T15:00');
  assert.equal(rules.when('in 20 minutes', '2026-11-23T10:00'), '2026-11-23T10:20');
  assert.equal(rules.when('whenever', '2026-11-23T10:00'), null);
  assert.throws(() => rules.due('by Friday', 'not a day'), /not a YYYY-MM-DD day/);
  assert.throws(() => rules.promisesIn({ body: 'x' }, 'me@x.in'), /mail:/);
  assert.throws(() => rules.closes({ direction: 'sideways', due: '2026-11-20' }, { from: 'a@b.c', body: '' }, 'me@x.in'), /i_owe or owed_to_me/);
  // A body with characters outside the Basic Multilingual Plane: the quote offsets index the JS string.
  const body = 'Namaste 🙏 team. I will share the deck by Monday.';
  const [p] = rules.promisesIn({ from: 'chirag@atrium.in', to: ['ravi@vendor.in'], reply_to: '', body, sent_on: '2026-11-19' }, 'chirag@atrium.in');
  assert.equal(p.direction, 'i_owe');
  assert.ok(body.slice(p.quote_start, p.quote_end).startsWith('I will share'), body.slice(p.quote_start, p.quote_end));
});

test('provenance: build.json names the crate commit and matches the committed wasm', async () => {
  const { createHash } = await import('node:crypto');
  const build = JSON.parse(await readFile(new URL('build.json', root), 'utf8'));
  const wasm = await readFile(new URL('emergic-rules.wasm', root));
  assert.equal(build.bytes, wasm.length);
  assert.equal(build.sha256, createHash('sha256').update(wasm).digest('hex'));
  const cargo = await readFile(new URL('crate/Cargo.toml', root), 'utf8');
  assert.match(cargo, new RegExp(`rev = "${build.rev}"`));
});
