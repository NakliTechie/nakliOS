// git-commands — the C2 git-core ops, registered as C1 commands.
//
// buildGitCommands(gitCore) closes each command over a createGitCore(...)
// instance, exactly as fileops-commands does over fileops. git.* joins the same
// single registry — no surface gets its own path to capability.

const OK = { type: 'object', properties: { ok: { const: true } }, required: ['ok'] };
const RO = { readOnlyHint: true };
const RW = { readOnlyHint: false };

export function buildGitCommands(git) {
  return [
    {
      name: 'git.init',
      summary: 'Initialise a repository in the mount.',
      description: 'Create a new git repository at the worktree root. {defaultBranch} defaults to "main".',
      inputSchema: { type: 'object', properties: { defaultBranch: { type: 'string' } }, additionalProperties: false },
      returnSchema: OK, destructive: false, scope: 'git:write', annotations: RW,
      run: (i) => git.init(i),
    },
    {
      name: 'git.add',
      summary: 'Stage a file.',
      description: 'Add a working-tree path to the index.',
      inputSchema: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'], additionalProperties: false },
      returnSchema: OK, destructive: false, scope: 'git:write', annotations: RW,
      run: (i) => git.add(i),
    },
    {
      name: 'git.remove',
      summary: 'Unstage / remove a file from the index.',
      description: 'Remove a path from the index. Destructive — C4 stages a proposal.',
      inputSchema: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'], additionalProperties: false },
      returnSchema: OK, destructive: true, scope: 'git:write', annotations: RW,
      run: (i) => git.remove(i),
    },
    {
      name: 'git.commit',
      summary: 'Record a commit.',
      description: 'Commit the staged tree. The commit author is bound to the AUTHENTICATED caller (an operator face commits with its {identity}; every other principal is forced to agent@rig.local with a session trailer). A caller-supplied actor is ignored.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          identity: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } } },
          session: { type: 'object' },
          timestamp: { type: 'number' }, timezoneOffset: { type: 'number' },
        },
        required: ['message'], additionalProperties: false,
      },
      returnSchema: { type: 'object', properties: { ok: { const: true }, oid: { type: 'string' }, actor: { type: 'string' } }, required: ['ok'] },
      destructive: true, scope: 'git:write', annotations: RW,
      // Actor is bound to the AUTHENTICATED principal (ctx.actor), never caller input,
      // so an agent can never forge an operator-authored commit (RIG §5).
      run: (i, ctx) => git.commit({ ...i, actor: (ctx && ctx.actor === 'operator') ? 'operator' : 'agent' }),
    },
    {
      name: 'git.status',
      summary: 'Status of one file.',
      description: 'Return the working-tree status string for a single path.',
      inputSchema: { type: 'object', properties: { filepath: { type: 'string' } }, required: ['filepath'], additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, status: { type: 'string' } }, required: ['ok'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.status(i),
    },
    {
      name: 'git.statusMatrix',
      summary: 'Status matrix for the tree.',
      description: 'Return [filepath, HEAD, WORKDIR, STAGE] rows for the working tree.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, filepaths: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, matrix: { type: 'array' } }, required: ['ok', 'matrix'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.statusMatrix(i),
    },
    {
      name: 'git.log',
      summary: 'Commit history.',
      description: 'Return commits reachable from a ref (default HEAD).',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, depth: { type: 'number' } }, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, commits: { type: 'array' } }, required: ['ok', 'commits'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.log(i),
    },
    {
      name: 'git.diff',
      summary: 'Diff working tree or between refs.',
      description: 'List changed paths between {refA} and {refB} (or the working tree when refB is omitted).',
      inputSchema: { type: 'object', properties: { refA: { type: 'string' }, refB: { type: 'string' } }, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, changes: { type: 'array' } }, required: ['ok', 'changes'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.diff(i),
    },
    {
      name: 'git.branch',
      summary: 'Create a branch.',
      description: 'Create a branch {ref}; {checkout:true} also switches to it.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, checkout: { type: 'boolean' } }, required: ['ref'], additionalProperties: false },
      returnSchema: OK, destructive: false, scope: 'git:write', annotations: RW,
      run: (i) => git.branch(i),
    },
    {
      name: 'git.listBranches',
      summary: 'List branches.',
      description: 'Return local branch names.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, branches: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'branches'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: () => git.listBranches(),
    },
    {
      name: 'git.checkout',
      summary: 'Switch to a ref (discards conflicting worktree changes).',
      description: 'Check out a branch or commit into the worktree. Destructive — discards conflicting changes; C4 stages a proposal.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' }, force: { type: 'boolean' } }, required: ['ref'], additionalProperties: false },
      returnSchema: OK, destructive: true, scope: 'git:write', annotations: RW,
      run: (i) => git.checkout(i),
    },
    {
      name: 'git.listRemotes',
      summary: 'List configured remotes.',
      description: 'Return configured remotes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, remotes: { type: 'array' } }, required: ['ok', 'remotes'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: () => git.listRemotes(),
    },
    {
      name: 'git.resolveRef',
      summary: 'Resolve a ref to an object id.',
      description: 'Resolve a ref (e.g. HEAD, a branch) to its commit oid.',
      inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'], additionalProperties: false },
      returnSchema: { type: 'object', properties: { ok: { const: true }, oid: { type: 'string' } }, required: ['ok', 'oid'] },
      destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.resolveRef(i),
    },
    // ── Remote (Layer 2): all network I/O flows through the sovereign egress
    // transport injected into git-core. Without a configured egress backend +
    // transport, these fail with a clear "needs a Transport" error. ──
    {
      name: 'git.clone',
      summary: 'Clone a remote repository over HTTP.',
      description: 'Clone a git repo from a URL into the worktree. Network goes through the sovereign egress (nakli-egress / local bridge); needs a configured backend, and auth for a private repo.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, ref: { type: 'string' }, singleBranch: { type: 'boolean' }, depth: { type: 'number' } }, required: ['url'], additionalProperties: false },
      returnSchema: OK, destructive: true, scope: 'git:write', annotations: RW,
      run: (i) => git.clone(i),
    },
    {
      name: 'git.fetch',
      summary: 'Fetch refs/objects from a remote over HTTP.',
      description: 'Fetch from a remote URL without touching the worktree. Network goes through the sovereign egress.',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, ref: { type: 'string' } }, required: ['url'], additionalProperties: false },
      returnSchema: OK, destructive: false, scope: 'git:read', annotations: RO,
      run: (i) => git.fetch(i),
    },
    {
      name: 'git.push',
      summary: 'Push a branch to a remote over HTTP.',
      description: 'Push refs/objects to a remote URL. Network goes through the sovereign egress; requires a configured backend and auth (a Personal Access Token, supplied host-side).',
      inputSchema: { type: 'object', properties: { url: { type: 'string' }, ref: { type: 'string' }, remoteRef: { type: 'string' }, force: { type: 'boolean' } }, required: ['url', 'ref'], additionalProperties: false },
      // Push is operator-only (RIG §5: "not exposed to the kernel") — the reserved git:push
      // scope, which the agent grant does not hold, so an agent cannot push over the face.
      returnSchema: OK, destructive: true, scope: 'git:push', annotations: RW,
      run: (i) => git.push(i),
    },
  ];
}
