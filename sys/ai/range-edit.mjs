// Editor-to-Anvil edits operate on a private, exact-file snapshot. A proposal
// never writes its source; the source app owns review and conditional apply.
import { normalizeMountPath } from '../rig/fileops/pathguard.mjs';
import { MemoryBackend } from '../rig/fileops/memory-backend.mjs';
import { reviewVersion, buildReviewDiff } from './review-diff.mjs';

export const RANGE_EDIT_LIMITS = Object.freeze({ bytes: 256 * 1024, instruction: 4000, lines: 1000, context: 16000 });
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM:true });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

function text(value, limit, label) {
  if (typeof value !== 'string' || value.length > limit || value.includes('\0') || encoder.encode(value).length > limit) {
    fail('EINVAL', `${label} is not bounded text`);
  }
  // Reject unpaired UTF-16 surrogates rather than silently changing source bytes.
  if (decoder.decode(encoder.encode(value)) !== value) fail('EINVAL', `${label} has invalid Unicode`);
  return value;
}

function snapshotBytes(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > RANGE_EDIT_LIMITS.bytes) {
    fail('EFBIG', 'Snapshot exceeds its byte limit or is not a byte array');
  }
  text(decoder.decode(bytes), RANGE_EDIT_LIMITS.bytes, 'Snapshot');
  return bytes.slice();
}

export function rangeEditRequest(input) {
  if (!input || typeof input !== 'object') fail('EINVAL', 'Missing range edit');
  const path = normalizeMountPath(input.path);
  if (!path.ok || !path.path || path.path !== input.path || path.segments.some(p => p === '.git' || p === '.anvil')) {
    fail('EINVAL', 'Range edit needs one canonical source-file path');
  }
  const before = text(input.before, RANGE_EDIT_LIMITS.bytes, 'Source');
  const instruction = text(input.instruction, RANGE_EDIT_LIMITS.instruction, 'Instruction').trim();
  if (!instruction) fail('EINVAL', 'An instruction is required');
  const sourceLines = before.split('\n');
  const { start, end } = input.selection || {};
  // Deleted rows anchor before the next surviving line, including EOF + 1.
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start
      || end > sourceLines.length + 1 || end - start + 1 > RANGE_EDIT_LIMITS.lines) {
    fail('EINVAL', 'Invalid or oversized selection anchors');
  }
  const project = text(input.project, 512, 'Project');
  if (!project || !['browser', 'fsa', 'crate'].includes(input.backend)) fail('EINVAL', 'Missing source workspace identity');
  const version = reviewVersion(before);
  if (input.version !== undefined && input.version !== version) fail('ESTALE', 'Selection source changed');
  const context = sourceLines.slice(Math.max(0, start - 4), Math.min(sourceLines.length, end + 3)).join('\n');
  if (encoder.encode(context).length > RANGE_EDIT_LIMITS.context) fail('EFBIG', 'Selected context exceeds its byte limit');
  return Object.freeze({ path: path.path, project, backend: input.backend, before, instruction, version,
    selection: Object.freeze({ start, end }), context });
}

export function rangeEditProposal(request, after) {
  const baseline = rangeEditRequest(request);
  text(after, RANGE_EDIT_LIMITS.bytes, 'Proposed file');
  const diff = buildReviewDiff({ before: baseline.before, after, beforePath: baseline.path });
  if (diff.state !== 'text') fail('EFBIG', 'Proposed change exceeds bounded line review');
  return Object.freeze({ ...baseline, after, afterVersion: reviewVersion(after), diff });
}

export function rangeEditPrompt(request) {
  const r = rangeEditRequest(request);
  return 'Edit the one granted snapshot file. The source remains unchanged until Editor reviews and applies the proposal. '
    + 'Read the file first. Keep the edit anchored to the selected working-file lines.\n'
    + JSON.stringify({ file: r.path, project: r.project, backend: r.backend, baseline: r.version,
      lines: r.selection, instruction: r.instruction, context: r.context });
}

