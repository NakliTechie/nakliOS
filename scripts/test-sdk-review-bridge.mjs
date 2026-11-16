import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sdk = readFileSync(new URL('../sdk/naklios.js', import.meta.url), 'utf8');

function frame(hosted) {
  const sent = [];
  let listener;
  const parent = { postMessage(message) { sent.push(message); } };
  const window = {
    parent: hosted ? parent : null,
    location: { search: '' },
    addEventListener(type, callback) { if (type === 'message') listener = callback; },
  };
  if (!hosted) window.parent = window;
  vm.runInNewContext(sdk, { URL, window, document: {}, URLSearchParams, Set, Map, Promise,
    Object, Error, Date, setTimeout: () => 0, clearTimeout: () => {} });
  return { window, sent, parent, fromHost(data, source = parent, origin = 'https://naklios.dev') {
    listener({ data, source, origin });
  } };
}

const standalone = frame(false);
assert.deepEqual(JSON.parse(JSON.stringify(await standalone.window.naklios.review.stage('edit', {}))),
  { standalone: true, proposal_id: null });

const app = frame(true);
app.fromHost({ type: 'naklios:capabilities', review: true });
assert.equal(app.window.naklios.capabilities.review, true);

let decisions = 0;
app.window.naklios.review.onDecision(({ type, proposal_id }) => {
  decisions++;
  assert.equal(proposal_id, 'prop_demo');
  assert.ok(type === 'commit' || type === 'discard');
  return { ok: true };
});

const pending = app.window.naklios.review.stage('reckon.transaction', { ops: [] }, { reversible: true });
const request = app.sent.at(-1);
assert.equal(request.type, 'naklios:review:stage');
assert.equal(request.reversible, true);
app.fromHost({ type: 'naklios:review:reply', requestId: request.requestId, result: { proposal_id: 'prop_demo' } });
assert.equal((await pending).proposal_id, 'prop_demo');

app.fromHost({ type: 'naklios:review:commit', proposal_id: 'prop_demo' }, {});
assert.equal(decisions, 0, 'a foreign frame cannot commit');
app.fromHost({ type: 'naklios:review:commit', proposal_id: 'prop_demo' }, app.parent, 'https://other.example');
assert.equal(decisions, 0, 'a different origin cannot commit');
app.fromHost({ type: 'naklios:review:commit', proposal_id: 'prop_demo' });
app.fromHost({ type: 'naklios:review:commit', proposal_id: 'prop_demo' });
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(decisions, 1, 'duplicate in-flight commits share one app application');
assert.deepEqual(JSON.parse(JSON.stringify(app.sent.at(-1))),
  { type: 'naklios:review:applied', proposal_id: 'prop_demo', ok: true });

app.fromHost({ type: 'naklios:review:commit', proposal_id: 'prop_demo' });
assert.equal(decisions, 1, 'replayed commits must only re-acknowledge');
assert.equal(app.sent.at(-1).ok, true);
app.fromHost({ type: 'naklios:review:discard', proposal_id: 'prop_demo' });
await Promise.resolve();
assert.equal(decisions, 2);

// Reckon review B5: withdraw asks the host to take back this app's card.
assert.deepEqual(JSON.parse(JSON.stringify(await standalone.window.naklios.review.withdraw('prop_demo'))),
  { standalone: true, withdrawn: false });
await assert.rejects(app.window.naklios.review.withdraw(''), /needs a proposal id/);
const withdrawing = app.window.naklios.review.withdraw('prop_demo');
const withdrawRequest = app.sent.at(-1);
assert.equal(withdrawRequest.type, 'naklios:review:withdraw');
assert.equal(withdrawRequest.proposal_id, 'prop_demo');
app.fromHost({ type: 'naklios:review:reply', requestId: withdrawRequest.requestId, result: { ok: true } });
assert.equal((await withdrawing).ok, true);
const refused = app.window.naklios.review.withdraw('prop_other');
app.fromHost({ type: 'naklios:review:reply', requestId: app.sent.at(-1).requestId, error: 'only the app that staged this change can withdraw it' });
await assert.rejects(refused, /only the app that staged/);

console.log('SDK review bridge: standalone fallback, native stage RPC, trusted decisions, replay-safe acknowledgement, and withdraw passed');
