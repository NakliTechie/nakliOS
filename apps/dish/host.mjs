import { browserStore, hostStore, Snapshot } from './storage.mjs';
import { waitForCapabilities } from './lifecycle.mjs';
const SDK_URL = '../../sdk/naklios.js';
export async function startDish(WorkerClass, connect) {
  try { return await bootDish(WorkerClass, connect); }
  catch (error) {
    let status = document.getElementById('dish-status');
    if (!status) { status = document.createElement('aside'); status.id = 'dish-status'; document.body.append(status); }
    status.setAttribute('role', 'alert');
    status.textContent = `Dish could not start: ${error.message}`;
    throw error;
  }
}
async function bootDish(WorkerClass, connect) {
  await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = SDK_URL;
    script.onload = resolve; script.onerror = () => reject(new Error('NakliOS SDK failed to load')); document.head.append(script);
  });
  const sdk = window.naklios;
  const status = document.createElement('aside'); status.id = 'dish-status';
  status.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:10000;background:#17191d;color:#fff;padding:4px 10px;font:12px system-ui;';
  document.body.append(status);
  const say = text => { status.textContent = text; };
  say('Loading Dish…');
  if (window.parent !== window) await waitForCapabilities(sdk);
  const store = sdk.capabilities.fs ? hostStore(sdk) : browserStore();
  const snapshot = new Snapshot(await store.load());
  const saver = sdk.fs.autosave({ save: () => store.save(snapshot.values()), delay: 400,
    onError: error => say(`Unsaved changes: ${error.message}. Reload only after saving succeeds.`) });
  const worker = new WorkerClass({ name: 'dish-host' });
  worker.addEventListener('error', event => say(`Dish stopped: ${event.message}`));
  worker.addEventListener('messageerror', () => say('Dish received an unreadable Worker message'));
  const calls = new Map();
  worker.addEventListener('message', async event => {
    const data = event.data;
    if (typeof data?.t === 'string' && data.t.startsWith('dish-')) event.stopImmediatePropagation();
    if (data?.t === 'dish-mutation') {
      try { snapshot.apply(data.change); saver.markDirty(); } catch (error) { say(error.message); }
    }
    if (data?.t === 'dish-cancel') calls.get(data.id)?.abort();
    if (data?.t !== 'dish-inference') return;
    const abort = new AbortController(); calls.set(data.id, abort);
    try {
      if (!sdk.capabilities.ai) throw new Error('Select a model in NakliOS Settings → AI, then retry');
      const result = await sdk.ai.chat.completions.create({ ...data.request, signal: abort.signal });
      worker.postMessage({ t: 'dish-inference-result', id: data.id, result });
    } catch (error) { worker.postMessage({ t: 'dish-inference-result', id: data.id, error: error.message }); }
    finally { calls.delete(data.id); }
  });
  // Intercept only the opening frame; retain the upstream tunnel and UI unchanged.
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (data, ...rest) => post(data?.t === 'init' ? { ...data, snapshot: snapshot.values() } : data, ...rest);
  sdk.beforeClose(async () => { await saver.flush(); worker.terminate(); });
  let bound = store.id;
  sdk.onCapabilitiesChange(cap => {
    const selected = cap.fs ? cap.fsBackend : 'browser';
    if (selected !== bound) { for (const call of calls.values()) call.abort(); worker.terminate(); say('Storage changed. Reload Dish to open the selected library.'); }
  });
  let uiTimer;
  let mountedListener, failedListener;
  const uiReady = new Promise((resolve, reject) => {
    mountedListener = () => resolve();
    failedListener = event => reject(new Error(event.detail));
    document.addEventListener('dish-ui-mounted', mountedListener, { once: true });
    document.addEventListener('dish-ui-error', failedListener, { once: true });
    uiTimer = setTimeout(() => reject(new Error('Dish client did not finish startup')), 30000);
  });
  // Retain startup errors even when the HTTP handshake is still pending.
  void uiReady.catch(() => {});
  try {
    await Promise.race([connect(worker, { image: 'preview/vfs-image.tar.gz' }), uiReady.then(() => new Promise(() => {}))]);
    const workerBootMs = performance.now();
    await uiReady;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bootMs = performance.now();
    window.__dish = { bootMs, workerBootMs, worker, snapshot, flush: () => saver.flush(), store: store.id };
    say(`Dish · ${store.id} storage · Plugins run with full trust. Worker shell supports browser commands only.`);
    sdk.title('Dish'); sdk.ready();
  } catch (error) { say(`Dish could not start: ${error.message}`); worker.terminate(); throw error; }
  finally { clearTimeout(uiTimer); document.removeEventListener('dish-ui-mounted', mountedListener); document.removeEventListener('dish-ui-error', failedListener); }
}
