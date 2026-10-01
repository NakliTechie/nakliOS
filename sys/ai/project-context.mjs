// Per-project memory & skills — the context an agent reads at the start of a
// task and can append to as it learns. Two files live at the project workspace
// root and roam with it (they are ordinary workspace files):
//
//   AGENTS.md  — durable, human-authored instructions/skills/conventions
//   memory.md  — learnings the agent recorded via the `remember` tool
//
// This module is PURE (no fs, no browser): the app reads the two files, passes
// their text in, and writes back what `appendMemory` returns. That keeps the
// assembly + append semantics headlessly testable.

import { LESSON_CONTRACT } from './memory-store.mjs';
import { digest } from './change-preimages.mjs';
import { sha256Hex } from '../identity/crypto.mjs';
import { isSuccessfulReadToolResult } from './tool-result-kind.mjs';

const DEFAULT_CAP = 8192;

// Assemble the system-prompt prefix from a project's AGENTS.md + memory.md.
// Each section is trimmed and capped; returns '' when neither is present so the
// caller can concatenate unconditionally.
export function buildProjectContext({ agents, memory, cap = DEFAULT_CAP } = {}) {
  const clip = (s) => {
    const t = String(s).trim();
    return t.length > cap ? t.slice(0, cap) + '\n…(truncated)' : t;
  };
  const sections = [];
  if (agents != null && String(agents).trim()) {
    sections.push('## Project instructions (AGENTS.md)\n' + clip(agents));
  }
  if (memory != null && String(memory).trim()) {
    sections.push('## Project memory (memory.md — learnings from earlier tasks)\n' + clip(memory));
  }
  if (!sections.length) return '';
  return '\n\n# Project context\n' +
    'This workspace carries persistent context. Follow the instructions and honor ' +
    'the memory below; record any durable learning with the `remember` tool.\n\n' +
    sections.join('\n\n') + '\n';
}

// Append one note as a bullet to memory.md, creating the file body when it is
// empty/absent. Append-only — never rewrites prior content. Returns the new
// full file contents. A blank note is a no-op (returns the input unchanged).
export function appendMemory(existing, note) {
  const clean = String(note == null ? '' : note).trim().replace(/\r?\n/g, ' ');
  if (!clean) return existing == null ? '' : String(existing);
  const header = '# Project memory\n\nLearnings recorded while working in this project.\n';
  const base = (existing == null || !String(existing).trim())
    ? header
    : String(existing).replace(/\n*$/, '\n');
  return base + '- ' + clean + '\n';
}

// Count the recorded notes (bullets) in a memory.md body.
export function countMemory(body) {
  return (String(body == null ? '' : body).match(/^- /gm) || []).length;
}

// OpenAI-style tool definition for the agent to record a durable learning. Each
// call writes one fact file under the structured memory store (.anvil/memory/);
// the index of facts is injected on future tasks and full detail loads via
// `recall`. Use sparingly — facts that still matter next session, not per-step
// notes.
export function rememberTool() {
  return {
    type: 'function',
    function: {
      name: 'remember',
      description: 'Record ONE durable learning about THIS project so future tasks in ' +
        'this workspace start with it. ' + LESSON_CONTRACT + ' A "rule" is injected in full ' +
        'every run and binds your own choices (the owner still outranks it) — use it for ' +
        'what you were corrected on; rules are capped, so keep them few and short.',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: 'The learning. First line is the summary shown in the memory index; add detail on following lines if useful.' },
          type: { type: 'string', enum: ['user', 'feedback', 'project', 'reference', 'rule'], description: 'Kind of fact (default: project). "rule": mandatory, injected in full every run, capped.' },
          weight: { type: 'integer', minimum: 1, maximum: 10, description: 'Rules only: 1–10, higher renders first (default 5).' },
          slot: { type: 'string', description: 'Optional single-valued key this fact fills (e.g. "build-tool", "db", "phase"). A new value for a slot supersedes the current holder.' },
          derived_from: { type: 'string', description: 'Optional comma-separated fact names this learning rests on. If one is later retracted, this fact drops back to hypothesis.' },
          supersedes: { type: 'string', description: 'Optional comma-separated fact names this learning replaces.' },
        },
        required: ['note'],
      },
    },
  };
}

