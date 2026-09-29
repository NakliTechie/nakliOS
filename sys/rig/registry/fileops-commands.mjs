// fileops-commands — the C0 filesystem ops, registered as C1 commands.
//
// buildFileopsCommands(fs) closes each command over an injected fileops
// instance (createFileops({backend,root})), mirroring NakliData's
// buildAgentTools(host). The registry stays storage-agnostic; these commands
// are the first four-consumer-shared capability surface.

const PATH = { type: 'string', description: 'Mount-relative POSIX path.' };

// Reusable success-payload schemas (inert metadata).
const RESULT_OK = { type: 'object', properties: { ok: { const: true } }, required: ['ok'] };
const RESULT_READ = {
  type: 'object',
  properties: { ok: { const: true }, data: { description: 'Uint8Array, or string when an encoding is given.' } },
  required: ['ok', 'data'],
};
const RESULT_STAT = {
  type: 'object',
  properties: {
    ok: { const: true },
    stat: {
      type: 'object',
      properties: {
        type: { enum: ['file', 'dir', 'symlink'] },
        size: { type: 'number' }, mtimeMs: { type: 'number' }, target: { type: 'string' },
      },
    },
  },
  required: ['ok', 'stat'],
};
const RESULT_LIST = {
  type: 'object',
  properties: {
    ok: { const: true },
    entries: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' }, type: { type: 'string' } } } },
  },
  required: ['ok', 'entries'],
};
const RESULT_MATCHES = {
  type: 'object',
  properties: { ok: { const: true }, matches: { type: 'array' }, errors: { type: 'array', items: {
    type: 'object', properties: { path: PATH, code: { type: 'string' }, message: { type: 'string' } },
  } } },
  required: ['ok', 'matches'],
};

const RO = { readOnlyHint: true };
const RW = { readOnlyHint: false };

