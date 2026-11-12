// Actions (P50): record a sequence of agent-face commands into actions/<name>.json, then replay it on the
// open document or over a list of photos (batch). Replays dispatch through bus.dispatch, the same path as
// every door, so validation, revision checks, staging and the edit list apply to each step.
//
// Layer ids are document-specific, so a recorded step stores tokens: "$active" (the active layer when the
// recording started), "$layer:<i>" (another layer that existed then, by stack index) and "$new<n>" (the n-th
// layer the recording created). Replay maps them back to the target document's ids. Ids inside strings
// (local adjustment ids are "<base>~<mask>") are replaced too.

import { safeName } from '../files/workspace.js';
import { fail, needDoc, stageOrRun } from './util.js';

// Commands an action never records: reads, file and window commands, history, and the action tools themselves.
export const NOT_RECORDED = new Set(['open_photo', 'new_document', 'save_document', 'set_view', 'set_active', 'undo', 'redo', 'snapshot',
  'grant_folder', 'confirm_staged', 'overwrite_file', 'download_model', 'record_action', 'run_action', 'set_rating', 'enable_channel']);

const ACTION_DIR = 'actions';
const enc = new TextEncoder();

// Replaces every id in value (deep) using pairs [[from, to], ...]; longer ids first so prefixes stay whole.
export function mapIds(value, pairs) {
  const sorted = [...pairs].sort((a, b) => b[0].length - a[0].length);
  const sub = (s) => { for (const [from, to] of sorted) if (s.includes(from)) s = s.split(from).join(to); return s; };
  const walk = (v) => (typeof v === 'string' ? sub(v) : Array.isArray(v) ? v.map(walk) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)])) : v);
  return walk(value);
}

// Token pairs for a document as it stood when recording started (or replay starts).
export function startTokens(doc) {
  const pairs = [];
  if (!doc) return pairs;
  if (doc.activeLayerId) pairs.push([doc.activeLayerId, '$active']);
  doc.layers.forEach((l, i) => { if (l.id !== doc.activeLayerId) pairs.push([l.id, `$layer:${i}`]); });
  return pairs;
}

