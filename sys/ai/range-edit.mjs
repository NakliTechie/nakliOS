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
export function compareRangeEditIdb(db, storeName, key, expected, replacement, { valid = () => true, signal = null, journal = null } = {}) {
  text(expected, RANGE_EDIT_LIMITS.bytes, 'Expected source');
  text(replacement, RANGE_EDIT_LIMITS.bytes, 'Replacement');
  return new Promise((resolve, reject) => {
    const tx = db.transaction(journal ? [storeName, journal.store] : storeName, 'readwrite'), store = tx.objectStore(storeName);
    let failure = null;
    const abort=()=>{failure=Object.assign(new Error('Source operation cancelled'),{code:'ECANCELED'});try{tx.abort()}catch{}};
    const cleanup=()=>signal?.removeEventListener('abort',abort);
    tx.oncomplete = () => {cleanup();resolve(true)};
    tx.onabort = tx.onerror = () => {cleanup();reject(failure || tx.error || new Error('Conditional source write failed'))};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    const compare = () => {
    const read = store.get(key);
    read.onsuccess = () => {
      try {
        if (!valid() || typeof read.result !== 'string' || read.result !== expected) {
          failure = Object.assign(new Error('Source changed; the staged edit was not applied'), { code: 'ESTALE' });
          tx.abort(); return;
        }
        store.put(replacement, key);
        if (journal) tx.objectStore(journal.store).put(journal.value, key);
      } catch (error) {
        failure = error;
        try { tx.abort(); } catch { reject(error); }
      }
    };
    };
    if(journal){
      const prior=tx.objectStore(journal.store).get(key);
      prior.onsuccess=()=>{
        const priorState=prior.result?.state,nextState=journal.value.state;
        const allowed=nextState==='applied'?['staged','reviewed'].includes(priorState):nextState==='reverted'&&priorState==='applied';
        if(prior.result?.id!==journal.value.id||!allowed){failure=Object.assign(new Error('Retained proposal changed'),{code:'ESTALE'});tx.abort();return}compare();
      };
    }else compare();
  });
}

// Persist only validated proposal data. Host tokens and delivery authority never
// survive app reload. Restore requires exact source bytes, not a version hash.
export function rangeEditRecord(stage, id) {
  if (typeof id !== 'string' || !id || id.length > 128) fail('EINVAL', 'Invalid proposal identity');
  if (!['staged', 'reviewed', 'applied', 'reverted', 'cleanup'].includes(stage?.state)) fail('EINVAL', 'Invalid proposal state');
  const proposal = rangeEditProposal(stage.proposal, stage.proposal.after);
  if (proposal.backend !== 'browser' || proposal.project !== 'editor:browser') fail('EINVAL', 'Only Browser proposals can be retained');
  const run = stage.run;
  if (!run || typeof run.task !== 'string' || run.task.length > 128 || typeof run.project !== 'string'
      || run.project.length > 128 || !Number.isSafeInteger(run.sequence) || run.sequence < 1) fail('EINVAL', 'Invalid proposal run');
  const {after, diff, afterVersion, ...request} = proposal;
  return {version:1, id, request, after, run:{task:run.task,project:run.project,sequence:run.sequence},state:stage.state};
}

export function restoreRangeEditRecord(record, path, current) {
  if (!record || record.version !== 1) fail('EINVAL', 'Invalid saved proposal');
  const proposal = rangeEditProposal(record.request, record.after);
  const clean = rangeEditRecord({proposal,run:record.run,state:record.state},record.id);
  if (proposal.path !== path || current !== (clean.state === 'applied' ? proposal.after : proposal.before)) {
    fail('ESTALE', 'Saved proposal no longer matches the file');
  }
  // Reviewing again is required after restart, even if it was reviewed earlier.
  return {proposal,run:clean.run,state:clean.state === 'reviewed' ? 'staged' : clean.state,id:clean.id};
}