// The backing map is private. Even direct app tools cannot write sibling files,
// replace a parent directory, create a symlink, or use a stale session.
export function createRangeEditBackend(request, { valid = () => true } = {}) {
  const r = rangeEditRequest(request), store = new MemoryBackend();
  store.files.set(r.path, { bytes: encoder.encode(r.before), mtimeMs: Date.now() });
  const parents = new Set(['']);
  const parts = r.path.split('/');
  for (let i = 1; i < parts.length; i++) parents.add(parts.slice(0, i).join('/'));
  let active = true;
  const check = () => { if (!active || !valid()) fail('ESTALE', 'Range edit session expired or changed'); };
  const file = path => { check(); if (path !== r.path) fail('EACCES', 'Only the selected file is granted'); };
  const backend = {
    supportsBoundedReads: true, supportsMetadataOnly: true, supportsNoFollowMutation: true,
    supportsConditionalWrite: true, supportsConditionalDelete: false,
    async readBinary(path, options) { file(path); return store.readBinary(path, options); },
    async write(path, bytes, options) {
      file(path); const value = snapshotBytes(bytes);
      return store.write(path, value, options);
    },
    async conditionalWrite(path, bytes, options) {
      file(path); const value = snapshotBytes(bytes);
      return store.conditionalWrite(path, value, options);
    },
    async delete() { check(); fail('EACCES', 'The source file cannot be removed by a range edit'); },
    async mkdir(path) { check(); if (!parents.has(path)) fail('EACCES', 'No new directory is granted'); },
    async exists(path) { check(); return path === r.path || parents.has(path); },
    async stat(path) {
      check(); if (path === r.path) return store.stat(path);
      return parents.has(path) ? { type: 'dir', size: 0, mtimeMs: 0 } : null;
    },
    async list(prefix, { maxEntries } = {}) {
      check(); const result = [];
      if (maxEntries !== undefined && (!Number.isSafeInteger(maxEntries) || maxEntries < 1)) fail('EINVAL', 'Invalid listing limit');
      if (!parents.has(prefix)) return result;
      const rest = r.path.slice(prefix ? prefix.length + 1 : 0), slash = rest.indexOf('/');
      result.push((prefix ? prefix + '/' : '') + (slash < 0 ? rest : rest.slice(0, slash + 1)));
      return result;
    },
  };
  return Object.freeze({ request: r, backend,
    proposal() { check(); return rangeEditProposal(r, decoder.decode(store.files.get(r.path).bytes)); },
    revoke() { active = false; store.files.clear(); },
  });
}

// The compare and put share one readwrite transaction. No await occurs between
// them. Another tab's overlapping writer runs wholly before or after this one.
export function compareRangeEditIdb(db, storeName, key, expected, replacement, { valid = () => true, signal = null } = {}) {
  text(expected, RANGE_EDIT_LIMITS.bytes, 'Expected source');
  text(replacement, RANGE_EDIT_LIMITS.bytes, 'Replacement');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite'), store = tx.objectStore(storeName);
    let failure = null;
    const abort=()=>{failure=Object.assign(new Error('Source operation cancelled'),{code:'ECANCELED'});try{tx.abort()}catch{}};
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    tx.oncomplete = () => {cleanup();resolve(true)};
    tx.onabort = tx.onerror = () => {cleanup();reject(failure || tx.error || new Error('Conditional source write failed'))};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    const read = store.get(key);
    read.onsuccess = () => {
      try {
        if (!valid() || typeof read.result !== 'string' || read.result !== expected) {
          failure = Object.assign(new Error('Source changed; the staged edit was not applied'), { code: 'ESTALE' });
          tx.abort(); return;
        }
        store.put(replacement, key);
      } catch (error) {
        failure = error;
        try { tx.abort(); } catch { reject(error); }
      }
    };
  });
}
