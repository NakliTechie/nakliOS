import assert from 'node:assert/strict';
import { createReviewHost } from '../review-host.mjs';
import { buildReviewModel } from '../reviewer.mjs';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

const source = { name: 'reckon frame' };
const history = [];
let host;
let applied = 0;
host = createReviewHost({
  storage: memoryStorage(),
  now: () => 1000,
  record: async (tool, input, output) => history.push({ tool, input, output }),
  sendDecision(frame, message) {
    assert.equal(frame, source);
    if (message.type === 'naklios:review:commit') {
      applied++;
      queueMicrotask(() => host.acknowledge({ source, proposal_id: message.proposal_id, ok: true }));
    }
  },
});

const diff = {
  sheet: 's1', sheetName: 'Sheet 1',
  ops: [{ op: 'setCells', sheet: 's1', cells: { A1: { v: 42 } } }],
  inverse: [{ op: 'setCells', sheet: 's1', cells: { A1: null } }],
};
await assert.rejects(host.stage({ source, app: 'reckon', tool: 'draft.transaction', diff }),
  /does not match/);
await assert.rejects(host.stage({ source, app: 'reckon', tool: 'reckon.transaction', diff: { ops: [] } }),
  /no renderable/);
await assert.rejects(host.stage({ source, app: 'reckon', tool: 'reckon.transaction',
  diff: { sheet:'s1', ops:diff.ops, inverse:[] } }), /no renderable/);
const staged = await host.stage({ source, app: 'reckon', tool: 'reckon.transaction', diff, reversible: true });
assert.match(staged.proposal_id, /^prop_/);
assert.equal(host.size(), 1);
await assert.rejects(host.stage({ source, app: 'reckon', tool: 'reckon.transaction', diff }),
  /pending change/);
const model = buildReviewModel(host.envelopes()[0], { actor: 'person', now: 1000 });
assert.equal(model.rows[0].label, 'A1');
assert.equal(model.rows[0].after, '42');
diff.ops[0].cells.A1.v = 99;
assert.equal(buildReviewModel(host.envelopes()[0], { actor: 'person' }).rows[0].after, '42');

assert.equal((await host.commit(staged.proposal_id)).ok, true);
assert.equal(applied, 1);
assert.equal(host.size(), 0);
assert.equal((await host.commit(staged.proposal_id)).ok, false);
assert.equal(applied, 1);
assert.deepEqual(history.map(row => row.tool), ['patch.staged', 'patch.committed']);

const rejected = await host.stage({ source, app: 'draft', tool: 'draft.transaction',
  diff: { docName: 'Note', from: 1, to: 1, hunks: [{ index: 0, kind: 'insert', delText: '', insText: 'hello' }] } });
const draftModel = buildReviewModel(host.envelopes()[0], { actor: 'person', now: 1000 });
assert.equal(draftModel.rows[0].after, 'hello');
assert.equal((await host.discard(rejected.proposal_id, 'not wanted')).ok, true);
assert.equal(applied, 1);
await assert.rejects(host.stage({ source, app: 'draft', tool: 'draft.transaction',
  diff: { docName: 'Note', from: 1, to: 1, hunks: [{ index: 0, kind: 'insert', delText: '', insText: 'hello' }] } }),
  /discarded recently/);
assert.equal(history.at(-1).tool, 'patch.rejected');

const kanzen = await host.stage({ source, app: 'kanzen', tool: 'kanzen.card-move',
  diff: { card: 'c1', cardTitle: 'Task', from: 'todo', fromName: 'To do', to: 'done', toName: 'Done', fromIndex: 0, toIndex: 1 } });
assert.equal(buildReviewModel(host.envelopes()[0], { actor: 'person' }).rows[0].after, 'Done · position 2');
await host.discard(kanzen.proposal_id);

let time = 1000;
const expiringHost = createReviewHost({ now: () => time, storage: memoryStorage(), sendDecision() {} });
const expiring = await expiringHost.stage({ source, app: 'reckon', tool: 'reckon.transaction', diff, expires: 1001 });
time = 1002;
assert.match((await expiringHost.commit(expiring.proposal_id)).reason, /expired/);
assert.equal(expiringHost.size(), 1);
await expiringHost.discard(expiring.proposal_id);

const foreign = { name: 'other frame' };
let attempted = null;
const noAckHost = createReviewHost({ storage: memoryStorage(), now: () => 1000, ackTimeoutMs: 10,
  sendDecision(_frame, message) { attempted = message.proposal_id; } });
const noAck = await noAckHost.stage({ source, app: 'reckon', tool: 'reckon.transaction', diff });
const promise = noAckHost.commit(noAck.proposal_id);
assert.equal(noAckHost.acknowledge({ source: foreign, proposal_id: noAck.proposal_id, ok: true }), false);
assert.equal((await promise).ok, false);
assert.equal(attempted, noAck.proposal_id);
assert.equal(noAckHost.size(), 1);
await noAckHost.discard(noAck.proposal_id);

