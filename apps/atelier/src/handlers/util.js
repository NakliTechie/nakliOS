import { CommandError } from '../bus.js';
import { findLayer } from '../document.js';

export const fail = (status, message, action, tool) => { throw new CommandError(status, message, { action, tool }); };
export function needDoc(ctx) { const d = ctx.store?.doc; if (!d) fail('unsupported', 'no open document', 'change_target', 'new_document'); return d; }
export function needLayer(ctx, id, { unlocked = true } = {}) {
  const doc = needDoc(ctx);
  const l = findLayer(doc, id ?? doc.activeLayerId);
  if (!l) fail('invalid', `no layer ${id}`, 'get_state', 'get_state');
  if (unlocked && l.locked) fail('unsupported', `layer ${l.name} is locked`, 'change_target', 'set_layer');
  return l;
}
// Applies a change through the store (undoable), then re-renders. touched: buffer ids the change edits.
// A change the renderer cannot draw is rolled back before anything else sees it, so a bad value never
// stays stored (and never reaches autosave).
export async function change(ctx, label, fn, touched = []) {
  const out = ctx.store.mutate(label, fn, touched);
  try { await ctx.sync(); } catch (e) {
    ctx.store.rollback();
    try { await ctx.sync(); } catch { /* the previous state rendered before; nothing more to do */ }
    const { CommandError } = await import('../bus.js');
    throw new CommandError(e.code === 'unsupported' ? 'unsupported' : 'invalid', `nothing applied: the change could not be rendered (${e.message})`, { action: 'fix_argument', tool: 'get_state' });
  }
  return out;
}
export const layerRow = (l) => ({
  id: l.id, name: l.name, kind: l.kind, ...(l.clipped ? { clipped: true } : {}), ...(l.adjustment ? { adjustment: l.adjustment } : {}), ...(l.quad ? { corners: l.quad } : {}), ...(l.lensBlur ? { lensBlur: l.lensBlur } : {}), ...(l.parentId ? { parentId: l.parentId } : {}), ...(l.kind === 'group' ? { isolation: l.isolation } : {}), ...(l.localOf ? { localOf: l.localOf } : {}), visible: l.visible, locked: l.locked, opacity: Math.round(l.opacity * 100), fill: Math.round(l.fill * 100), blendMode: l.blend,
  mask: l.mask ? { components: l.mask.components.map((c) => `${c.op}:${c.kind}`), invert: !!l.mask.invert } : null,
  ...(l.kind === 'raw' ? { develop: Object.fromEntries(Object.entries(l.develop || {}).filter(([, v]) => v !== 0)), curve: !!l.curve } : {}),
  ...(l.kind === 'text' ? { text: l.text.content.slice(0, 80) } : {}),
});

// Irreversible work (writing files) waits for the person unless the call came from the person's own
// click (door 'ui') or through the NakliOS rail, where the host has already reviewed it. Returns the
// result when it runs now; otherwise throws status 'staged' with the staged id.
// force: stage even for the person's own click or a host-reviewed call (replacing a file that exists is person-only).
export async function stageOrRun(ctx, { door }, tool, summary, run, { force = false } = {}) {
  if (!force && (door === 'ui' || door === 'rail')) return run();
  const id = `st${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  ctx.staged.set(id, { id, tool, summary, run, at: new Date().toISOString(), revision: ctx.bus?.state.revision ?? null });
  ctx.onStaged?.();
  const { CommandError } = await import('../bus.js');
  throw new CommandError('staged', `${tool} waits for the person to confirm: ${summary}`, { action: 'get_staged', tool: 'get_staged' }, { stagedId: id });
}

// Runs a staged action as a job (called from the person's Confirm click). Returns the job record.
export async function runStaged(ctx, id) {
  const s = ctx.staged.get(id);
  if (!s) return null;
  ctx.staged.delete(id);
  const job = { id: `job-${id}`, tool: s.tool, summary: s.summary, state: 'running', started: new Date().toISOString() };
  ctx.jobs.set(job.id, job);
  // The person approved what the document was when staged; a later change makes that approval stale.
  if (s.revision !== null && ctx.bus && ctx.bus.state.revision !== s.revision) { job.state = 'stale'; job.error = `the document changed since this was staged (revision ${s.revision} → ${ctx.bus.state.revision}); stage it again`; }
  else { try { job.result = await s.run(); job.state = 'done'; } catch (e) { job.state = 'failed'; job.error = e.message; } }
  ctx.bus?.state.editList.push({ command: s.tool, door: 'ui', caller: 'person (confirmed staged)', args: { stagedId: id }, revision: ctx.bus.state.revision, at: job.finished ?? new Date().toISOString() });
  job.finished = new Date().toISOString();
  ctx.onStaged?.();
  return job;
}
