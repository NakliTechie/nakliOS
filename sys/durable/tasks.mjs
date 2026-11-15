// sys/durable/tasks.mjs — the host's durable task ledger (pure core: no DOM, no IndexedDB).
//
// Ideas taken from pi-durable (@earendil-works/pi-durable, MIT), not its code:
//   - commit before show: every call resolves only after its record is stored;
//   - a task is a small state machine that saves a checkpoint at each step, so work resumes from
//     the last checkpoint after a reload, crash or closed tab;
//   - a sleep is stored (`until`), so it survives a restart and is woken by the host's clock;
//   - a request id makes a retried submit return the first task instead of creating a second;
//   - a restart limit ends a task that keeps dying before its next checkpoint, with a named reason.
//
// The host owns the ledger and the clock; an app is the worker. An app claims its due tasks, runs
// one step, and commits the next state (a new checkpoint, a sleep, done or failed). A claim is a
// lease: if the app closes or crashes before it commits, the lease expires, the task is due again
// and the restart counts. Every record is scoped to one app id; an app never sees another's tasks.
//
// `store` is a small async record store: get(id), put(record), list() (IndexedDB in the host,
// a Map in tests). `now` is the clock (Date.now by default; a fake one in tests).

export const DEFAULTS = Object.freeze({ restartLimit: 5, leaseMs: 60_000, maxTasksPerApp: 500, maxCheckpointBytes: 64 * 1024 });

const TERMINAL = new Set(['done', 'failed', 'cancelled']);
const enc = new TextEncoder();

export class TaskError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function bad(message) { return new TaskError('invalid', message); }

function jsonSize(value) {
  try { return enc.encode(JSON.stringify(value ?? null)).length; } catch (_) { return Infinity; }
}

// The view an app gets: no lease internals beyond what it needs to commit.
export function publicTask(t) {
  if (!t) return null;
  const { lease, ...rest } = t;
  return { ...rest, claimed: !!(lease && lease.token) };
}

