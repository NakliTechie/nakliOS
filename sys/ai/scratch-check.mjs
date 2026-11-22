// The finish check for scratch files. A run that creates throwaway files (a quick `tmp/t.mjs` to try
// the code, a `check.mjs` beside the work) and does not delete them leaves the owner's workspace
// dirtier than the ask. The 2026-11-11 compaction bench and the 2026-11-22 harness bench both found
// it: 8 of 10 Anvil runs had correct code and still failed the "no files outside the ask" check,
// while Pi, fx and nanocode put their scratch files in the system /tmp. A prompt rule is a request,
// so this is a check: once per run, before the run finishes, the loop asks the model about every
// file the run CREATED whose path the ask does not name. The model decides; nothing is deleted here.

// Anvil's own state and git's are never the model's scratch.
const OWN = /^(?:\.anvil|\.git)(?:\/|$)/;
export const SCRATCH_LIST_LIMIT = 20;

// Does the ask name this path — the path itself, its file name, or one of its folders ("test/")?
export function askNames(ask, path) {
  const text = String(ask || '');
  if (!text) return false;
  const p = String(path);
  if (text.includes(p)) return true;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (base && new RegExp('(^|[^\\w.-])' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w.-])').test(text)) return true;
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) if (text.includes(parts.slice(0, i).join('/') + '/')) return true;
  return false;
}

// The created files the ask does not name, sorted, Anvil's own state left out.
export function unaskedNewFiles(created, ask) {
  return [...new Set(created || [])].filter((p) => typeof p === 'string' && p && !OWN.test(p) && !askNames(ask, p)).sort();
}

// The words the model sees. The loop prefixes "[coordination] " and records the exact bytes.
export function scratchNote(paths) {
  const shown = paths.slice(0, SCRATCH_LIST_LIMIT).map((p) => '`' + p + '`').join(', ');
  const more = paths.length > SCRATCH_LIST_LIMIT ? ` and ${paths.length - SCRATCH_LIST_LIMIT} more` : '';
  const n = paths.length;
  return `Before you finish: this run created ${n} file${n === 1 ? '' : 's'} the request did not name: ${shown}${more}. `
    + 'Delete any that are scratch or check files you made for your own testing; keep the ones the request needs. Then finish as before.';
}

// The loop's `finishCheck`: `created` lists the paths this run created (async or not). At most one
// note per run, however many loops the driver runs; a failing listing never blocks the finish.
export function makeFinishCheck({ created, ask }) {
  let fired = false;
  return async () => {
    if (fired) return null;
    let paths = [];
    try { paths = unaskedNewFiles(await created(), ask); } catch (_) { return null; }
    if (!paths.length) return null;
    fired = true;
    return scratchNote(paths);
  };
}
