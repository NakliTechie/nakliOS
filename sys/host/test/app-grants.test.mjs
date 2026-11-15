// Conformance — app-to-app command Grants (sys/host/app-grants.mjs): asked once per caller and target, refusal
// remembered and recorded, revocation takes effect at the next call, and every call is one History record.
//
//   node sys/host/test/app-grants.test.mjs

import assert from 'node:assert/strict';
import { createAppGrants, APP_GRANTS_KEY, APP_REVOKED_KEY } from '../app-grants.mjs';
import * as grantLib from '../../identity/grant.mjs';

const COMMANDS = {
  'books.passage': { scope: 'app:read', annotations: { app: 'books' } },
  'books.tag': { scope: 'app:write', annotations: { app: 'books' } },
  'lectella.notebook.list': { scope: 'app:read', annotations: { app: 'lectella' } },
  'kanzen.board.list': { scope: 'app:read', annotations: { app: 'kanzen' } },
};

function setup({ answers = [], clock = { t: 1000 }, consentMs } = {}) {
  const store = new Map();
  const storage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v) };
  const root = grantLib.newRootKey();
  const asked = []; const ran = []; const history = [];
  const grants = createAppGrants({
    storage, grantLib, rootKey: async () => root,
    confirm: async (caller, target) => { asked.push([caller, target]); const a = answers.shift(); if (typeof a === 'function') return a(); return a ?? false; },
    describe: name => COMMANDS[name],
    searchAll: async () => Object.entries(COMMANDS).map(([name, c]) => ({ name, app: c.annotations.app })),
    run: async (caller, name, input) => { ran.push([caller, name, input]); return { ok: true, result: { name } }; },
    record: event => { history.push(event); },
    now: () => clock.t, consentMs,
  });
  return { grants, store, asked, ran, history, clock };
}

// Grant: asked once, then reads run without asking again; History holds every call with the Grant id.
{
  const t = setup({ answers: [true] });
  const first = await t.grants.call('lectella', 'books.passage', { id: 'b1' });
  assert.equal(first.ok, true);
  const second = await t.grants.call('lectella', 'books.passage', { id: 'b2' });
  assert.equal(second.ok, true);
  assert.deepEqual(t.asked, [['lectella', 'books']], 'the person is asked once per caller and target');
  assert.equal(t.ran.length, 2);
  assert.equal(t.history.length, 2, 'every call is in History');
  assert.ok(t.history.every(e => e.caller === 'lectella' && e.target === 'books' && e.command === 'books.passage' && /^grant_/.test(e.grantId) && e.output.ok === true));
  const stored = JSON.parse(t.store.get(APP_GRANTS_KEY)).lectella.books;
  assert.deepEqual(grantLib.readCaveat(stored, 'principal'), 'app:lectella');
  assert.deepEqual(grantLib.readCaveat(stored, 'tools'), ['app.commands']);
  assert.equal(grantLib.readCaveat(stored, 'scope'), 'app:books');
  assert.equal(await t.grants.holds('lectella', 'books'), true);
  assert.equal(await t.grants.holds('books', 'lectella'), false, 'a Grant runs one way only');
  assert.equal(await t.grants.holds('lectella', 'kanzen'), false, 'a Grant covers one target only');
  // Search lists the caller's own commands and its granted targets', never the rest, and asks nothing.
  const listed = (await t.grants.search('lectella', '')).map(c => c.name).sort();
  assert.deepEqual(listed, ['books.passage', 'books.tag', 'lectella.notebook.list']);
  assert.equal(t.asked.length, 1);
}

// Concurrent calls share one dialog.
{
  let release; const gate = new Promise(r => { release = r; });
  const t = setup({ answers: [() => gate] });
  const a = t.grants.call('lectella', 'books.passage', {});
  const b = t.grants.call('lectella', 'books.passage', {});
  release(true);
  assert.deepEqual([(await a).ok, (await b).ok], [true, true]);
  assert.equal(t.asked.length, 1);
}

