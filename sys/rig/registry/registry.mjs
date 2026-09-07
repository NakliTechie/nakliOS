// registry — Rig's C1 command registry.
//
// Ported from NakliData's command-bus shape (src/core/agent/registry.ts):
//   - a command is a plain object; the registry is a factory over an array,
//     not a class/Map/decorator;
//   - invokeCommand is the SOLE path that touches a command's `run` handler;
//   - searchCommands / describeCommand project METADATA ONLY — they never
//     reference `run`, so discovery is provably side-effect-free.
//
// RIG §4 extends the NakliData shape with three fields it names explicitly:
// `returnSchema`, a `destructive` flag, and a `scope` (required grant). Same
// shape, three more fields — not a second registry shape (hard rule #4).
//
// This registry is THE single shape. Its four consumers — command palette,
// faux CLI (C4b), window.rig (C4), and Kiln's generated Python bindings (K2) —
// all read the same projected metadata and call the same invokeCommand. No
// surface gets its own path to capability.

// A command:
//   {
//     name: string            // unique; dotted namespace, e.g. 'fs.read'
//     summary: string         // one-line help (no newline) — RIG §4 "one-line help"
//     description: string     // fuller help for describeCommand / /help
//     inputSchema: object     // JSON Schema (draft-07 literal) — inert metadata
//     returnSchema: object    // JSON Schema of the success payload — inert metadata
//     destructive: boolean    // stages a proposal under C4 (e.g. remove)
//     scope: string           // required grant scope, e.g. 'fs:read'
//     annotations: { readOnlyHint: boolean }
//     run(input, ctx): Promise<result>   // the handler — reached ONLY by invokeCommand
//   }
//
// Handlers live on the command via a closure over an injected host (fileops,
// git core, …), mirroring NakliData's `buildAgentTools(host)`.

/** Grant scopes a command may require. */
export const KNOWN_SCOPES = new Set([
  'fs:read', 'fs:write', 'fs:remove',
  'git:read', 'git:write', 'git:remote', 'git:push',
]);

// Fields exposed by discovery. `run` is deliberately absent: projecting a
// command can never reach its handler.
const META_FIELDS = [
  'name', 'summary', 'description', 'inputSchema', 'returnSchema',
  'destructive', 'scope', 'annotations',
  // Path arguments the command only READS (fs.copy's `from`). The grant edge uses this to
  // let a file be copied OUT of a read-only region while refusing a write INTO it. Absent
  // means every path argument is treated as written, which is the safe reading.
  'sourceParams',
];

function project(command) {
  const out = {};
  for (const f of META_FIELDS) out[f] = command[f];
  return out;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Relevance of a command to a query: substring hits rank highest (name over
// body), then an edit-distance fallback so a typo ("fs.reed") still surfaces
// its nearest command ("fs.read"). Returns > 0 for a match, ≤ 0 otherwise.
function scoreCommand(command, q) {
  const name = command.name.toLowerCase();
  const hay = `${name}\n${command.summary}\n${command.description}`.toLowerCase();
  if (hay.includes(q)) {
    const idx = name.includes(q) ? name.indexOf(q) : 500 + hay.indexOf(q);
    return 1000 - idx;
  }
  const seg = name.split('.').pop();
  const qseg = q.split('.').pop();
  const d = Math.min(levenshtein(q, name), levenshtein(qseg, seg));
  const threshold = Math.max(2, Math.floor(seg.length / 2) + 1);
  return d <= threshold ? 100 - d * 10 : -1;
}

/**
 * Build a registry over an array of command objects.
 * @param {Array} commands
 * @returns registry with list / searchCommands / describeCommand / invokeCommand
 *          / toolSchemas, plus the frozen `commands` array.
 */
export function createRegistry(commands) {
  const byName = new Map();
  for (const c of commands) {
    if (byName.has(c.name)) throw new Error(`duplicate command name: ${c.name}`);
    byName.set(c.name, c);
  }

  // Metadata-only. Never touches `run`.
  function list() {
    return commands.map(project);
  }

  // Metadata-only. Substring match over name + summary + description, with an
  // edit-distance fallback so a near-miss still yields "closest matches" (§7).
  // Ranked most-relevant first.
  function searchCommands(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return list();
    return commands
      .map((c) => ({ c, s: scoreCommand(c, q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => project(x.c));
  }

  // Metadata-only. Returns null for an unknown name.
  function describeCommand(name) {
    const c = byName.get(name);
    return c ? project(c) : null;
  }

  // The ONLY invoker. Unknown name → typed miss with suggestions (never a
  // throw or stack trace — C4b relies on this).
  async function invokeCommand(name, input, ctx) {
    const c = byName.get(name);
    if (!c) {
      const suggestions = searchCommands(name).map((m) => m.name).slice(0, 5);
      return { ok: false, code: 'ENOCMD', message: `unknown command: ${name}`, suggestions };
    }
    return c.run(input || {}, ctx || {});
  }

  // Tool-schema JSON emitted FROM the registry (RIG §4 / C4 / K2 consume this).
  // Metadata-only projection; the same source Kiln generates bindings from.
  function toolSchemas() {
    return commands.map((c) => ({
      name: c.name,
      description: c.summary || c.description,
      inputSchema: c.inputSchema,
      annotations: c.annotations,
      scope: c.scope,
      destructive: c.destructive,
    }));
  }

  return {
    commands: Object.freeze(commands.slice()),
    list,
    searchCommands,
    describeCommand,
    invokeCommand,
    toolSchemas,
  };
}
