// host.mjs — the only module that talks to the NakliOS SDK (globalThis.naklios, inlined
// into index.html between the naklios-sdk markers by scripts/vendor-naklios-sdk.mjs).
// Standalone, or with no SDK at all, every call here does nothing and the player works
// on its own (N4). Pattern copied from Chartella's src/host.js.

const nak = () => globalThis.naklios;
const TAG = '[nakliamp]';

export const hosted = () => !!nak()?.capabilities?.hosted;

// The host's AI broker (naklios.ai): the model the person picked in NakliOS Settings.
// NakliAmp never sees the endpoint or key. Standalone there is no model, and the AI
// playlist dialog falls back to the tag and search filter.
export const aiReady = () => hosted() && !!nak()?.capabilities?.ai;

export async function aiChat(body) {
  if (!aiReady()) throw new Error('No host model here: AI playlists use the model chosen in NakliOS Settings, so this page filters by tags instead');
  return nak().ai.chat.completions.create(body);
}

/** Register the agent face. Each entry: { name, description, input, scope, handler }. */
export function registerCommands(list) {
  try {
    nak()?.experimental_commands?.register(list)?.catch?.(e => console.warn(`${TAG} command registration failed`, e));
  } catch (e) { console.warn(`${TAG} command registration failed`, e); }
}

const themeFns = new Set();
/** fn(theme) on every host theme change; theme is the SDK's `{ colors, mood }`. */
export function onTheme(fn) { themeFns.add(fn); return () => themeFns.delete(fn); }

export function onCapabilities(fn) {
  try { nak()?.onCapabilitiesChange?.(fn); } catch { /* no host */ }
}

/** Files sent from NakliOS ("Open in NakliAmp"): fn(files) gets File objects. */
export function onFiles(fn) {
  const n = nak();
  if (!n?.files?.onOpen) return;
  n.files.onOpen(async grant => {
    try {
      const f = await n.files.read(grant.token);
      const bytes = f.bytes ?? f.data;
      await fn([new File([bytes], f.name ?? (grant.name || 'track'), { type: f.type ?? grant.type ?? '' })]);
    } catch (e) { console.warn(`${TAG} hand-off failed`, e); throw e; }
    finally { try { n.files.release?.(grant.token); } catch { /* already released */ } }
  });
}

export function title(text) {
  try { nak()?.title?.(String(text)); } catch { /* no host */ }
}

/** Tell the host the app is ready, ask for the theme, and forward theme changes. */
export function ready() {
  const n = nak();
  if (!n) return;
  try {
    n.theme?.onChange?.(t => themeFns.forEach(f => { try { f(t); } catch (e) { console.warn(`${TAG} theme listener failed`, e); } }));
    n.ready?.();
    n.theme?.request?.();
    n.title?.('NakliAmp');
  } catch (e) { console.warn(`${TAG} NakliOS wiring failed`, e); }
}