// Refusal: nothing runs, the decline is remembered (no second dialog), and both refusals are in History.
{
  const t = setup({ answers: [false, true] });
  const out = await t.grants.call('lectella', 'books.passage', {});
  assert.equal(out.ok, false); assert.equal(out.code, 'ENOGRANT');
  const again = await t.grants.call('lectella', 'books.passage', {});
  assert.equal(again.code, 'ENOGRANT');
  assert.equal(t.asked.length, 1, 'a decline is remembered until Settings forgets it');
  assert.equal(t.ran.length, 0, 'no command ran');
  assert.deepEqual(t.history.map(e => e.output), [{ ok: false, code: 'ENOGRANT' }, { ok: false, code: 'ENOGRANT' }]);
  assert.deepEqual(t.grants.list().map(r => [r.caller, r.target, r.allowed]), [['lectella', 'books', false]]);
  assert.deepEqual(await t.grants.search('lectella', '').then(l => l.map(c => c.name)), ['lectella.notebook.list']);
  // Forgetting the decline makes the next call ask again.
  t.grants.revoke('lectella', 'books');
  assert.equal((await t.grants.call('lectella', 'books.passage', {})).ok, true);
  assert.equal(t.asked.length, 2);
}

// Revocation: the identifier goes on the revocation list, an old copy of the Grant no longer verifies, the next call asks.
{
  const t = setup({ answers: [true, true, false] });
  await t.grants.call('lectella', 'books.passage', {});
  await t.grants.call('lectella', 'kanzen.board.list', {});
  const old = JSON.parse(t.store.get(APP_GRANTS_KEY));
  t.grants.revoke('lectella', 'books');
  assert.deepEqual(JSON.parse(t.store.get(APP_REVOKED_KEY)), [old.lectella.books.identifier]);
  assert.equal(await t.grants.holds('lectella', 'kanzen'), true, 'revoking one pair leaves the others');
  // A stored copy written back (for example by another tab) is refused at verification.
  t.store.set(APP_GRANTS_KEY, JSON.stringify(old));
  assert.equal(await t.grants.holds('lectella', 'books'), false);
  const refused = await t.grants.call('lectella', 'books.passage', {});
  assert.equal(refused.code, 'ENOGRANT'); assert.match(refused.message, /revoked/);
  t.grants.revokeAll();
  assert.equal(t.grants.count(), 0);
  const asks = t.asked.length;
  const after = await t.grants.call('lectella', 'books.passage', {});
  assert.equal(t.asked.length, asks + 1, 'after revocation the person is asked again');
  assert.equal(after.code, 'ENOGRANT');
}

// The caller's own commands need no Grant; an unknown command is ENOENT and runs nothing.
{
  const t = setup();
  assert.equal((await t.grants.call('lectella', 'lectella.notebook.list', {})).ok, true);
  assert.equal(t.asked.length, 0);
  assert.equal((await t.grants.call('lectella', 'nope.thing', {})).code, 'ENOENT');
  assert.equal(t.ran.length, 1);
}

// A late Allow keeps the Grant but runs nothing now; a caller whose window closed runs nothing.
{
  const clock = { t: 0 };
  const t = setup({ clock, consentMs: 100, answers: [() => { clock.t = 500; return true; }] });
  const late = await t.grants.call('lectella', 'books.passage', {});
  assert.equal(late.code, 'ETIMEOUT'); assert.equal(t.ran.length, 0);
  assert.equal(await t.grants.holds('lectella', 'books'), true);
  assert.equal((await t.grants.call('lectella', 'books.passage', {})).ok, true);
  const t2 = setup({ answers: [true] });
  assert.equal((await t2.grants.call('lectella', 'books.passage', {}, () => false)).code, 'ETIMEOUT');
  assert.equal(t2.ran.length, 0);
}

// A write command goes to the host's run path (which asks once per visit) only after the Grant.
{
  const t = setup({ answers: [true] });
  await t.grants.call('lectella', 'books.tag', { tag: 'x' });
  assert.deepEqual(t.ran, [['lectella', 'books.tag', { tag: 'x' }]]);
}

console.log('app-grants: ok');
