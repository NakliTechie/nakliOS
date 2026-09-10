// AC-7c — permission rules in the shape people already know, plus the modes.
//
// The action gate (action-gate.mjs) decides risk from what an action DOES. That is the right
// backstop, but it is not something an owner can steer: you cannot write down "npm test is always
// fine here" or "never touch the deploy script". Claude Code's model is the one worth mirroring —
// Tool(specifier) rules in allow/deny/ask lists, plus a permission MODE.
//
// WHY WE MOSTLY DO NOT NEED A CLASSIFIER. Claude Code leans on a small model to work out what a
// shell command really invokes, because in a real shell command substitution, backticks, nested
// quoting and heredocs make prefix-matching unsound — `ls $(rm -rf /)` starts with "ls". Anvil's
// curated shell REFUSES all of those (sys/rig/cli/shell.mjs:810 — no subshells, loops, functions,
// heredocs, background jobs or command substitution). What is left is a flat sequence of commands
// joined by && || ; and |, which segments deterministically. So these rules are exact rather than
// probabilistic — and where a command still cannot be segmented with confidence, the answer is
// `ask`, never `allow`.
//
// PRECEDENCE, mirroring Claude Code: deny beats ask beats allow. A deny rule is absolute; it is the
// one thing that survives bypass mode, because writing "never do this" and having a mode ignore it
// would make deny rules worthless.

export const MODES = Object.freeze(['default', 'acceptEdits', 'bypass']);

export const MODE_LABEL = Object.freeze({
  default: 'Ask about risky actions',
  acceptEdits: 'Auto-accept file edits, ask about the rest',
  bypass: 'Bypass — never ask (dangerous)',
});

const EDIT_TOOLS = new Set(['write', 'edit', 'apply_patch', 'edit_lines']);
const SHELL_TOOLS = new Set(['shell', 'bash', 'sh']);