// One bounded record per path. A concurrent Editor cannot replace another
// proposal or downgrade an applied state with a late delivery replay.
export function retainRangeEditIdb(db, storeName, path, record, {signal=null,valid=()=>true,filesStore=null}={}) {
  const clean = rangeEditRecord({proposal:rangeEditProposal(record.request,record.after),run:record.run,state:record.state},record.id);
  if (clean.request.path !== path) fail('EINVAL', 'Proposal path mismatch');
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(filesStore?[storeName,filesStore]:storeName,'readwrite'),store=tx.objectStore(storeName);
    let failure;
    const abort=(message,code='ESTALE')=>{failure=Object.assign(new Error(message),{code});try{tx.abort()}catch{}};
    const cancel=()=>abort('Proposal retention cancelled','ECANCELED');
    const cleanup=()=>signal?.removeEventListener('abort',cancel);
    tx.oncomplete=()=>{cleanup();resolve(true)};tx.onabort=tx.onerror=()=>{cleanup();reject(failure||tx.error||new Error('Proposal retention failed'))};
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return}
    const validate=next=>{
      const accept=()=>{try{if(!valid()){abort('Proposal receipt context changed');return}next()}catch(error){failure=error;tx.abort()}};
      if(filesStore){const source=tx.objectStore(filesStore).get(path);source.onsuccess=()=>{if(source.result!==clean.request.before){abort('Source changed before proposal receipt');return}accept()}}
      else accept();
    };
    const existing=store.get(path);
    existing.onsuccess=()=>{
      if(existing.result){
        if(existing.result.id!==clean.id){abort('A different proposal is already retained');return}
        // Delivery retries are idempotent; never reset a later applied state.
        if(JSON.stringify(existing.result.request)!==JSON.stringify(clean.request)||existing.result.after!==clean.after){abort('Proposal identity changed');return}
        validate(()=>{});return;
      }
      const count=store.count();count.onsuccess=()=>{
        if(count.result>=16){abort('Discard an old proposal before retaining another');return}
        validate(()=>store.put(clean,path));
      };
    };
  });
}

// Commit cancellation intent before attempting journal deletion. A failed delete
// must never restore this receipt as an actionable proposal after restart.
export function cancelRangeEditIdb(db,storeName,path,id){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(storeName,'readwrite'),store=tx.objectStore(storeName),read=store.get(path);
    let failure;
    read.onsuccess=()=>{
      const record=read.result;
      if(record?.id!==id||!['staged','cleanup'].includes(record.state)){
        failure=Object.assign(new Error('Retained proposal changed before cancellation'),{code:'ESTALE'});tx.abort();return;
      }
      try{store.put(rangeEditRecord({proposal:rangeEditProposal(record.request,record.after),run:record.run,state:'cleanup'},id),path)}
      catch(error){failure=error;tx.abort()}
    };
    tx.oncomplete=()=>resolve(true);tx.onabort=tx.onerror=()=>reject(failure||tx.error||new Error('Proposal cancellation retention failed'));
  });
}

export function discardRangeEditIdb(db,storeName,path,id,expectedState,{filesStore=null,allowStaleApplied=false}={}){
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(filesStore?[storeName,filesStore]:storeName,'readwrite'),store=tx.objectStore(storeName),read=store.get(path);
    let failure;
    const refuse=()=>{failure=Object.assign(new Error('Retained proposal changed or still requires Revert'),{code:'ESTALE'});tx.abort()};
    read.onsuccess=()=>{
      if(read.result?.id!==id||read.result.state!==expectedState){refuse();return}
      if(read.result.state==='applied'){
        if(!allowStaleApplied||!filesStore||read.result.request?.path!==path){refuse();return}
        const source=tx.objectStore(filesStore).get(path);
        source.onsuccess=()=>{if((source.result!==undefined&&typeof source.result!=='string')||source.result===read.result.after){refuse();return}store.delete(path)};
        return;
      }
      store.delete(path);
    };
    tx.oncomplete=()=>resolve(true);tx.onabort=tx.onerror=()=>reject(failure||tx.error||new Error('Proposal discard failed'));
  });
}

export function openRangeEditDatabase(name,store,{version=1,journal=false}={}){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const request=indexedDB.open(name,version);
    request.onupgradeneeded=()=>{
      if(settled){request.transaction.abort();return}
      if(!request.result.objectStoreNames.contains(store))request.result.createObjectStore(store);
      if(journal&&!request.result.objectStoreNames.contains('range-edits'))request.result.createObjectStore('range-edits');
    };
    request.onsuccess=()=>{if(settled){request.result.close();return}settled=true;request.result.onversionchange=()=>request.result.close();resolve(request.result)};
    request.onerror=()=>{if(!settled){settled=true;reject(request.error)}};
    request.onblocked=()=>{if(!settled){settled=true;reject(Object.assign(new Error('Close older Editor tabs to update proposal storage.'),{code:'ELOCKED'}))}};
  });
}
