// Bound only the private interpreter's asynchronous initialization. An import
// already in progress may finish and cache the runtime; an abandoned caller
// never proceeds to SQL execution. Active execution keeps its owned lifetime.
export function waitForSqliteLoad(load, { signal, timeoutMs } = {}) {
  const milliseconds = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.max(1, Math.min(30000, Math.floor(timeoutMs))) : 30000;
  return new Promise((resolve) => {
    let settled = false, timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    };
    const abort = () => finish({ ok: false, result: {
      status: 'interrupted', stdout: '', stderr: 'SQLite initialization cancelled',
    } });
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish({ ok: false, result: {
      status: 'unavailable', reason: 'load-timeout',
      message: `SQLite runtime initialization timed out after ${milliseconds} ms`,
    } }), milliseconds);
    Promise.resolve().then(() => settled ? undefined : load()).then(
      (value) => finish({ ok: true, value }),
      (error) => finish({ ok: false, result: {
        status: 'unavailable', reason: 'unavailable', message: String(error?.message || error),
      } }),
    );
  });
}
