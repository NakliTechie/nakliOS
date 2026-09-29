// An async command keeps its call stack while the terminal answers a confirmation.
// Only feed() yields: nested commands and pipelines await the same invocation.
export class ShellInterrupted extends Error {
  constructor() { super('shell: interrupted'); this.code = 130; }
}

export class ShellRefused extends Error {
  constructor(verb) { super(`cancelled: ${verb}`); this.code = 1; this.cancelled = true; }
}

export function createExecution({ face, signal = null }) {
  const controller = new AbortController();
  let pending = null, stopped = false, finished = false, waiter = null;
  let output = [], confirmation = null;
  const events = [];
  const emit = (extra = {}) => {
    const event = { output: output.join('\n'), ...extra, ...(confirmation ? { confirmation } : {}) };
    output = []; confirmation = null;
    if (waiter) { const resolve = waiter; waiter = null; resolve(event); }
    else events.push(event);
  };
  const check = () => { if (stopped || signal?.aborted) throw new ShellInterrupted(); };
  const write = (text) => { if (text !== '' && text != null) output.push(String(text)); };
  const reject = (proposals) => { for (const p of proposals) face.reject(p.proposalId); };
  function cancel() {
    stopped = true;
    controller.abort();
    if (pending) {
      const p = pending; pending = null;
      reject(p.proposals);
      p.resume(false);
    }
  }
  signal?.addEventListener('abort', cancel, { once: true });

  return {
    check, write, cancel,
    signal: controller.signal,
    get pending() { return pending?.proposals[0]?.proposalId ?? null; },
    get stopped() { return stopped || !!signal?.aborted; },
    next() {
      if (events.length) return Promise.resolve(events.shift());
      if (finished) return Promise.resolve({ output: '' });
      return new Promise((resolve) => { waiter = resolve; });
    },
    answer(yes) {
      if (!pending) throw new Error('shell: no pending confirmation');
      pending.resume(yes);
    },
    async confirm(proposals, verb, { force = false } = {}) {
      try { check(); } catch (e) { reject(proposals); throw e; }
      const yes = await new Promise((resume) => {
        pending = { proposals, resume };
        write(`${verb} is destructive. confirm? [y/N]`);
        emit({ awaitingConfirm: proposals[0].proposalId });
      });
      pending = null;
      confirmation = { verb, accepted: yes, ok: false };
      try {
        check();
        if (!yes) throw new ShellRefused(verb);
        const results = [];
        for (const proposal of proposals) {
          check();
          let result = await face.accept(proposal.proposalId);
          check();
          if (force && (result.code === 'ENOENT' || /no such path/.test(result.message || ''))) result = { ok: true };
          results.push(result);
        }
        confirmation.ok = results.every((r) => r.ok);
        return results;
      } finally {
        // accept consumes a proposal; reject cleans up refusals, exceptions and Stop.
        reject(proposals);
      }
    },
    async stage(name, input) {
      check();
      const result = await face.invoke(name, input);
      try { check(); } catch (e) { if (result.staged) face.reject(result.proposalId); throw e; }
      return result;
    },
    async invoke(name, input) {
      const result = await this.stage(name, input);
      if (!result.staged) return result;
      return (await this.confirm([{ proposalId: result.proposalId }], name))[0];
    },
    finish(extra = {}) {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      emit(extra);
    },
  };
}
