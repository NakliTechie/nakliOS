// Google Calendar in the NakliOS Calendar (apps/calendar/google.js): mapping both ways, the client's paging, its one
// retry on 401, deletes that answer 204, and the page and command wiring. No network: fetch is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const context = vm.createContext({ Intl, Date, Math, URLSearchParams, JSON, crypto: globalThis.crypto });
vm.runInContext(await readFile(new URL('apps/calendar/core.js', root), 'utf8'), context);
vm.runInContext(await readFile(new URL('apps/calendar/google.js', root), 'utf8'), context);
const Core = context.CalendarCore, G = context.CalendarGoogle;
const plain = v => JSON.parse(JSON.stringify(v));

test('fromGoogle: a timed event lands on wall time in its own zone, with a g: id and its source', () => {
  const e = G.fromGoogle({ id: 'abc', summary: 'Standup', start: { dateTime: '2026-11-23T10:00:00+05:30', timeZone: 'Asia/Kolkata' },
    end: { dateTime: '2026-11-23T10:15:00+05:30', timeZone: 'Asia/Kolkata' }, location: 'Room 2' }, 'UTC', Core);
  assert.equal(e.id, 'g:abc');
  assert.equal(e.googleId, 'abc');
  assert.equal(e.source, 'google');
  assert.equal(e.startLocal, '2026-11-23T10:00');
  assert.equal(e.endLocal, '2026-11-23T10:15');
  assert.equal(e.timeZone, 'Asia/Kolkata');
  assert.equal(e.allDay, false);
});

test('fromGoogle: all-day keeps Google\'s exclusive end date; cancelled instances and missing starts are dropped', () => {
  const e = G.fromGoogle({ id: 'd', summary: 'Holiday', start: { date: '2026-12-25' }, end: { date: '2026-12-26' } }, 'Asia/Kolkata', Core);
  assert.equal(e.allDay, true);
  assert.equal(e.startLocal, '2026-12-25');
  assert.equal(e.endLocal, '2026-12-26');
  assert.equal(G.fromGoogle({ id: 'x', status: 'cancelled', start: { date: '2026-12-25' } }, 'UTC', Core), null);
  assert.equal(G.fromGoogle({ id: 'y' }, 'UTC', Core), null);
});

test('fromGoogle: an event with no zone takes the default; a missing title reads "(no title)"', () => {
  const e = G.fromGoogle({ id: 'z', start: { dateTime: '2026-11-23T04:30:00Z' }, end: { dateTime: '2026-11-23T05:30:00Z' } }, 'Asia/Kolkata', Core);
  assert.equal(e.timeZone, 'Asia/Kolkata');
  assert.equal(e.startLocal, '2026-11-23T10:00');
  assert.equal(e.title, '(no title)');
});

test('toGoogle: timed events send wall time plus zone; all-day sends dates; a local rule becomes an RRULE', () => {
  const timed = plain(G.toGoogle({ title: 'Dentist', startLocal: '2026-11-24T15:00', endLocal: '2026-11-24T16:00', timeZone: 'Asia/Kolkata', allDay: false,
    recurrence: { frequency: 'weekly', interval: 2, until: '2027-01-31' } }));
  assert.deepEqual(timed.start, { dateTime: '2026-11-24T15:00:00', timeZone: 'Asia/Kolkata' });
  assert.deepEqual(timed.recurrence, ['RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20270131T235959Z']);
  const day = plain(G.toGoogle({ title: 'Trip', startLocal: '2026-12-01', endLocal: '2026-12-03', allDay: true, recurrence: { frequency: 'none' } }));
  assert.deepEqual(day.start, { date: '2026-12-01' });
  assert.deepEqual(day.end, { date: '2026-12-03' });
  assert.equal(day.recurrence, undefined);
});

test('toGoogle: editing one occurrence of a Google series never sends a rule', () => {
  const body = plain(G.toGoogle({ title: 'Standup', startLocal: '2026-11-24T10:00', endLocal: '2026-11-24T10:15', timeZone: 'UTC', allDay: false,
    recurringEventId: 'series1', recurrence: { frequency: 'daily' } }));
  assert.equal(body.recurrence, undefined);
});

function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization, body: init.body });
    const r = routes(url, init, calls.length);
    return { status: r.status ?? 200, ok: (r.status ?? 200) < 400, text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)) };
  };
  return { fetchFn, calls };
}

test('client.list follows nextPageToken and asks for single instances in the range', async () => {
  const { fetchFn, calls } = fakeFetch(url => url.includes('pageToken=p2')
    ? { json: { items: [{ id: 'b' }] } }
    : { json: { items: [{ id: 'a' }], nextPageToken: 'p2' } });
  const client = G.createClient({ getToken: async () => 't1', fetchFn });
  const items = await client.list(Date.parse('2026-11-01T00:00:00Z'), Date.parse('2026-12-01T00:00:00Z'));
  assert.deepEqual(plain(items.map(i => i.id)), ['a', 'b']);
  assert.match(calls[0].url, /singleEvents=true/);
  assert.match(calls[0].url, /timeMin=2026-11-01T00%3A00%3A00.000Z/);
  assert.equal(calls[0].auth, 'Bearer t1');
});

test('client retries once with a fresh token on 401, then reports Google\'s message on failure', async () => {
  const fresh = [];
  const { fetchFn, calls } = fakeFetch((url, init, n) => n === 1 ? { status: 401, json: { error: { message: 'expired' } } } : { json: { id: 'new' } });
  const client = G.createClient({ getToken: async ({ fresh: f }) => { fresh.push(f); return f ? 't2' : 't1'; }, fetchFn });
  const out = await client.insert({ title: 'X', startLocal: '2026-11-24T10:00', endLocal: '2026-11-24T11:00', timeZone: 'UTC', allDay: false, recurrence: {} });
  assert.equal(out.id, 'new');
  assert.deepEqual(fresh, [false, true]);
  assert.deepEqual(calls.map(c => c.auth), ['Bearer t1', 'Bearer t2']);
  const bad = G.createClient({ getToken: async () => 't', fetchFn: fakeFetch(() => ({ status: 403, json: { error: { message: 'Insufficient Permission' } } })).fetchFn });
  await assert.rejects(bad.remove('e1'), /403: Insufficient Permission/);
});

test('client.remove accepts 204 with no body; patch addresses the event by id', async () => {
  const { fetchFn, calls } = fakeFetch((url, init) => init.method === 'DELETE' ? { status: 204 } : { json: { id: 'e/1' } });
  const client = G.createClient({ getToken: async () => 't', fetchFn });
  assert.equal(await client.remove('e1'), null);
  await client.patch('e/1', { title: 'Y', startLocal: '2026-11-24T10:00', endLocal: '2026-11-24T11:00', timeZone: 'UTC', allDay: false, recurrence: {} });
  assert.match(calls[1].url, /events\/e%2F1$/);
  assert.equal(calls[1].method, 'PATCH');
});

test('wiring: the page loads google.js, asks only calendar.events, and the write commands take calendar', async () => {
  const html = await readFile(new URL('apps/calendar/index.html', root), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('apps/calendar/commands.json', root), 'utf8'));
  assert.match(html, /<script src="google\.js"><\/script>/);
  assert.deepEqual([...G.SCOPES], ['calendar.events']);
  for (const name of ['events.create', 'events.update', 'events.delete']) {
    const c = manifest.commands.find(x => x.name === name);
    assert.deepEqual(c.input.properties.calendar.enum, ['local', 'google'], name);
  }
});
