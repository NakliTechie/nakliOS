import { browserStore, hostStore, Snapshot } from './storage.mjs';
import { waitForCapabilities } from './lifecycle.mjs';
const SDK_URL = '../../sdk/naklios.js';
export const LIBRARY_SKILLS_DIR = 'home/.agents/skills';
// Snapshot entries for the usable skills in the NakliOS library, as SKILL.md files dsh reads natively.
export async function loadLibrarySkills(sdk) {
  const lib = sdk?.experimental_skills;
  if (!lib) return [];
  let catalog = [];
  try { catalog = await lib.list(); } catch (_) { return []; }
  const enc = new TextEncoder(), out = [{ path: 'home/.agents', directory: true, mode: 0o755 }, { path: LIBRARY_SKILLS_DIR, directory: true, mode: 0o755 }];
  for (const item of catalog || []) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(String(item?.name || ''))) continue;
    let skill = null;
    try { skill = await lib.read(item.name); } catch (_) {}
    if (!skill?.body) continue;
    const text = `---\nname: ${skill.name}\ndescription: ${String(skill.description || '').replace(/\s+/g, ' ').trim()}\n---\n${skill.body}\n`;
    out.push({ path: `${LIBRARY_SKILLS_DIR}/${skill.name}`, directory: true, mode: 0o755 });
    out.push({ path: `${LIBRARY_SKILLS_DIR}/${skill.name}/SKILL.md`, bytes: Array.from(enc.encode(text)), mode: 0o444 });
  }
  return out.length > 2 ? out : [];
}
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
  const metrics = {};
  const cold = new URLSearchParams(location.search).get('dish-cold') === '1';
  if (!window.naklios) await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = SDK_URL;
    script.onload = resolve; script.onerror = () => reject(new Error('NakliOS SDK failed to load')); document.head.append(script);
  });
  const sdk = window.naklios;
  metrics.sdkReadyMs = performance.now();
  const status = document.createElement('aside'); status.id = 'dish-status';
  status.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:10000;background:#17191d;color:#fff;padding:4px 10px;font:12px system-ui;';
  document.body.append(status);
  const say = text => { status.textContent = text; };
  say('Loading Dish…');
  if (window.parent !== window) await waitForCapabilities(sdk);
  metrics.capabilitiesReadyMs = performance.now();
  const store = sdk.capabilities.fs ? hostStore(sdk) : browserStore();
  const snapshot = new Snapshot(await store.load());
  metrics.storageRestoredMs = performance.now();
  const saver = sdk.fs.autosave({ save: () => store.save(snapshot.values()), delay: 400,
    onError: error => say(`Unsaved changes: ${error.message}. Reload only after saving succeeds.`) });
  const worker = new WorkerClass({ name: 'dish-host' });
  metrics.workerCreatedMs = performance.now();
  worker.addEventListener('error', event => say(`Dish stopped: ${event.message}`));
  worker.addEventListener('messageerror', () => say('Dish received an unreadable Worker message'));
  const calls = new Map();
  worker.addEventListener('message', async event => {
    const data = event.data;
    if (typeof data?.t === 'string' && data.t.startsWith('dish-')) event.stopImmediatePropagation();
    if (data?.t === 'dish-mutation') {
      // The skills library is mounted fresh each boot and is never saved into Dish's own snapshot.
      if (String(data.change?.path || '').startsWith(LIBRARY_SKILLS_DIR + '/')) return;
      try { snapshot.apply(data.change); saver.markDirty(); } catch (error) { say(error.message); }
    }
    if (data?.t === 'dish-image-metrics') metrics.image = data.metrics;
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
  // The NakliOS skills library (naklios.experimental_skills: Sentinel-clean, active or stale) appears
  // where dsh reads user skills, home/.agents/skills/<name>/SKILL.md, for this boot only.
  const librarySkills = await loadLibrarySkills(sdk);
  // Intercept only the opening frame; retain the upstream tunnel and UI unchanged.
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (data, ...rest) => post(data?.t === 'init' ? { ...data, coldBoot: cold, snapshot: [...snapshot.values().filter(e => !e.path.startsWith(LIBRARY_SKILLS_DIR + '/')), ...librarySkills] } : data, ...rest);
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
    const image = new URL('preview/vfs-image.tar.gz', location.href);
    if (cold) image.searchParams.set('dish-cold', crypto.randomUUID());
    await Promise.race([connect(worker, { image: image.href }), uiReady.then(() => new Promise(() => {}))]);
    const workerBootMs = performance.now();
    await uiReady;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const bootMs = performance.now();
    window.__dish = { bootMs, workerBootMs, metrics, cold, worker, snapshot, flush: () => saver.flush(), store: store.id };
    say(`Dish · ${store.id} storage · Plugins run with full trust. Worker shell supports browser commands only.`);
    sdk.title('Dish'); sdk.ready();
  } catch (error) { say(`Dish could not start: ${error.message}`); worker.terminate(); throw error; }
  finally { clearTimeout(uiTimer); document.removeEventListener('dish-ui-mounted', mountedListener); document.removeEventListener('dish-ui-error', failedListener); }
}
