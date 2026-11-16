/* Reel feature module: door (batch 2). Contract: docs/build/reel-v1-contract.md.
 * No DOM access at module top level, so Node can import COMMANDS for commands.json.
 *
 * N7 WebMCP: when the browser (or an extension) offers `document.modelContext` or
 * `navigator.modelContext` with `registerTool`, every registry command becomes a tool whose
 * `execute` runs `ctx.registry.run`. When neither exists, nothing happens and nothing is shown.
 * N8 offline: registers ../../sw.js (the repository root) with scope './' over http(s).
 * NakliOS rail: when hosted, every registry command is registered with
 * `naklios.experimental_commands.register` (the host lists them as `reel.<name>`). Standalone,
 * nothing is called.
 * `door.read` reports all three, and changes nothing (V23): host registration runs once after install.
 * Scopes map to WebMCP annotations: read is readOnlyHint, destructive is destructiveHint (V22); the
 * NakliOS rail gets the scope as is, and the host stages destructive commands through review. */

export const COMMANDS = [
  { name: 'door.read', label: 'Agent and offline status', scope: 'read',
    description: 'Read which WebMCP API was found and how many commands it registered as tools, whether Reel is hosted in NakliOS and how many commands it registered there, and whether the offline service worker is registered, with its scope and cache.',
    input: { type: 'object', properties: {}, required: [] } },
];
export const STRINGS = {};

const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/;

/* The WebMCP object, preferring document.modelContext (current proposal) over navigator.modelContext. */
export function findModelContext(doc = globalThis.document, nav = globalThis.navigator) {
  if (typeof doc?.modelContext?.registerTool === 'function') return { api: doc.modelContext, name: 'document.modelContext' };
  if (typeof nav?.modelContext?.registerTool === 'function') return { api: nav.modelContext, name: 'navigator.modelContext' };
  return null;
}

/* WebMCP tool annotations for a command scope. */
export function toolAnnotations(scope) {
  return { readOnlyHint: scope === 'read', destructiveHint: scope === 'destructive' };
}

function toText(value) {
  try { return JSON.stringify(value ?? null); } catch { return String(value); }
}

/* Registers each definition as a tool on `api`. `run(name, input)` executes a command.
 * Returns { registered: names[], failed: [{ name, error }], handles }. */
export async function registerTools(api, definitions, run) {
  const registered = [];
  const failed = [];
  const handles = [];
  for (const def of definitions) {
    const tool = {
      name: def.name,
      title: def.label,
      description: def.description,
      inputSchema: def.input,
      annotations: toolAnnotations(def.scope),
      async execute(input) {
        try {
          const result = await run(def.name, input ?? {});
          return { content: [{ type: 'text', text: toText(result) }] };
        } catch (error) {
          return { isError: true, content: [{ type: 'text', text: error?.message || String(error) }] };
        }
      },
    };
    try {
      handles.push(await api.registerTool(tool));
      registered.push(def.name);
    } catch (error) {
      failed.push({ name: def.name, error: error?.message || String(error) });
    }
  }
  return { registered, failed, handles };
}

/* NakliOS rail. Registers every definition with bridge.experimental_commands.register as
 * { name, description, input, scope, handler }, handler (args) => run(name, args). Returns the count
 * registered, or 0 when the bridge is absent or not hosted. A rejection or throw is logged, never
 * thrown, as Chartella does (src/host.js registerCommands). register() replaces the whole set. */
export async function registerWithHost(bridge, definitions, run, log = console) {
  if (!bridge?.capabilities?.hosted || typeof bridge.experimental_commands?.register !== 'function') return 0;
  const list = definitions.map(def => ({
    name: def.name,
    description: def.description,
    input: def.input,
    scope: def.scope,
    handler: args => run(def.name, args ?? {}),
  }));
  try {
    await bridge.experimental_commands.register(list);
    return list.length;
  } catch (error) {
    log.warn?.('[reel] NakliOS command registration failed', error);
    return 0;
  }
}

/* Whether this page should register the offline worker, and why not when it should not.
 * Loopback hosts skip it unless ?sw=1, because cache-first serving would hide edits during
 * development. NakliOS lets mirrored apps register their own worker (Montella and NakliAmp do);
 * a sandboxed frame that forbids it makes register() throw, which door.read reports. */
export function offlinePlan(location = globalThis.location, nav = globalThis.navigator) {
  if (!nav || !('serviceWorker' in nav)) return { register: false, reason: 'no service worker support' };
  if (!/^https?:$/.test(location?.protocol || '')) return { register: false, reason: `not served over http(s) (${location?.protocol})` };
  const forced = new URLSearchParams(location.search).get('sw') === '1';
  if (LOOPBACK.test(location.hostname) && !forced) return { register: false, reason: 'local development host; add ?sw=1 to register' };
  return { register: true, reason: null };
}

export function install(ctx) {
  const webmcp = { api: null, registered: 0, failed: [] };
  const offline = { supported: typeof navigator !== 'undefined' && 'serviceWorker' in navigator, registered: false, scope: null, reason: null };

  const found = findModelContext();
  if (found) {
    webmcp.api = found.name;
    registerTools(found.api, ctx.registry.list(), (name, input) => ctx.registry.run(name, input))
      .then(result => { webmcp.registered = result.registered.length; webmcp.failed = result.failed; })
      .catch(error => { webmcp.failed = [{ name: '*', error: error.message }]; });
  }

  // NakliOS rail: register after every module has installed (a microtask runs after the install
  // loop), and again whenever the set of command names changes.
  const host = { hosted: false, registered: 0, names: '' };
  async function syncHost() {
    const bridge = await ctx.nakliosBridge?.();
    host.hosted = !!bridge?.capabilities?.hosted;
    if (!host.hosted) return;
    const defs = ctx.registry.list();
    const names = defs.map(def => def.name).join(' ');
    if (names === host.names) return;
    host.names = names;
    host.registered = await registerWithHost(bridge, defs, (name, input) => ctx.registry.run(name, input));
    if (!host.registered) host.names = '';
  }
  queueMicrotask(() => { syncHost().catch(() => {}); });

  const plan = offlinePlan();
  offline.reason = plan.reason;
  if (plan.register) {
    navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { scope: new URL('../../', import.meta.url).href })
      .then(registration => { offline.registered = true; offline.scope = registration.scope; })
      .catch(error => { offline.reason = `registration failed: ${error.message}`; });
  }

  ctx.registry.handle('door.read', async () => {
    let worker = null;
    let cache = null;
    if (offline.supported) {
      try {
        const registration = await navigator.serviceWorker.getRegistration(new URL('../../', import.meta.url).href);
        if (registration) {
          worker = registration.active?.state || registration.installing?.state || registration.waiting?.state || null;
          offline.scope = registration.scope;
        }
      } catch { /* a sandboxed frame may refuse; the reason above stays */ }
      try { cache = (await caches.keys()).find(key => key.startsWith('reel-app-')) || null; } catch { cache = null; }
    }
    return {
      webmcp: { api: webmcp.api, registered: webmcp.registered, total: ctx.registry.list().length, failed: webmcp.failed },
      naklios: { hosted: host.hosted, registered: host.registered },
      offline: { supported: offline.supported, registered: offline.registered || worker !== null, scope: offline.scope, worker, cache, reason: offline.reason },
    };
  });
}