const closingDiff = { card:'c2', cardTitle:'Reopen me', from:'todo', to:'done', fromName:'To do', toName:'Done' };
const closing = await host.stage({ source, app:'kanzen', tool:'kanzen.card-move', diff:closingDiff });
await host.detach(source);
assert.equal(host.size(), 0);
assert.equal(history.at(-1).tool, 'patch.abandoned');
const reopened = await host.stage({ source:foreign, app:'kanzen', tool:'kanzen.card-move', diff:closingDiff });
assert.notEqual(reopened.proposal_id, closing.proposal_id, 'closing a frame does not poison its staged change');
await host.discard(reopened.proposal_id);

const failingHistory = createReviewHost({ storage:memoryStorage(), now:() => 1000,
  sendDecision() {}, record:async () => { throw new Error('store unavailable'); } });
await assert.rejects(failingHistory.stage({ source, app:'reckon', tool:'reckon.transaction', diff }),
  /History failed; review was not staged/);
assert.equal(failingHistory.size(), 0, 'a proposal without a staged History event cannot be committed');

const concurrentHost = createReviewHost({ storage:memoryStorage(), now:() => 1000, sendDecision() {} });
const concurrent = await Promise.allSettled([
  concurrentHost.stage({ source, app:'reckon', tool:'reckon.transaction', diff }),
  concurrentHost.stage({ source, app:'reckon', tool:'reckon.transaction', diff }),
]);
assert.deepEqual(concurrent.map(result => result.status).sort(), ['fulfilled', 'rejected']);
assert.equal(concurrentHost.size(), 1, 'concurrent stages from one frame cannot create stale siblings');

console.log('review-host: native previews, immutable staging, source ack, expiry, discard poison, and one-shot commit passed');

// KanZen agent proposals: a second KanZen tool with its own renderable diff.
{
  const frame = { name: 'kanzen frame' };
  let committed = 0;
  const agentHost = createReviewHost({
    storage: memoryStorage(), now: () => 1000, record: async () => {},
    sendDecision(target, message) {
      if (message.type === 'naklios:review:commit') {
        committed++;
        queueMicrotask(() => agentHost.acknowledge({ source: frame, proposal_id: message.proposal_id, ok: true }));
      }
    },
  });
  const agentDiff = { kind: 'agent', tool: 'apply_changes', summary: '2 changes to "Main"', details: ['Add column "Review"', 'Create card "Check"'],
    boardName: 'Main', caller: 'planner', door: 'modelContext', destructive: false };
  await assert.rejects(agentHost.stage({ source: frame, app: 'reckon', tool: 'kanzen.agent', diff: agentDiff }), /does not match/);
  const proposal = await agentHost.stage({ source: frame, app: 'kanzen', tool: 'kanzen.agent', diff: agentDiff });
  const card = agentHost.envelopes()[0];
  assert.equal(card.tool, 'kanzen.agent');
  const model = buildReviewModel(agentHost.envelopes()[0], { actor: "person", now: 1000 });
  assert.equal(model.summary, '2 changes to "Main" — agent (planner via modelContext)');
  assert.deepEqual(model.rows.map(row => row.after), ['Add column "Review"', 'Create card "Check"']);
  await assert.rejects(agentHost.stage({ source: frame, app: 'kanzen', tool: 'kanzen.agent', diff: agentDiff }), /pending change/);
  const result = await agentHost.commit(proposal.proposal_id);
  assert.equal(result.ok, true);
  assert.equal(committed, 1);
  // a destructive proposal renders as a removal
  const removal = await agentHost.stage({ source: frame, app: 'kanzen', tool: 'kanzen.agent',
    diff: { kind: 'agent', tool: 'delete_card', summary: 'Delete card "Old"', destructive: true } });
  assert.equal(buildReviewModel(agentHost.envelopes()[0], { actor: "person", now: 1000 }).rows[0].change, 'remove');
  await agentHost.discard(removal.proposal_id);
  // the person's card moves still render as before
  const move = await agentHost.stage({ source: frame, app: 'kanzen', tool: 'kanzen.card-move',
    diff: { boardId: 'b', card: 'c', cardTitle: 'Card', from: 'a', fromName: 'To Do', fromIndex: 0, to: 'd', toName: 'Done', toIndex: 0 } });
  assert.equal(buildReviewModel(agentHost.envelopes()[0], { actor: "person", now: 1000 }).summary, 'Card — move card');
  await agentHost.discard(move.proposal_id);
  console.log('review host: KanZen agent proposals stage, render, commit once, and leave card moves unchanged');
}