export function buildFileopsCommands(fs) {
  return [
    {
      name: 'fs.read',
      summary: 'Read a file as bytes (or text with an encoding).',
      description: 'Read a file within the mount. Returns a Uint8Array by default; pass {encoding} (e.g. "utf-8") for text. ENOENT if absent, EISDIR for a directory.',
      inputSchema: {
        type: 'object',
        properties: { path: PATH, encoding: { type: 'string', description: 'e.g. "utf-8"; omit for raw bytes.' }, maxBytes: { type: 'integer', minimum: 0, description: 'Reject oversized reads before allocating content; unsupported storage returns ENOTSUP.' }, rejectSymlinks: { type: 'boolean', description: 'Refuse symlink traversal when canonical target authorization is unavailable.' } },
        required: ['path'], additionalProperties: false,
      },
      returnSchema: RESULT_READ, destructive: false, scope: 'fs:read', annotations: RO,
      run: (i) => fs.read(i.path, { encoding: i.encoding, maxBytes: i.maxBytes, rejectSymlinks: i.rejectSymlinks }),
    },
    {
      name: 'fs.write',
      summary: 'Write bytes or text to a file.',
      description: 'Write a file within the mount, creating or overwriting it. Pass {createParents:true} to create missing directories. EISDIR if the path is a directory.',
      inputSchema: {
        type: 'object',
        properties: { path: PATH, data: { description: 'string, Uint8Array, or ArrayBuffer.' }, createParents: { type: 'boolean' } },
        required: ['path', 'data'], additionalProperties: false,
      },
      returnSchema: RESULT_OK, destructive: false, scope: 'fs:write', annotations: RW,
      run: (i) => fs.write(i.path, i.data, { createParents: i.createParents }),
    },
    {
      name: 'fs.create',
      summary: 'Atomically create a new empty file or directory.',
      description: 'Create an absent final path without following or replacing an existing file, directory, or symlink. EEXIST on collisions, including races. Ancestors must exist; symlink ancestors return ENOTSUP because canonical-target authorization is unavailable. Storage without atomic exclusive creation returns ENOTSUP before metadata traversal or mutation.',
      inputSchema: { type: 'object', properties: { path: PATH, directory: { type: 'boolean' } }, required: ['path'], additionalProperties: false },
      returnSchema: RESULT_OK, destructive: false, scope: 'fs:write', annotations: RW,
      run: (i) => fs.create(i.path, { directory: i.directory }),
    },
    {
      name: 'fs.truncate',
      summary: 'Atomically change a file length while retaining its prefix.',
      description: 'Truncate or zero-extend a file through a backend transaction. Relative and rounding modes require atomic current-size arithmetic. maxBytes bounds the resulting allocation, defaulting to 16 MiB. Pass create:false to leave absent files absent. Symlink traversal and unsupported storage or modes return ENOTSUP without effects. FSA supports existing-file absolute sizes from a bounded immutable snapshot; it does not compare-and-swap against concurrent external edits.',
      inputSchema: { type: 'object', properties: { path: PATH, size: { type: 'integer', minimum: 0 },
        mode: { enum: ['set', 'add', 'subtract', 'min', 'max', 'roundDown', 'roundUp'] }, create: { type: 'boolean' },
        maxBytes: { type: 'integer', minimum: 0 } }, required: ['path', 'size'], additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, path: PATH, changed: { type: 'boolean' }, size: { type: ['integer', 'null'] } }, required: ['ok', 'changed', 'size'] },
      destructive: false, scope: 'fs:write', annotations: RW,
      run: (i) => fs.truncate(i.path, { size: i.size, mode: i.mode, create: i.create, maxBytes: i.maxBytes }),
    },
    {
      name: 'fs.list',
      summary: 'List a directory (optionally recursive).',
      description: 'List the immediate children of a directory, or all descendants with {recursive:true}. Each entry is {path,name,type}. Pass {metadataOnly:true} for nonrecursive listing without file-content reads; unsupported storage or recursive combinations return ENOTSUP. ENOTDIR for a file, ENOENT if absent.',
      inputSchema: {
        type: 'object',
        properties: { path: PATH, recursive: { type: 'boolean' }, metadataOnly: { type: 'boolean' }, rejectSymlinks: { type: 'boolean', description: 'Refuse traversed links; recursive listing is unsupported with this flag.' } },
        required: ['path'], additionalProperties: false,
      },
      returnSchema: RESULT_LIST, destructive: false, scope: 'fs:read', annotations: RO,
      run: (i) => fs.list(i.path, { recursive: i.recursive, metadataOnly: i.metadataOnly, rejectSymlinks: i.rejectSymlinks }),
    },
    {
      name: 'fs.stat',
      summary: 'Stat a path (type, size, mtime).',
      description: 'Return {type,size,mtimeMs,target?}. Pass {follow:false} to inspect the final symlink itself; ancestor links still resolve within the mount. Pass {metadataOnly:true} to prohibit file-content reads; unavailable size/mtime fields remain absent, and unsupported storage returns ENOTSUP. ENOENT if absent.',
      inputSchema: { type: 'object', properties: { path: PATH, follow: { type: 'boolean' }, metadataOnly: { type: 'boolean' }, rejectSymlinks: { type: 'boolean', description: 'Refuse traversed links; follow:false still permits inspecting a final link.' } }, required: ['path'], additionalProperties: false },
      returnSchema: RESULT_STAT, destructive: false, scope: 'fs:read', annotations: RO,
      run: (i) => fs.stat(i.path, { follow: i.follow, metadataOnly: i.metadataOnly, rejectSymlinks: i.rejectSymlinks }),
    },
    {
      name: 'fs.mkdir',
      summary: 'Create a directory.',
      description: 'Create a directory within the mount. Pass {createParents:true} for missing ancestors. Succeeds if it already exists as a directory; EEXIST if a file is there.',
      inputSchema: {
        type: 'object',
        properties: { path: PATH, createParents: { type: 'boolean' } },
        required: ['path'], additionalProperties: false,
      },
      returnSchema: RESULT_OK, destructive: false, scope: 'fs:write', annotations: RW,
      run: (i) => fs.mkdir(i.path, { createParents: i.createParents }),
    },
    {
      name: 'fs.remove',
      summary: 'Remove a file or directory.',
      description: 'Pass kind:dir or kind:non-dir for atomic type-checked, nonrecursive removal of the final object; symlink ancestors and unsupported storage return ENOTSUP. FSA lacks atomic type-constrained deletion and refuses typed removal before metadata access. Remove a file, or a directory with {recursive:true}. Pass {follow:false} to delete a final symlink without deleting its target. Pass {metadataOnly:true} for nonrecursive removal without file-content reads. Unsupported storage, recursive combinations, and Overlay base files without existing content pins return ENOTSUP; symlink removal needs no target pin. Destructive; C4 stages a proposal before this runs.',
      inputSchema: {
        type: 'object',
        properties: { path: PATH, recursive: { type: 'boolean' }, follow: { type: 'boolean' }, metadataOnly: { type: 'boolean' }, kind: { enum: ['dir', 'non-dir'] } },
        required: ['path'], additionalProperties: false,
      },
      returnSchema: RESULT_OK, destructive: true, scope: 'fs:remove', annotations: RW,
      run: (i) => fs.remove(i.path, { recursive: i.recursive, follow: i.follow, metadataOnly: i.metadataOnly, kind: i.kind }),
    },
    {
      name: 'fs.move',
      summary: 'Move (rename) a file or directory.',
      description: 'Move (rename) a path within the mount, DELETING the source `from`. EEXIST if the destination exists, unless {overwrite:true} and both are files. EINVAL if `to` is `from` or inside it. Executes immediately — it is NOT staged.',
      inputSchema: {
        type: 'object',
        properties: { from: PATH, to: PATH, overwrite: { type: 'boolean' } },
        required: ['from', 'to'], additionalProperties: false,
      },
      returnSchema: RESULT_OK, destructive: false, scope: 'fs:write', annotations: RW,
      run: (i) => fs.move(i.from, i.to, { overwrite: i.overwrite }),
    },
    {
      name: 'fs.copy',
      summary: 'Copy a file or directory.',
      description: 'Copy a path to a new location within the mount. EEXIST if the destination exists, unless {overwrite:true} and both are files. EINVAL if `to` is `from` or inside it.',
      inputSchema: {
        type: 'object',
        properties: { from: PATH, to: PATH, overwrite: { type: 'boolean' } },
        required: ['from', 'to'], additionalProperties: false,
      },
      returnSchema: RESULT_OK, destructive: false, scope: 'fs:write', annotations: RW,
      // `from` is READ, not written: copying a file OUT of a read-only region is a read.
      // (fs.move deliberately declares none — a move deletes its source.)
      sourceParams: ['from'],
      run: (i) => fs.copy(i.from, i.to, { overwrite: i.overwrite }),
    },
    {
      name: 'fs.patch',
      summary: 'Apply a unified diff to a file.',
      description: 'Apply a unified diff atomically; a failed hunk names itself and the file is untouched. Returns a `revert` diff that exactly restores the original bytes.',
      inputSchema: {
        type: 'object',
        properties: { path: PATH, unifiedDiff: { type: 'string' } },
        required: ['path', 'unifiedDiff'], additionalProperties: false,
      },
      returnSchema: {
        type: 'object',
        properties: { ok: { const: true }, revert: { type: 'string' } },
        required: ['ok', 'revert'],
      },
      destructive: false, scope: 'fs:write', annotations: RW,
      run: (i) => fs.patch(i.path, i.unifiedDiff),
    },
    {
      name: 'fs.glob',
      summary: 'Find paths matching a glob.',
      description: 'Return mount paths matching a glob pattern (*, **, ?) under {cwd}.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, cwd: PATH },
        required: ['pattern'], additionalProperties: false,
      },
      returnSchema: { type: 'object', properties: { ok: { const: true }, matches: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'matches'] },
      destructive: false, scope: 'fs:read', annotations: RO,
      run: (i) => fs.glob(i.pattern, { cwd: i.cwd }),
    },
    {
      name: 'fs.grep',
      summary: 'Search file contents by pattern.',
      description: 'Search files under {cwd} (optionally filtered by {glob}) for a regex with optional {flags}, returning {path,line,text} matches up to {maxResults}; reports truncation and per-file read errors.',
      inputSchema: {
        type: 'object',
        properties: { pattern: { type: 'string' }, flags: { type: 'string', description: 'JavaScript regular-expression flags, e.g. i for case-insensitive search.' }, cwd: PATH, glob: { type: 'string' }, maxResults: { type: 'number' } },
        required: ['pattern'], additionalProperties: false,
      },
      returnSchema: RESULT_MATCHES, destructive: false, scope: 'fs:read', annotations: RO,
      run: (i) => fs.grep(i.pattern, { flags: i.flags, cwd: i.cwd, glob: i.glob, maxResults: i.maxResults }),
    },
    // Measurement only (plan/anvil-indexed-search.md §6). Not advertised to the
    // agent — these exist so a human can read what search costs on a real
    // workspace before deciding whether an index earns its rung.
    {
      name: 'fs.searchStats',
      summary: 'Read accumulated search cost counters.',
      description: 'Return totals and the recent per-call log for fs.grep and shell rg: files walked, files opened, bytes decoded, ms. {reset} clears them.',
      inputSchema: {
        type: 'object',
        properties: { reset: { type: 'boolean' } },
        required: [], additionalProperties: false,
      },
      returnSchema: { type: 'object', properties: { totals: { type: 'object' }, recent: { type: 'array' } }, required: ['totals'] },
      destructive: false, scope: 'fs:read', annotations: RO,
      run: (i) => ({ ok: true, ...fs.searchStats({ reset: !!i.reset }) }),
    },
    {
      name: 'fs.recordSearch',
      summary: 'Record one search-cost sample.',
      description: 'Append a search cost sample from a search path that does not go through fs.grep (the shell rg builtin). Measurement only; stores no file content.',
      inputSchema: {
        type: 'object',
        properties: {
          via: { type: 'string' }, pattern: { type: 'string' }, cwd: PATH, glob: { type: 'string' },
          filesWalked: { type: 'number' }, filesRead: { type: 'number' }, bytesRead: { type: 'number' },
          matches: { type: 'number' }, truncated: { type: 'boolean' }, ms: { type: 'number' },
        },
        required: ['via'], additionalProperties: false,
      },
      returnSchema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
      destructive: false, scope: 'fs:read', annotations: RO,
      run: (i) => {
        fs.recordSearch({
          via: i.via, pattern: i.pattern || '', cwd: i.cwd || '', glob: i.glob || '**',
          filesWalked: i.filesWalked || 0, filesRead: i.filesRead || 0, bytesRead: i.bytesRead || 0,
          matches: i.matches || 0, truncated: !!i.truncated, ms: i.ms || 0, at: Date.now(),
        });
        return { ok: true };
      },
    },
  ];
}
