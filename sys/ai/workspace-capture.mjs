// B01: bounded, backend-independent observation of a run's workspace.
// A difference is observed during the run, not proof that the agent caused it.
import {utf8ByteLengthWithin} from './text-byte-bound.mjs';
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

export const CAPTURE_PATH_LIMIT = 4096;
export const CAPTURE_METADATA_LIMIT = 1024 * 1024;
const PROBLEM_LIMIT = 64;
const PAGE_LIMIT = 256;

// Count UTF-8 bytes without allocating an encoded copy.
export function captureTextWithinBound(text, limit = CAPTURE_CHECKPOINT_LIMIT) {
  return utf8ByteLengthWithin(text,limit)!==null;
}
function capturePath(path) {
  return typeof path === 'string' && path.length > 0 && captureTextWithinBound(path, CAPTURE_PATH_LIMIT)
    && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f]/.test(path)
    && !path.split('/').some(part => !part || part === '.' || part === '..');
}
function addProblem(problems, text) {
  if (problems.size < PROBLEM_LIMIT) problems.add(String(text).slice(0, 500));
}
function boundedOption(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('invalid capture bound');
  return value;
}

export async function snapshotWorkspace(fs, { fileLimit = CAPTURE_FILE_LIMIT, readLimit = CAPTURE_READ_LIMIT,
  totalLimit = CAPTURE_TOTAL_LIMIT } = {}) {
  boundedOption(fileLimit, CAPTURE_FILE_LIMIT); boundedOption(readLimit, CAPTURE_READ_LIMIT); boundedOption(totalLimit, CAPTURE_TOTAL_LIMIT);
  const files = new Map(), problems = new Set(), entries = [], seen = new Set(), directories = [''];
  let listed = true, metadata = 0, pages = 0;
  const problem = text => { listed = false; addProblem(problems, text); };
  if (!fileLimit) problem('workspace entry capture limit is zero');
  outer: for (let directoryIndex = 0; listed && directoryIndex < directories.length; directoryIndex++) {
    const directory = directories[directoryIndex];
    let cursor = null;
    const cursors = new Set();
    do {
      // Keep page size stable because backend cursors bind it. At most one extra
      // page establishes whether a workspace exactly at the limit is exhausted.
      if (++pages > CAPTURE_FILE_LIMIT * 2 + 1) { problem('workspace listing page limit reached'); break outer; }
      let page;
      try { page = await fs.list(directory, { recursive: false, maxEntries: PAGE_LIMIT, cursor }); }
      catch (_) { problem('workspace bounded listing failed'); break outer; }
      if (!page?.ok || !Array.isArray(page.entries) || page.entries.length > PAGE_LIMIT) {
        problem('workspace bounded listing failed: ' + (typeof page?.code === 'string' ? page.code.slice(0, 32) : 'invalid result')); break outer;
      }
      if (page.snapshotConsistent !== true) addProblem(problems, 'workspace listing is live; absence cannot be certified');
      for (const entry of page.entries) {
        const path = entry?.path;
        if (!capturePath(path) || path.slice(0, path.lastIndexOf('/') + 1) !== (directory ? directory + '/' : '')
            || seen.has(path) || !['file', 'dir'].includes(entry.type)) {
          problem('workspace listing contains invalid, duplicate, or unsupported metadata'); break outer;
        }
        if (entries.length >= fileLimit || metadata + path.length * 6 + 256 > CAPTURE_METADATA_LIMIT) {
          problem('workspace entry or metadata capture limit reached'); break outer;
        }
        metadata += path.length * 6 + 256; seen.add(path);
        entries.push({ path, type: entry.type });
        if (entry.type === 'dir') directories.push(path);
      }
      if (page.truncated !== true) break;
      if (typeof page.cursor !== 'string' || !page.cursor || page.cursor.length > CAPTURE_PATH_LIMIT * 2
          || cursors.has(page.cursor) || !page.entries.length) {
        problem('workspace listing cursor is unavailable or repeated'); break outer;
      }
      cursors.add(page.cursor); cursor = page.cursor;
    } while (true);
  }
  // A live listing can still establish observations of known files. It cannot
  // prove that unobserved paths were absent, even after its final page.
  if (problems.has('workspace listing is live; absence cannot be certified')) listed = false;
  entries.sort((a, b) => a.path.localeCompare(b.path));
  let used = 0;
  for (const entry of entries) {
    const path = entry.path;
    if (entry.type === 'dir') { files.set(path, { known: true, directory: true, hash: 'directory' }); continue; }
    if (used >= totalLimit || !readLimit) { files.set(path, { known: false }); addProblem(problems, 'workspace byte capture limit reached'); continue; }
    const maxBytes = Math.min(readLimit, totalLimit - used);
    let read;
    try { read = await fs.read(path, { maxBytes }); }
    catch (_) { read = { ok: false, code: 'EIO' }; }
    if (!read?.ok || !(read.data instanceof Uint8Array) || read.data.length > maxBytes) {
      files.set(path, { known: false });
      addProblem(problems, path.slice(0, 400) + ': bounded read ' + (typeof read?.code === 'string' ? read.code.slice(0, 32) : 'unavailable'));
      continue;
    }
    const bytes = read.data; used += bytes.length;
    files.set(path, { known: true, hash: byteDigest(bytes), text: decodeText(bytes), size: bytes.length });
  }
  return { files, listed, complete: problems.size === 0, problems: [...problems] };
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
  if (!Number.isSafeInteger(run) || run < 0) throw new Error('invalid capture run');
  let baseline = null, current = null;
  const touched = new Set(), problems = new Set();
  async function take() {
    const snap = await snapshotWorkspace(fs, options);
    for (const problem of snap.problems) addProblem(problems, problem);
    return snap;
  }
  return {
    async start() { baseline = current = await take(); return { complete: baseline.complete, problems: [...problems] }; },
    checkpoint(){
      if(!baseline)throw new Error('capture never started');
      // JSON escaping needs at most six bytes per UTF-16 code unit. Check
      // this conservative budget before allocating the serialized checkpoint.
      let budget = 256;
      for (const [path, row] of baseline.files) {
        budget += 256 + path.length * 6 + (row.text?.length || 0) * 6;
        if (budget > CAPTURE_CHECKPOINT_LIMIT) throw new Error('capture checkpoint exceeds serialization bound');
      }
      return JSON.stringify({version:1,run,listed:baseline.listed,files:[...baseline.files]});
    },
    async observe() {
      if (!current) return;
      const next = await take();
      for (const change of compareSnapshots(current, next).changed) {
        if (touched.size < CAPTURE_FILE_LIMIT) touched.add(change.path);
        else addProblem(problems, 'workspace touched-path limit reached');
      }
      current = next;
    },
    async finish() {
      if (!baseline) return { rows: [], touched: [], complete: false, problems: ['capture never started'] };
      await this.observe();
      const net = compareSnapshots(baseline, current);
      for (const path of net.unknown) addProblem(problems, `${path}: net change could not be determined`);
      const rows = net.changed.map(change => ({ ...rowFor(change, run), captureIncomplete: problems.size !== 0 }));
      return { rows, touched: [...touched].sort(), complete: problems.size === 0,
        problems: [...problems], netUnknown: net.unknown };
    },
  };
}

