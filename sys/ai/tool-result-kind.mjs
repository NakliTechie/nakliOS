// B1 (2026-09-11, from the osaurus recce): a typed failure `kind` on every tool result the loop
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