export function createTaskLedger({ store, now = () => Date.now(), options = {}, newId } = {}) {
  if (!store) throw new Error('createTaskLedger needs a store');
  const cfg = { ...DEFAULTS, ...options };
  let counter = 0;
  const makeId = newId || (() => `t_${now().toString(36)}_${(++counter).toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
  const makeToken = () => `l_${Math.random().toString(36).slice(2)}${(++counter).toString(36)}`;

  async function appTasks(appId) {
    return (await store.list()).filter((t) => t.appId === appId);
  }

  async function own(appId, id) {
    const t = await store.get(String(id || ''));
    if (!t || t.appId !== appId) throw new TaskError('not_found', `No task ${id}`);
    return t;
  }

  // A task is due when it is pending, when its sleep has ended, or when a lease ran out.
  function isDue(t, at) {
    if (TERMINAL.has(t.state)) return false;
    if (t.state === 'sleeping') return t.until <= at;
    if (t.state === 'running') return !t.lease || t.lease.expires <= at;
    return t.state === 'pending';
  }

  return {
    config: cfg,

    // Create a task, or return the existing one for the same (appId, requestId).
    async submit(appId, { kind, requestId, input = null, label = '', until, notify = '' } = {}) {
      if (!appId) throw bad('An app id is required');
      if (typeof kind !== 'string' || !kind) throw bad('kind must be a non-empty string');
      if (requestId !== undefined && (typeof requestId !== 'string' || !requestId)) throw bad('requestId must be a non-empty string');
      if (until !== undefined && !Number.isFinite(until)) throw bad('until must be a time in milliseconds');
      if (jsonSize(input) > cfg.maxCheckpointBytes) throw bad(`input is larger than ${cfg.maxCheckpointBytes} bytes`);
      const mine = await appTasks(appId);
      if (requestId) {
        const same = mine.find((t) => t.requestId === requestId);
        if (same) return publicTask(same);
      }
      if (mine.filter((t) => !TERMINAL.has(t.state)).length >= cfg.maxTasksPerApp) {
        throw new TaskError('limit', `An app may keep at most ${cfg.maxTasksPerApp} open tasks`);
      }
      const at = now();
      const task = {
        id: makeId(), appId, kind, requestId: requestId || null, label: String(label).slice(0, 200),
        notify: String(notify || '').slice(0, 200),
        state: until !== undefined && until > at ? 'sleeping' : 'pending',
        until: until !== undefined && until > at ? until : null,
        step: 0, input, checkpoint: null, restarts: 0, result: null, error: null, lease: null,
        createdAt: at, updatedAt: at,
      };
      await store.put(task);
      return publicTask(task);
    },

    // Lease every due task of this app (at most `max`), counting a restart for any whose last
    // lease ran out without a commit. A task past the restart limit ends `failed` instead.
    async claim(appId, { max = 10, kinds } = {}) {
      const at = now();
      const claimed = [];
      for (const t of await appTasks(appId)) {
        if (claimed.length >= max) break;
        if (!isDue(t, at)) continue;
        if (Array.isArray(kinds) && !kinds.includes(t.kind)) continue;
        const next = { ...t, updatedAt: at };
        if (t.state === 'running') next.restarts = t.restarts + 1;
        if (next.restarts >= cfg.restartLimit) {
          Object.assign(next, { state: 'failed', lease: null, error: { code: 'restart_limit', message: `Ended after ${next.restarts} restarts without a checkpoint` } });
          await store.put(next);
          continue;
        }
        Object.assign(next, { state: 'running', until: null, lease: { token: makeToken(), expires: at + cfg.leaseMs } });
        await store.put(next);
        claimed.push({ ...publicTask(next), lease: next.lease.token });
      }
      return claimed;
    },

    // Store the next state of a claimed task. `outcome` is one of:
    //   { checkpoint }                 — continue now (the task stays claimed; lease renewed)
    //   { checkpoint?, sleepUntil }    — sleep; the lease ends, the host wakes it at sleepUntil
    //   { done: true, result? }        — finished
    //   { failed: true, error? }       — finished with an error the app names
    async commit(appId, id, lease, outcome = {}) {
      const t = await own(appId, id);
      if (TERMINAL.has(t.state)) throw new TaskError('finished', `Task ${id} already ended ${t.state}`);
      if (t.state !== 'running' || !t.lease || t.lease.token !== lease) throw new TaskError('stale_lease', `Task ${id} is not claimed with this lease`);
      const at = now();
      if (t.lease.expires <= at) throw new TaskError('stale_lease', `The lease on task ${id} ran out; claim it again`);
      const next = { ...t, updatedAt: at, step: t.step + 1, restarts: 0 };
      if ('checkpoint' in outcome) {
        if (jsonSize(outcome.checkpoint) > cfg.maxCheckpointBytes) throw bad(`checkpoint is larger than ${cfg.maxCheckpointBytes} bytes`);
        next.checkpoint = outcome.checkpoint;
      }
      if (outcome.done) Object.assign(next, { state: 'done', lease: null, result: outcome.result ?? null });
      else if (outcome.failed) Object.assign(next, { state: 'failed', lease: null, error: { code: 'app_failed', message: String(outcome.error || 'failed').slice(0, 500) } });
      else if (outcome.sleepUntil !== undefined) {
        if (!Number.isFinite(outcome.sleepUntil)) throw bad('sleepUntil must be a time in milliseconds');
        Object.assign(next, { state: 'sleeping', until: outcome.sleepUntil, lease: null });
      } else if ('checkpoint' in outcome) next.lease = { token: t.lease.token, expires: at + cfg.leaseMs };
      else throw bad('commit needs checkpoint, sleepUntil, done or failed');
      await store.put(next);
      return publicTask(next);
    },

    async get(appId, id) { return publicTask(await own(appId, id)); },

    async list(appId, { state } = {}) {
      return (await appTasks(appId)).filter((t) => !state || t.state === state)
        .sort((a, b) => a.createdAt - b.createdAt).map(publicTask);
    },

    async cancel(appId, id) {
      const t = await own(appId, id);
      if (TERMINAL.has(t.state)) return publicTask(t);
      const next = { ...t, state: 'cancelled', lease: null, until: null, updatedAt: now() };
      await store.put(next);
      return publicTask(next);
    },

    // Remove this app's finished tasks older than `olderThanMs` (by name: each id is deleted on its own).
    async prune(appId, { olderThanMs = 7 * 24 * 3600_000 } = {}) {
      const cut = now() - olderThanMs;
      let removed = 0;
      for (const t of await appTasks(appId)) {
        if (TERMINAL.has(t.state) && t.updatedAt < cut) { await store.delete(t.id); removed++; }
      }
      return removed;
    },

    // For the host's clock: which apps have due tasks now, and the earliest future wake time.
    async wake() {
      const at = now();
      const dueApps = new Map();
      let next = Infinity;
      for (const t of await store.list()) {
        if (TERMINAL.has(t.state)) continue;
        if (isDue(t, at)) {
          const list = dueApps.get(t.appId) || [];
          list.push(publicTask(t));
          dueApps.set(t.appId, list);
        } else if (t.state === 'sleeping') next = Math.min(next, t.until);
        else if (t.state === 'running' && t.lease) next = Math.min(next, t.lease.expires);
      }
      return { due: dueApps, nextAt: Number.isFinite(next) ? next : null };
    },
  };
}

// An in-memory store with the same interface as the host's IndexedDB store (for tests).
export function createMemoryTaskStore() {
  const map = new Map();
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  return {
    async get(id) { return clone(map.get(id)); },
    async put(record) { map.set(record.id, clone(record)); },
    async delete(id) { map.delete(id); },
    async list() { return [...map.values()].map(clone); },
  };
}

// The host's IndexedDB store. Each put resolves on the transaction's `complete`, so a caller's
// promise settles only once the record is on disk (commit before show).
export function createIdbTaskStore(indexedDB, name = 'naklios-durable-tasks') {
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('tasks')) req.result.createObjectStore('tasks', { keyPath: 'id' }); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { dbp = null; reject(req.error); };
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('tasks', mode);
      const os = t.objectStore('tasks');
      let out;
      const r = fn(os);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
    });
  }
  return {
    get: (id) => tx('readonly', (os) => os.get(id)),
    put: (record) => tx('readwrite', (os) => os.put(record)).then(() => undefined),
    delete: (id) => tx('readwrite', (os) => os.delete(id)).then(() => undefined),
    list: () => tx('readonly', (os) => os.getAll()),
  };
}