// Private restart evidence. A recovered difference is observed, never attributed.
export const CAPTURE_CHECKPOINT_LIMIT = 64 * 1024 * 1024;
export function decodeCaptureCheckpoint(text, run) {
  if(!captureTextWithinBound(text)) throw new Error('capture checkpoint exceeds bound');
  const value=JSON.parse(text);
  if(value?.version!==1 || value.run!==run || !Array.isArray(value.files) || value.files.length>CAPTURE_FILE_LIMIT || typeof value.listed!=='boolean') throw new Error('invalid capture checkpoint');
  const files=new Map();let total=0, metadata=0;
  for(const pair of value.files){
    if(!Array.isArray(pair) || pair.length!==2)throw new Error('invalid capture entry');
    const [name,row]=pair;
    if(!capturePath(name) || files.has(name))throw new Error('invalid capture path');
    metadata += name.length * 6 + 256; if(metadata>CAPTURE_METADATA_LIMIT)throw new Error('capture metadata exceeds bound');
    if(!row || typeof row.known!=='boolean')throw new Error('invalid capture state');
    if(row.known){
      if(typeof row.hash!=='string' || row.hash.length>100)throw new Error('invalid capture hash');
      if(row.directory){if(row.hash!=='directory')throw new Error('invalid directory witness');}
      else{
        if(!Number.isSafeInteger(row.size) || row.size<0 || row.size>CAPTURE_READ_LIMIT)throw new Error('invalid capture size');
        total+=row.size;if(total>CAPTURE_TOTAL_LIMIT)throw new Error('capture checkpoint total exceeds bound');
        if(row.text!=null){
          if(typeof row.text!=='string' || row.text.length>CAPTURE_READ_LIMIT)throw new Error('invalid capture text');
          const bytes=new TextEncoder().encode(row.text);
          if(bytes.length!==row.size || byteDigest(bytes)!==row.hash)throw new Error('capture text witness mismatch');
        }
      }
    }
    files.set(name,{known:row.known,hash:row.hash,text:row.text??null,size:row.size,directory:!!row.directory});
  }
  return {files,listed:value.listed,complete:false,problems:['interrupted run; effects and authorship remain uncertain']};
}
export async function recoverInterruptedCapture(fs,text,run){
  const before=decodeCaptureCheckpoint(text,run);
  const after=await snapshotWorkspace(fs);
  const net=compareSnapshots(before,after);
  return {rows:net.changed.map(change=>({...rowFor(change,run),captureIncomplete:true,revertUnavailable:true,interrupted:true})),
    complete:false,netUnknown:net.unknown,problems:[...before.problems,...after.problems].slice(0,12)};
}
