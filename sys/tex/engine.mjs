// The host's handle on the engine Worker. `stop` ends the Worker, and the next call starts a fresh one.
import { TEX_PACKS } from './service.mjs';

const CLEAR_LIMIT_MS = 60000;

export function createTexEngine({ base, workerUrl }) {
  let worker = null, started = false, nextId = 0;
  const waiting = new Map();
  let onDownload = () => {};

  function dropWorker(error) {
    worker?.terminate();
    worker = null; started = false;
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  }

  function call(op, data = {}, transfer = []) {
    if (!worker) {
      worker = new Worker(workerUrl, { type:'module', name:'naklios-tex' });
      worker.addEventListener('error', event => {
        console.error('TeX worker error:', event.message);
        dropWorker(new Error(`The TeX engine failed: ${event.message || 'worker error'}`));
      });
      worker.addEventListener('message', ({ data:message }) => {
        if (message.type === 'download') return onDownload(message.progress);
        const entry = waiting.get(message.id);
        if (!entry) return;
        waiting.delete(message.id);
        if (message.error) entry.reject(new Error(message.error));
        else entry.resolve(message.result);
      });
    }
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      worker.postMessage({ op, id, base, packs:TEX_PACKS, ...data }, transfer);
    });
  }

  return {
    isReady:async () => started,
    async start(progress) {
      onDownload = progress;
      await call('start');
      started = true;
    },
    compile:({ files, main, driver }) => call('compile', { files, main, driver }, files.map(file => file.content.buffer)),
    cached:() => call('cached'),
    async clear() {
      dropWorker(new Error('The TeX cache was cleared'));
      // Compiles wait for a clear, so a clear that never answers must end on its own.
      const stuck = setTimeout(() => dropWorker(new Error('The TeX cache did not clear')), CLEAR_LIMIT_MS);
      try { await call('clear'); } finally { clearTimeout(stuck); }
      dropWorker(new Error('The TeX cache was cleared'));
    },
    stop:() => dropWorker(new Error('The TeX engine stopped')),
  };
}
