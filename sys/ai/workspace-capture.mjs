// B01: bounded, backend-independent observation of a run's workspace.
// A difference is observed during the run, not proof that the agent caused it.
import { buildChangeRow } from './change-preimages.mjs';

export const CAPTURE_FILE_LIMIT = 3000;
export const CAPTURE_READ_LIMIT = 64 * 1024;
export const CAPTURE_TOTAL_LIMIT = 8 * 1024 * 1024;

function byteDigest(bytes) {
  let h = 0x811c9dc5;
  for (const byte of bytes) { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; }
  return `bytes:${bytes.length}:${(h >>> 0).toString(36)}`;
}

function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

export async function snapshotWorkspace(fs, { fileLimit = CAPTURE_FILE_LIMIT, readLimit = CAPTURE_READ_LIMIT,
  totalLimit = CAPTURE_TOTAL_LIMIT } = {}) {
  const files = new Map(), problems = [];
  let listing;
  try { listing = await fs.list('', { recursive: true }); }
  catch (e) { return { files, listed: false, complete: false, problems: [`workspace listing failed: ${String(e?.message || e)}`] }; }
  if (!listing?.ok || !Array.isArray(listing.entries)) {
    return { files, listed: false, complete: false, problems: [`workspace listing failed: ${listing?.code || 'invalid result'}`] };
  }
  const unsupported = listing.entries.filter(e => e?.type !== 'dir' && e?.type !== 'file');
  if (unsupported.length) problems.push(`${unsupported.length} non-file entries were not captured`);
  const entries = listing.entries.filter(e => e?.type === 'file' || e?.type === 'dir').sort((a, b) => String(a.path).localeCompare(String(b.path)));
  if (entries.length > fileLimit) problems.push(`workspace has ${entries.length} files; capture limit is ${fileLimit}`);
  let used = 0;
  for (const entry of entries.slice(0, fileLimit)) {
    const path = String(entry.path || '');
    if (!path) continue;
    if (entry.type === 'dir') { files.set(path, { known: true, directory: true, hash: 'directory' }); continue; }
    if (used >= totalLimit) {
      files.set(path, { known: false });
      continue;
    }
    let read;
    try { read = await fs.read(path, { maxBytes: Math.min(readLimit, totalLimit - used) }); }
    catch (e) { read = { ok: false, code: String(e?.code || 'EIO') }; }
    if (!read?.ok || !(read.data instanceof Uint8Array)) {
      files.set(path, { known: false });
      problems.push(`${path}: bounded read ${read?.code || 'unavailable'}`);
      continue;
    }
    const bytes = read.data;
    used += bytes.length;
    files.set(path, { known: true, hash: byteDigest(bytes), text: decodeText(bytes), size: bytes.length });
  }
  if (used >= totalLimit && entries.length > files.size) problems.push(`workspace byte limit ${totalLimit} reached`);
  return { files, listed: entries.length <= fileLimit && unsupported.length === 0,
    complete: problems.length === 0, problems };
}

export function compareSnapshots(before, after) {
  const changed = [], unknown = [];
  const paths = new Set([...(before?.files?.keys() || []), ...(after?.files?.keys() || [])]);
  for (const path of [...paths].sort()) {
    const a = before.files.get(path), b = after.files.get(path);
    if ((!a && !before.listed) || (!b && !after.listed) || (a && b && (!a.known || !b.known))) {
      unknown.push(path); continue;
    }
    if (a && b && a.hash === b.hash) continue;
    changed.push({ path, before: a || null, after: b || null });
  }
  return { changed, unknown };
}

function rowFor({ path, before, after }, run) {
  const created = !before, deleted = !after;
  if (before?.directory || after?.directory) return {
    k: 'change', file: path, verb: deleted ? 'removed directory' : created ? 'created directory' : 'changed directory',
    run, observed: true, directory: true, pre: null, postHash: null,
    preUnavailable: 'directory changes require manual review',
  };
  const pre = before?.known ? before.text : null;
  const post = after?.known ? after.text : null;
  const row = buildChangeRow({ file: path, verb: deleted ? 'deleted' : created ? 'created' : 'changed',
    pre: created ? '' : pre, post });
  row.run = run;
  row.observed = true;
  row.created = created;
  row.deleted = deleted;
  row.binary = (before && before.text == null) || (after && after.text == null) || false;
  if (created) row.pre = '';
  if (deleted) row.postHash = 'absent';
  if (row.binary) {
    row.pre = null;
    row.preUnavailable = 'binary content; review the file bytes before changing it';
    if (after) row.postHash = after.hash;
  }
  if (before && !before.known) row.preUnavailable = 'bounded pre-image unavailable';
  if (after && !after.known) row.postHash = null;
  return row;
}

export function createWorkspaceCapture(fs, run, options = {}) {
  let baseline = null, current = null;
  const touched = new Set(), problems = new Set();
  async function take() {
    const snap = await snapshotWorkspace(fs, options);
    for (const problem of snap.problems) problems.add(problem);
    return snap;
  }
  return {
    async start() { baseline = current = await take(); return { complete: baseline.complete, problems: [...problems] }; },
    async observe() {
      if (!current) return;
      const next = await take();
      for (const change of compareSnapshots(current, next).changed) touched.add(change.path);
      current = next;
    },
    async finish() {
      if (!baseline) return { rows: [], touched: [], complete: false, problems: ['capture never started'] };
      await this.observe();
      const net = compareSnapshots(baseline, current);
      for (const path of net.unknown) problems.add(`${path}: net change could not be determined`);
      const rows = net.changed.map(change => ({ ...rowFor(change, run), captureIncomplete: problems.size !== 0 }));
      return { rows, touched: [...touched].sort(), complete: problems.size === 0,
        problems: [...problems], netUnknown: net.unknown };
    },
  };
}
