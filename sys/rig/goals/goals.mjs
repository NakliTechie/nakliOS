// goals — Rig C7 goal records. *What to achieve and how we'll know*, persisted
// on the user's backend so a goal survives a closed tab and resumes cold.
//
// The one hard rule (RIG-VISION §7): `status: done` may only be written by a
// zero-exit **verifier** run (Kiln K3), never by the working agent. A
// self-modifying loop can't launder its own verdict — `update()` refuses to set
// done, and `markDone()` demands a verifier verdict with `exit === 0`.
//
//   const goals = createGoalStore({ fs });          // fs = a Rig fileops instance
//   await goals.create({ id, goal, plan, budget, grantPrefix });
//   await goals.update(id, { currentStep: 1 }, { revision });   // revision-guarded
//   await goals.markDone(id, verifierVerdict);      // exit:0 required

const SCHEMA_VERSION = 1;
const STATUSES = new Set(['active', 'paused', 'done', 'abandoned']);

function iso(clock) { return new Date(clock()).toISOString(); }

export function createGoalStore({ fs, dir = 'goals', clock = () => Date.now() } = {}) {
  if (!fs) throw new Error('createGoalStore requires a fileops instance (fs)');
  const pathFor = (id) => `${dir}/${id}.json`;
  // Serialize budget/status read-modify-writes: two concurrent spends would both
  // read the same `spent` and one would be lost, letting an agent exceed its cap (Low9).
  let _goalChain = Promise.resolve();
  const _serial = (fn) => { const p = _goalChain.then(fn); _goalChain = p.catch(() => {}); return p; };

  async function persist(record) {
    record.revision += 1;
    record.updatedAt = iso(clock);
    const res = await fs.write(pathFor(record.id), JSON.stringify(record, null, 2));
    if (!res.ok) throw new Error(`goal write failed: ${res.message || res.code}`);
    return record;
  }

  async function read(id) {
    const res = await fs.read(pathFor(id), { encoding: 'utf-8' });
    if (!res.ok) return null;
    try { return JSON.parse(res.data); } catch { return null; }
  }

  async function create({ id, goal, constraints = [], grantPrefix = '', budget = null, plan = [] }) {
    if (!id) throw new Error('goal id is required');
    if (await read(id)) throw new Error(`goal ${id} already exists`);
    const record = {
      schema: SCHEMA_VERSION,
      id,
      goal: String(goal || ''),
      constraints: [...constraints],
      grantPrefix,
      budget,
      spent: 0,
      status: 'active',
      currentStep: 0,
      revision: 0,
      plan: plan.map((p) => ({
        step: p.step,
        doneCondition: p.doneCondition,
        status: 'open',
        note: p.note || '',
        keystone: !!p.keystone,
      })),
      createdAt: iso(clock),
      updatedAt: iso(clock),
    };
    return persist(record);
  }

  // Revision-guarded update. A stale write is rejected (ESTALE) so two attached
  // sessions can't clobber each other; `done` cannot be set here.
  async function update(id, patch = {}, { revision } = {}) {
    const record = await read(id);
    if (!record) throw new Error(`goal ${id} not found`);
    if (revision != null && revision !== record.revision) {
      return { ok: false, code: 'ESTALE', message: `stale revision ${revision} (current ${record.revision})`, current: record.revision };
    }
    if (patch.status === 'done') {
      return { ok: false, code: 'EVERIFY', message: 'status:done may only be set via markDone with a zero-exit verifier verdict' };
    }
    for (const key of ['goal', 'constraints', 'grantPrefix', 'budget', 'currentStep', 'plan', 'note']) {
      if (key in patch) record[key] = patch[key];
    }
    if (patch.status && STATUSES.has(patch.status) && patch.status !== 'done') record.status = patch.status;
    await persist(record);
    return { ok: true, revision: record.revision, record };
  }

  function spend(id, amount) { return _serial(() => _spendRaw(id, amount)); }
  async function _spendRaw(id, amount) {
    const record = await read(id);
    if (!record) throw new Error(`goal ${id} not found`);
    record.spent += Number(amount) || 0;
    const exhausted = record.budget != null && record.spent >= record.budget;
    await persist(record);
    return { ok: true, spent: record.spent, exhausted };
  }

  // The one privileged transition. Requires a verifier verdict with exit 0 —
  // the working agent has no path to this (see K3).
  function markDone(id, verdict) { return _serial(() => _markDoneRaw(id, verdict)); }
  async function _markDoneRaw(id, verdict) {
    const record = await read(id);
    if (!record) throw new Error(`goal ${id} not found`);
    if (!verdict || verdict.exit !== 0) {
      return { ok: false, code: 'EVERIFY', message: 'markDone requires a verifier verdict with exit 0' };
    }
    record.status = 'done';
    record.verifiedBy = { command: verdict.command || null, runId: verdict.runId || null, at: iso(clock) };
    await persist(record);
    return { ok: true, record };
  }

  const pause = (id, revision) => update(id, { status: 'paused' }, { revision });
  const resume = (id, revision) => update(id, { status: 'active' }, { revision });
  async function clear(id) {
    const res = await fs.remove(pathFor(id));
    return { ok: !!res.ok };
  }

  return { create, get: read, update, spend, markDone, pause, resume, clear, SCHEMA_VERSION };
}
