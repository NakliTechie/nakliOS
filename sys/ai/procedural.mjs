// AC-3 — Anvil's procedural prior, as data instead of prose.
//
// Six transitions were hard-coded in the middle of one 1,400-character SYSTEM string literal:
// read before edit, prefer surgical edits, shell to explore and verify, dispatch for independent
// parts, review after a significant change, synthesize for example-defined tasks. Hand-written,
// never measured, paid on every turn of every run.
//
// WHY THIS IS NOT COSMETIC. The procedural-graph work (arXiv:2609.09153) found that a
// hand-crafted prior can be WORSE THAN NONE — MultiChallenge 87.50 -> 58.93, recovered to 92.86
// only under a gated loop. We have six such rules and zero evidence about any of them, because
// there was no way to remove one without editing a string literal inside a single-file app. Now
// each edge is separately ablatable, which is the only thing that makes AC-1's numbers point at
// anything.
//
// THE FIRST LANDING CHANGES NO BEHAVIOUR. `renderProcedural(DEFAULT_GRAPH)` is byte-identical to
// the literal it replaced, and a test asserts it against the string Anvil actually sends. That is
// what separates "we changed the prior" from "we changed the plumbing" — without it, the first
// measurement would be confounded by its own migration.
//
// SHAPE. A clause, not a sentence. Clauses group into sentences; enabled clauses in a sentence
// join with '; ' and the sentence takes a single terminal '.'. Punctuation therefore survives
// removal: drop `shell-to-verify` and `prefer-surgical` still ends in a full stop instead of
// trailing off. A sentence with no enabled clauses disappears entirely.

export const PROCEDURAL_PATH = '.anvil/procedural.json';

// `condition` / `guidance` / `pitfalls` are the paper's per-edge fields. Only `text` is rendered
// today; the other three are what a later localization pass (AC-10) would select on, and what a
// human reads when deciding whether an edge earns its tokens. They are recorded now because
// writing them down later, from memory, is how a rationale gets invented rather than remembered.
export const DEFAULT_GRAPH = Object.freeze({
  version: 1,
  sentences: [
    ['read-before-edit'],
    ['prefer-surgical', 'shell-to-verify'],
    ['dispatch-independent', 'review-after-change'],
    ['synthesize-for-examples'],
  ],
  edges: Object.freeze({
    'read-before-edit': {
      text: 'Read a file before editing it',
      condition: 'about to modify a file whose current contents are not already in the transcript',
      guidance: 'read it first; the edit tools require an exact old_string match',
      pitfalls: 'an edit written from memory fails the match and burns a turn, or silently patches the wrong region',
    },
    'prefer-surgical': {
      text: 'Prefer edit/apply_patch for changes, write for new files',
      condition: 'changing a file that already exists',
      guidance: 'use the surgical tools; reserve whole-file write for files being created',
      pitfalls: 'a whole-file write silently discards concurrent edits and any part of the file not held in context',
    },
    'shell-to-verify': {
      text: 'use shell to explore and verify',
      condition: 'a belief about the workspace is load-bearing for the next step',
      guidance: 'check it with a command rather than asserting it',
      pitfalls: 'the curated shell refuses unsupported flags rather than ignoring them — read the refusal, it names the supported subset',
    },
    'dispatch-independent': {
      text: 'For work that splits into independent parts, use dispatch to parallelise',
      condition: 'the task decomposes into sub-tasks that touch different files',
      guidance: 'dispatch them; each runs in an isolated copy and merges back',
      pitfalls: 'sub-tasks touching the same file conflict on merge — that is not independence',
    },
    'review-after-change': {
      text: 'after a significant change, consider review before finishing',
      condition: 'a substantial change is complete and unreviewed',
      guidance: 'run the read-only reviewer subagent for a second opinion',
      pitfalls: 'a judge every result passes through is a bottleneck (LoopX rule 5) — this is advisory, and is exactly the edge worth ablating first',
    },
    'synthesize-for-examples': {
      text: 'For a task defined by input→output EXAMPLES (a puzzle), prefer the `synthesize` tool — it evolves and tests candidate solve() programs across generations and writes the best solver.py — over hand-writing one solver',
      condition: 'the task is specified by input/output pairs rather than a description',
      guidance: 'use synthesize rather than hand-writing a solver',
      pitfalls: 'it is the wrong tool for a task with a stated specification; it searches, which costs generations',
    },
  }),
});