// The project-priming pass has a narrower contract than a normal coding run.
// It may list and read, but each saved hypothesis must cite a file it read.
export function primeListTool() {
  return { type:'function', function:{ name:'list',
    description:'List one bounded page of a project directory. Follow its cursor for more entries. Pages may reflect a changing live directory rather than one snapshot; do not claim exhaustive coverage. Read source files before recording a fact.',
    parameters:{ type:'object', properties:{ path:{ type:'string', description:'Directory path relative to the project root; omit for the root.' },
      cursor:{type:'string',description:'Opaque continuation cursor returned by the previous list call for this path.'} } } } };
}

export function primeRememberTool() {
  const tool = rememberTool();
  tool.function.description += ' For this survey, cite one to three files you successfully read in sourcePaths.';
  tool.function.parameters.properties.type = { type:'string', enum:['project','reference'],
    description:'Project fact or reference. Omit for project; a read-only survey cannot create binding rules.' };
  tool.function.parameters.properties.sourcePaths = { type:'array', minItems:1, maxItems:3,
    items:{ type:'string' }, description:'Exact paths from successful read calls that support this note.' };
  tool.function.parameters.required.push('sourcePaths');
  return tool;
}

// A bounded full-file version supplements the text shown by the read tool. Some
// stores cannot enforce maxBytes before copying; their explicit ENOTSUP response
// is evidence of a limitation, not permission to retry without a bound.
export async function readPrimeSourceVersion(fileops, path, maxBytes=1_048_576) {
  const reason=value=>String(value||'read unavailable').replace(/\s+/g,' ').slice(0,120);
  try {
    const r=await fileops.read(path,{maxBytes});
    if(!(r&&r.ok)) return { status:'unavailable', reason:reason(r?.code||r?.error) };
    const bytes=r.data instanceof Uint8Array ? r.data : null;
    if(!bytes || bytes.length>maxBytes) return { status:'unavailable', reason:'bounded bytes unavailable' };
    return { status:'available', digest:'sha256:'+await sha256Hex(bytes), bytes:bytes.length };
  } catch(e) { return { status:'unavailable', reason:reason(e?.code||e?.message||e) }; }
}

export function createPrimeReadEvidence() {
  const reads = new Map();
  const canonical = path => {
    if (typeof path !== 'string' || !path.trim()) return '';
    if (path.startsWith('/') || path.includes('\\') || /[\u0000-\u001f\u007f]/.test(path)) return '';
    const parts=[];
    for (const part of path.trim().split('/')) {
      if (!part || part==='.') continue;
      if (part==='..') return '';
      parts.push(part);
    }
    return parts.join('/');
  };
  const memoryPath = path => { const parts=path.split('/'); return parts[0]==='.anvil' && parts[1]==='memory'; };
  return {
    observeRead(input, result, version=null) {
      const raw = typeof input === 'string' ? input.trim() : typeof input?.path === 'string' ? input.path.trim() : '';
      const key = canonical(raw);
      if (!key || memoryPath(key) || !isSuccessfulReadToolResult(result)) return false;
      const args = { path:raw };
      if (Number.isInteger(input?.offset)) args.offset=input.offset;
      if (Number.isInteger(input?.limit)) args.limit=input.limit;
      reads.set(key, { path:key, args, result, digest:digest(result),
        version:version?.status==='available' ? version : { status:'unavailable', reason:String(version?.reason||'not available') } });
      return true;
    },
    checkRemember(args) {
      const refs = args?.sourcePaths;
      if (!Array.isArray(refs) || !refs.length || refs.length > 3 ||
          refs.some(path => typeof path !== 'string' || !path.trim()))
        return { ok:false, reason:'cite one to three paths from successful read calls' };
      const paths = [...new Set(refs.map(canonical))];
      if (paths.some(path => !path || memoryPath(path)))
        return { ok:false, reason:'cite project files rather than memory files or parent paths' };
      const missing = paths.filter(path => !reads.has(path));
      if (missing.length) return { ok:false, reason:'read these files successfully before citing them: '+missing.join(', ') };
      return { ok:true, paths, snapshots:paths.map(path => reads.get(path)) };
    },
  };
}
