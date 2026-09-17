// B1 (2026-09-11): a typed failure `kind` on every tool result the loop
// can route on. Anvil's tools speak prose — "Error: …", "cat: x: ENOENT", "[exit 2]" — and the
// model, the record and the folds all had to guess what a failure WAS. Live T1 run 4 died on a
// silent "(no output) [exit 2]" that nothing could name.
//
// The smallest version: keep the text the model sees exactly as it is, and classify it once, here,
// into a closed set. The kind rides the tool-result event, lands on tool.responded, and folds.
// Classification is by the shapes the tools actually emit (each rule cites its source), in
// priority order — a refusal is a refusal even when it also mentions a path.
export const TOOL_FAILURE_KINDS = Object.freeze(['invalid_args', 'rejected', 'not_found', 'unavailable', 'execution_error']);

const RULES = [
  // agent-loop: arguments that were not JSON; a tool that asked for something it lacks
  ['invalid_args',    /^Error: could not parse arguments as JSON|^Error: (?:\w+ needs|only one todo|old_string|new_string)|^Error \(invalid_args\)/i],
  // grant / fence / policy / confirm: the call was understood and refused
  ['rejected',        /^Refused:|\brefused\b|read-only under this grant|EGRANT|is destructive\. confirm\?|blocked by policy|\bdenied\b/i],
  // shell + fs: the thing named is not there
  ['not_found',       /\bENOENT\b|No such file or directory|can't open file|not found\b|No skill named|No fact named|unknown command:/i],
  // the tool exists but cannot run here
  ['unavailable',     /^Error: (?:unknown tool|subagents are not available|dispatch \(.*\) is not available|review \(.*\) is not available)|the Kiln kernel is not available|kernel unavailable|no egress transport/i],
  // it ran and failed
  ['execution_error', /\[exit [1-9]\d*\]\s*(?:\[expect\][^\n]*)?\s*$|^Error:|^Error in \w+:|Traceback \(most recent call last\)|^Subagent error:|^Failed to start/i],
];

// The kind of a tool result, or null when it is not a failure. `text` is the exact string the
// model receives; nothing else is inspected, so what is classified is what was said.
export function classifyToolResult(name, text) {
  const s = String(text ?? '');
  if (!s) return null;
  for (const [kind, re] of RULES) if (re.test(s)) return kind;
  return null;
}

// B6 (osaurus, 2026-09-17): the SHAPE of a shell listing, read from the text the model saw — like the
// failure kind, a pure function of it, never stored. `ls -l` (`d name` / `- name` a line), a path
// listing (`find`: one path a line), `ls -R` directory BLOCKS (`dir:` then one entry a line), and the
// shell's cap trailer `[listing truncated: N of M entries shown …]`, whose numbers are the truth when
// present. The runner's own suffix lines (`[exit N]`, an `[expect] …` verdict) and a post-hook's
// `[hook] …` block are not the listing and are dropped first — every real result carries the suffix,
// and the A3 fixtures that lacked it hid that the collapse never fired live (2026-09-17). One entry
// is not a listing (nothing to collapse; a `Results:` line over a word must not become one).
const LISTING_TRAILER = /^\[listing truncated: (\d+) of (\d+) entries shown\b/;
export function listingShape(text, { tool = '' } = {}) {
  if (tool !== 'shell') return null;
  let all = String(text || '').split('\n');
  const hook = all.findIndex((l) => /^\[hook\] /.test(l));
  if (hook >= 0) all = all.slice(0, hook);
  all = all.filter((l) => l.trim() !== '');
  while (all.length && /^\[(?:exit -?\d+|expect)\]/.test(all[all.length - 1])) all.pop();
  let trailer = null;
  if (all.length && LISTING_TRAILER.test(all[all.length - 1])) trailer = all.pop().match(LISTING_TRAILER);
  const lines = all.filter((l) => !/^\S.*:$/.test(l)); // block headers are not entries
  const blocks = lines.length !== all.length;
  if (lines.length < (trailer ? 1 : 2)) return null;
  const long = lines.every((l) => /^[d-] \S+$/.test(l)); // one token after the mark: `- read the file` is prose
  const names = !long && lines.every((l) => /^[^\s:=\[\]]+$/.test(l) && (blocks || l.includes('/')));
  if (!(long || names)) return null;
  if (trailer) return { entries: Number(trailer[2]), shown: Number(trailer[1]), truncated: true };
  return { entries: lines.length, shown: lines.length, truncated: false };
}