/**
 * Render the prior. `disable` names edges to leave out — that is the ablation seam.
 * Returns '' when nothing is enabled, so a caller concatenating it needs no special case.
 */
export function renderProcedural(graph = DEFAULT_GRAPH, { disable = [] } = {}) {
  const off = new Set(disable);
  const out = [];
  for (const sentence of graph.sentences || []) {
    const clauses = sentence
      .filter((id) => !off.has(id) && graph.edges?.[id] && graph.edges[id].enabled !== false)
      .map((id) => String(graph.edges[id].text || '').trim())
      .filter(Boolean);
    if (clauses.length) out.push(clauses.join('; ') + '.');
  }
  return out.join(' ');
}

/** Every edge id the graph declares, in render order. The ablation harness's arm list. */
export function proceduralEdges(graph = DEFAULT_GRAPH) {
  return (graph.sentences || []).flat().filter((id) => graph.edges?.[id]);
}

/**
 * Merge a project's `.anvil/procedural.json` over the default. The override is deliberately
 * NARROW — it may disable an edge, reword one, or reorder sentences, and it may not introduce an
 * edge the default does not define. A prompt fragment that arrives from the workspace is content
 * the agent can write, and an agent that can add its own standing instruction has escaped the
 * lesson layer's staging path (skills are Sentinel-checked and staged for exactly this reason).
 * Unknown ids are dropped and REPORTED, never silently honoured.
 */
export function mergeProceduralGraph(base = DEFAULT_GRAPH, override = null) {
  if (!override || typeof override !== 'object') return { graph: base, ignored: [] };
  const ignored = [];
  const edges = {};
  for (const [id, e] of Object.entries(base.edges)) edges[id] = { ...e };
  for (const [id, patch] of Object.entries(override.edges || {})) {
    if (!edges[id]) { ignored.push(id); continue; }
    if (patch && typeof patch === 'object') {
      if (typeof patch.text === 'string') edges[id].text = patch.text;
      if (patch.enabled === false) edges[id].enabled = false;
      if (patch.enabled === true) delete edges[id].enabled;
    }
  }
  let sentences = base.sentences;
  if (Array.isArray(override.sentences)) {
    const known = new Set(Object.keys(edges));
    sentences = override.sentences
      .map((s) => (Array.isArray(s) ? s.filter((id) => { if (known.has(id)) return true; ignored.push(id); return false; }) : []))
      .filter((s) => s.length);
  }
  return { graph: { version: base.version, sentences, edges }, ignored };
}

/**
 * Read the project override if it exists. Fail-soft in both directions: a missing file is the
 * normal case, and a malformed one must not be able to stop a run — the prior degrades to the
 * default and the reason is returned for the caller to surface.
 */
export async function loadProceduralGraph(fs, { path = PROCEDURAL_PATH } = {}) {
  if (!fs || typeof fs.read !== 'function') return { graph: DEFAULT_GRAPH, ignored: [], note: '' };
  let raw = null;
  try {
    // Rig fileops answers { ok, data }; a plain string or { content } is accepted too so this
    // module stays usable from a test harness without standing up a backend.
    const r = await fs.read(path, { encoding: 'utf-8' });
    raw = typeof r === 'string' ? r
        : (r && r.ok && typeof r.data === 'string') ? r.data
        : (r && typeof r.content === 'string') ? r.content
        : null;
  } catch (_) { return { graph: DEFAULT_GRAPH, ignored: [], note: '' }; }
  if (raw === null) return { graph: DEFAULT_GRAPH, ignored: [], note: '' };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) {
    return { graph: DEFAULT_GRAPH, ignored: [], note: `${path} is not valid JSON (${e.message}) — using the default prior` };
  }
  const { graph, ignored } = mergeProceduralGraph(DEFAULT_GRAPH, parsed);
  return { graph, ignored, note: ignored.length ? `${path} named ${ignored.length} unknown edge(s), ignored: ${ignored.join(', ')}` : '' };
}
