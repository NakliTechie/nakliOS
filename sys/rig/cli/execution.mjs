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
  const scopes = [];
  let pending = null, stopped = false, finished = false, waiter = null;
  let output = [], confirmation = null;
  const events = [];
  const emit = (extra = {}) => {
    const event = { output: output.join('\n'), ...extra, ...(confirmation ? { confirmation } : {}) };
    output = []; confirmation = null;
    if (waiter) { const resolve = waiter; waiter = null; resolve(event); }
    else events.push(event);
  };
  const check = () => { if (stopped || signal?.aborted || scopes.some((scope) => scope.controller.signal.aborted)) throw new ShellInterrupted(); };
  const write = (text) => { if (text !== '' && text != null) output.push(String(text)); };
  const reject = (proposals) => { for (const p of proposals) face.reject(p.proposalId); };
  function cancel() {
    stopped = true;
    controller.abort();
    for (const scope of scopes) scope.controller.abort();
    if (pending) {
      const p = pending; pending = null;
      reject(p.proposals);
      p.resume(false);
    }
  }
  signal?.addEventListener('abort', cancel, { once: true });

  return {
    check, write, cancel,
    get signal() { return scopes.at(-1)?.controller.signal ?? controller.signal; },
    get hasDeadline() { return scopes.some((scope) => scope.milliseconds > 0); },
    async withTimeout(milliseconds, operation) {
      check();
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 300000) throw new RangeError('timeout duration is out of bounds');
      if (scopes.length >= 32) throw Object.assign(new Error('timeout: nested deadline limit exceeded'), { code: 2 });
      const scope = { controller: new AbortController(), expired: false, milliseconds };
      scopes.push(scope);
      const timer = milliseconds ? setTimeout(() => {
        const index = scopes.indexOf(scope); if (index < 0) return;
        scope.expired = true;
        for (const active of scopes.slice(index)) active.controller.abort();
        if (pending && scopes.indexOf(pending.scope) >= index) {
          const proposal = pending; pending = null;
          reject(proposal.proposals); proposal.resume(false);
        }
      }, milliseconds) : null;
      let result;
      try { result = await operation(); }
      catch (error) {
        if (!(error instanceof ShellInterrupted) || !scope.expired) throw error;
      } finally {
        clearTimeout(timer);
        scopes.pop();
      }
      // External Stop or an enclosing deadline always wins over this scope's
      // local timeout. Await owned work before restoring access to its parent.
      check();
      return { timedOut: scope.expired, result };
    },
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
        pending = { proposals, resume, scope: scopes.at(-1) ?? null };
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