/** "Bash(git push:*)" -> { tool:'bash', spec:'git push', prefix:true }. null if unparseable. */
export function parseRule(str) {
  const m = /^\s*([A-Za-z_][\w-]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(String(str || ''));
  if (!m) return null;
  const tool = m[1].toLowerCase();
  let spec = m[2] == null ? null : String(m[2]).trim();
  let prefix = false;
  if (spec !== null && spec.endsWith(':*')) { prefix = true; spec = spec.slice(0, -2).trim(); }
  else if (spec === '*') { spec = ''; prefix = true; }
  return { tool, spec, prefix, source: String(str) };
}

/**
 * Segment a shell command line into the commands it actually runs.
 *
 * Sound here BECAUSE the curated shell refuses substitution and subshells. Quotes are still
 * tracked, so `echo "a && b"` is one command, not two. Returns null when the line contains
 * something we refuse to reason about — a caller must treat null as "cannot match", never as
 * "matches nothing".
 */
export function segments(command) {
  const s = String(command == null ? '' : command);
  if (/\$\(|`|<<|\$\{/.test(s)) return null;   // substitution / heredoc: not ours to parse
  const out = []; let cur = ''; let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === '&' && s[i + 1] === '&') { out.push(cur); cur = ''; i++; continue; }
    if (c === '|' && s[i + 1] === '|') { out.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '|') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function specMatchesCommand(rule, cmd) {
  if (rule.spec === null || rule.spec === '') return true;     // Bash or Bash(*) — any command
  const c = cmd.trim();
  if (rule.prefix) return c === rule.spec || c.startsWith(rule.spec + ' ');
  return c === rule.spec;
}

// A path spec is a glob: * within a segment, ** across segments.
function globToRe(glob) {
  const esc = String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + esc.replace(/\*\*/g, ' ').replace(/\*/g, '[^/]*').replace(/ /g, '.*') + '$');
}

/**
 * Does this rule cover this call?
 *   'all'  — every segment matches (enough to ALLOW)
 *   'some' — at least one segment matches (enough to DENY)
 *   'none'
 * The all/some split is the load-bearing part: Bash(ls:*) must not allow `ls && rm -rf /`, while
 * Bash(rm:*) in a deny list must still catch the rm hiding at the end of it.
 */
export function ruleCovers(rule, toolName, args = {}) {
  if (!rule) return 'none';
  const name = String(toolName || '').toLowerCase();
  const isShell = SHELL_TOOLS.has(name);
  const ruleIsShell = rule.tool === 'bash' || rule.tool === 'shell' || rule.tool === 'sh';
  if (isShell && ruleIsShell) {
    const segs = segments(args && args.command);
    if (segs === null || !segs.length) return 'none';   // cannot reason => cannot match => falls to ask
    const hits = segs.filter((c) => specMatchesCommand(rule, c)).length;
    return hits === segs.length ? 'all' : (hits > 0 ? 'some' : 'none');
  }
  if (isShell !== ruleIsShell) return 'none';
  if (rule.tool !== name) return 'none';
  if (rule.spec === null || rule.spec === '') return 'all';
  const path = (args && (args.path || args.file || args.url)) || '';
  return globToRe(rule.spec).test(String(path)) ? 'all' : 'none';
}

/**
 * The owner's rules, applied. decision is 'allow' | 'deny' | 'ask' | 'unmatched'.
 * `unmatched` means the rules say nothing and the caller falls through to the action gate — these
 * rules are an override layer, not a replacement for it.
 */
export function decideByRules(cfg, toolName, args) {
  // This object's key order is decorative — precedence is the ORDER OF THE LOOPS below, and
  // reordering these keys provably changes nothing (a mutation doing so is inert). Said out loud
  // because "the object is in precedence order" is exactly the kind of thing a reader assumes.
  const lists = { deny: [], ask: [], allow: [] };
  for (const k of Object.keys(lists)) {
    for (const r of (cfg && Array.isArray(cfg[k]) ? cfg[k] : [])) {
      const p = parseRule(r); if (p) lists[k].push(p);
    }
  }
  // Deny first, and 'some' is enough: one refused command in a chain refuses the chain.
  for (const r of lists.deny) {
    const c = ruleCovers(r, toolName, args);
    if (c === 'all' || c === 'some') return { decision: 'deny', rule: r.source, why: 'a deny rule matches (' + r.source + ')' };
  }
  for (const r of lists.ask) {
    const c = ruleCovers(r, toolName, args);
    if (c === 'all' || c === 'some') return { decision: 'ask', rule: r.source, why: 'an ask rule matches (' + r.source + ')' };
  }
  // Allow needs EVERY segment covered.
  for (const r of lists.allow) {
    if (ruleCovers(r, toolName, args) === 'all') return { decision: 'allow', rule: r.source, why: 'an allow rule matches (' + r.source + ')' };
  }
  return { decision: 'unmatched', rule: null, why: '' };
}

/**
 * The mode's say, applied AFTER the rules.
 *
 * `bypass` is the escape hatch: no prompts, for when you are watching and want to get on with it.
 * It does NOT override a deny rule — that is handled before this is called — and it does not
 * override the action gate's `critical` tier, the handful of things that cannot be undone.
 * Everything else it waves through.
 */
export function applyMode(mode, toolName, args, { gateVerdict = null } = {}) {
  const m = MODES.includes(mode) ? mode : 'default';
  if (m === 'bypass') {
    if (gateVerdict && gateVerdict.outcome === 'deny' && gateVerdict.liftable === false) {
      return { decision: 'deny', why: 'bypass does not cover this: ' + (gateVerdict.why || 'it cannot be undone') };
    }
    return { decision: 'allow', why: 'bypass mode' };
  }
  if (m === 'acceptEdits' && EDIT_TOOLS.has(String(toolName || '').toLowerCase())) {
    return { decision: 'allow', why: 'edits are auto-accepted in this mode' };
  }
  return { decision: 'unmatched', why: '' };
}

/** Is this a mode a person must be told they are in? */
export function modeIsLoud(mode) { return mode === 'bypass'; }