export function register(bus, ctx) {
  const tools = new Map(bus.manifest.tools.map((t) => [t.name, t]));
  let rec = null;   // { name, pairs, steps, newCount }
  const recordable = (name) => { const t = tools.get(name); return t && t.effect === 'mutate' && !t.personOnly && !NOT_RECORDED.has(name); };

  // The recorder watches replies on the bus itself (every door passes here). The replay sets ctx.replaying so
  // its own steps are not recorded again.
  const inner = bus.dispatch;
  bus.dispatch = async (name, args = {}, opts = {}) => {
    const before = rec && !ctx.replaying && recordable(name) ? new Set(ctx.store.doc?.layers.map((l) => l.id) || []) : null;
    const reply = await inner(name, args, opts);
    if (before && reply.status === 'ok') {
      const { revision: _r, ...rest } = args;
      rec.steps.push({ command: name, args: mapIds(structuredClone(rest), rec.pairs) });
      for (const l of ctx.store.doc?.layers || []) if (!before.has(l.id)) rec.pairs.push([l.id, `$new${++rec.newCount}`]);
    }
    return reply;
  };

  const store = () => { const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder'); return s; };
  const pathOf = (name) => { const n = safeName(name); if (!n) fail('invalid', 'name is one path segment without / \\ : * ? " < > |', 'fix_argument', 'record_action'); return `${ACTION_DIR}/${n}.json`; };

  bus.register('action.record', async (a, { viewOnly, door }) => {
    viewOnly();
    if (a.action === 'start') {
      if (rec) fail('invalid', `already recording ${rec.name}; stop or cancel it first`, 'fix_argument', 'record_action');
      const path = pathOf(a.name);
      rec = { name: a.name, path, pairs: startTokens(ctx.store.doc), steps: [], newCount: 0 };
      return { recording: a.name, path };
    }
    if (!rec) fail('invalid', 'not recording', 'fix_argument', 'record_action');
    const r = rec; rec = null;
    if (a.action === 'cancel') return { cancelled: r.name, steps: r.steps.length };
    if (!r.steps.length) fail('invalid', 'the recording holds no commands; nothing saved', 'fix_argument', 'record_action');
    const s = store();
    const body = enc.encode(`${JSON.stringify({ format: 'atelier-action', version: 1, name: r.name, recorded: new Date().toISOString(), steps: r.steps }, null, 2)}\n`);
    const write = async () => { await s.write(r.path, body); return { path: r.path, steps: r.steps }; };
    if (await s.exists(r.path)) return stageOrRun(ctx, { door }, 'record_action', `REPLACE action ${r.name}`, write, { force: true });
    return write();
  });

  bus.register('query.actions', async () => {
    const s = store();
    const out = [];
    for (const e of await s.list(ACTION_DIR)) {
      if (!e.path.endsWith('.json')) continue;
      try { const j = JSON.parse(await s.readText(e.path)); out.push({ name: j.name ?? e.path, path: e.path, steps: j.steps?.length ?? 0, commands: (j.steps || []).map((x) => x.command) }); }
      catch { out.push({ path: e.path, error: 'not valid JSON' }); }
    }
    return { actions: out, recording: rec ? { name: rec.name, steps: rec.steps.length } : null };
  });

  async function loadAction(name) {
    const s = store();
    const path = name.includes('/') || name.endsWith('.json') ? name : pathOf(name);
    if (!(await s.exists(path))) fail('invalid', `no action ${name}`, 'fix_argument', 'list_actions');
    let j; try { j = JSON.parse(await s.readText(path)); } catch (e) { fail('invalid', `${path} is not valid JSON: ${e.message}`, 'fix_argument', 'list_actions'); }
    if (j?.format !== 'atelier-action' || !Array.isArray(j.steps)) fail('invalid', `${path} is not an Atelier action`, 'fix_argument', 'list_actions');
    for (const st of j.steps) if (!recordable(st.command)) fail('unsupported', `${path}: step ${st.command} is not a replayable command`, 'fix_argument', 'list_actions');
    return { path, steps: j.steps };
  }

  // Replays steps on the open document; stops at the first step that does not answer ok.
  async function replay(steps, opts) {
    const doc = needDoc(ctx);
    const pairs = startTokens(doc).map(([id, tok]) => [tok, id]);
    const done = [];
    for (let i = 0; i < steps.length; i++) {
      const before = new Set(ctx.store.doc.layers.map((l) => l.id));
      const args = mapIds(structuredClone(steps[i].args || {}), pairs);
      if (/\$(active|layer:|new)/.test(JSON.stringify(args))) return { ok: false, done, failed: { step: i + 1, command: steps[i].command, status: 'invalid', message: 'a layer the action refers to does not exist in this document' } };
      if ('revision' in (tools.get(steps[i].command).inputSchema.properties || {})) args.revision = bus.state.revision;
      const r = await bus.dispatch(steps[i].command, args, opts);
      if (r.status !== 'ok') return { ok: false, done, failed: { step: i + 1, command: steps[i].command, status: r.status, message: r.error?.message ?? null, ...(r.stagedId ? { stagedId: r.stagedId } : {}) } };
      done.push(steps[i].command);
      let n = pairs.filter(([t]) => t.startsWith('$new')).length;
      for (const l of ctx.store.doc.layers) if (!before.has(l.id)) pairs.push([`$new${++n}`, l.id]);
    }
    return { ok: true, done };
  }

  bus.register('action.run', async (a, { viewOnly, door, caller }) => {
    viewOnly();   // each replayed step bumps the revision itself
    const { path, steps } = await loadAction(a.name);
    const opts = { door, caller: `action ${a.name}${caller ? ` (${caller})` : ''}` };
    ctx.replaying = true;
    try {
      if (!a.paths?.length) {
        const r = await replay(steps, opts);
        return { action: path, steps: steps.length, ...r };
      }
      // Batch: open each photo, replay, save (a single RAW photo saves to its sidecar). A photo whose replay
      // fails is not saved and the batch goes on; the open document is the last photo afterwards.
      const photos = [];
      for (const p of a.paths) {
        const o = await bus.dispatch('open_photo', { path: p }, opts);
        if (o.status !== 'ok') { photos.push({ path: p, ok: false, failed: { step: 0, command: 'open_photo', status: o.status, message: o.error?.message ?? null } }); continue; }
        const r = await replay(steps, opts);
        if (r.ok) {
          const sv = await bus.dispatch('save_document', { revision: bus.state.revision }, opts);
          if (sv.status !== 'ok') { photos.push({ path: p, ...r, ok: false, failed: { step: steps.length + 1, command: 'save_document', status: sv.status, message: sv.error?.message ?? null } }); continue; }
          photos.push({ path: p, ...r, saved: sv.result.path });
        } else photos.push({ path: p, ...r });
      }
      return { action: path, steps: steps.length, photos, ok: photos.every((x) => x.ok), failedCount: photos.filter((x) => !x.ok).length };
    } finally { ctx.replaying = false; }
  });
}
