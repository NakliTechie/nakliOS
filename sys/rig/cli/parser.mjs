// parser — the C4b faux-CLI parser. A SEPARATE module from the terminal chrome
// and tested headlessly; xterm.js is only the screen (RIG §7).
//
// Slash-command syntax over the C1 registry: a typed line like
//   /ls -R src        /read src/main.py        /grep "TODO" --glob "*.py"
//   /git status       /git diff HEAD~1         /help    /help git.diff
// compiles to { kind, name, input } — a registry command name plus an input
// object coerced to the command's declared inputSchema. No shell, no PTY.

// Ergonomic aliases → registry command names. The full dotted name always works
// too (e.g. /fs.read), so every command is reachable without an alias.
const ALIASES = {
  ls: 'fs.list', dir: 'fs.list',
  read: 'fs.read', cat: 'fs.read',
  write: 'fs.write',
  stat: 'fs.stat',
  mkdir: 'fs.mkdir',
  rm: 'fs.remove', remove: 'fs.remove',
  mv: 'fs.move', move: 'fs.move',
  cp: 'fs.copy', copy: 'fs.copy',
  patch: 'fs.patch',
  glob: 'fs.glob',
  grep: 'fs.grep', find: 'fs.grep',
};
const NAMESPACES = new Set(['fs', 'git']);
const SHORT = { R: 'recursive', r: 'recursive', n: 'maxResults' };

// A marker for "this character came from inside SINGLE quotes, treat it literally". Tokenizing
// throws quotes away, so by the time $VAR expansion ran there was no way to tell `'$X'` from
// `$X` and single quotes protected nothing (forward-pass R2c). Opt-in, so the other caller is
// unaffected; the shell strips every marker at the end of expansion.
export const LITERAL_MARK = '\u0001';

// Quote-aware tokenizer. Preserves an empty quoted string as a token.
export function tokenize(s, { markLiteral = false } = {}) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (markLiteral && c === '\\' && quote !== "'" && i + 1 < s.length
      && (!quote || /[$`"\\\n]/.test(s[i + 1]))) {
      const next = s[++i];
      if (next !== '\n') { cur += /[$*?;|&<>]/.test(next) ? LITERAL_MARK + next : next; has = true; }
    } else if (quote) {
      if (c === quote) quote = null;
      // `$` is literal only inside SINGLE quotes; `*` and `?` are literal inside EITHER kind,
      // because a quoted glob must not be filename-expanded. Quoted shell operators
      // retain markers too, so a standalone ';' remains an argument after tokenization.
      else if (markLiteral && ((quote === "'" && c === '$') || /[*?;|&<>]/.test(c))) cur += LITERAL_MARK + c;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c; has = true;
    } else if (/\s/.test(c)) {
      if (cur !== '' || has) { out.push(cur); cur = ''; has = false; }
    } else {
      cur += c;
    }
  }
  if (cur !== '' || has) out.push(cur);
  return out;
}

function coerce(prop, val) {
  if (!prop) return val;
  if (prop.type === 'number') { const n = Number(val); return Number.isNaN(n) ? val : n; }
  if (prop.type === 'boolean') return val === 'true' || val === true;
  return val;
}

// Resolve the first token (+ maybe a subcommand) to a registry command name.
function resolveName(tokens, registry) {
  const first = tokens[0];
  if (!first) return null;
  if (registry.describeCommand(first)) return { name: first, consumed: 1 };
  if (ALIASES[first] && registry.describeCommand(ALIASES[first])) return { name: ALIASES[first], consumed: 1 };
  if (NAMESPACES.has(first) && tokens[1]) {
    const candidate = `${first}.${tokens[1]}`;
    if (registry.describeCommand(candidate)) return { name: candidate, consumed: 2 };
  }
  return null;
}

// Resolve a bare name/alias (for /help <name>) to a command name, or null.
export function resolveCommandName(token, registry) {
  const r = resolveName([token], registry);
  return r ? r.name : null;
}

function parseArgs(command, tokens) {
  const props = (command.inputSchema && command.inputSchema.properties) || {};
  const required = (command.inputSchema && command.inputSchema.required) || [];
  const input = {};
  const positional = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('--')) {
      const key = t.slice(2);
      const prop = props[key];
      if (prop && prop.type === 'boolean') {
        if (tokens[i + 1] === 'true' || tokens[i + 1] === 'false') input[key] = tokens[++i] === 'true';
        else input[key] = true;
      } else {
        input[key] = coerce(prop, tokens[++i]);
      }
    } else if (t.length > 1 && t[0] === '-' && Number.isNaN(Number(t))) {
      for (const ch of t.slice(1)) {
        const key = SHORT[ch] || ch;
        const prop = props[key];
        if (!prop || prop.type === 'boolean') input[key] = true;
      }
    } else {
      positional.push(t);
    }
  }
  // Assign positionals in required-then-declared order, skipping flag-set keys.
  const order = [...required, ...Object.keys(props).filter((k) => !required.includes(k))];
  let pi = 0;
  for (const key of order) {
    if (key in input) continue;
    if (pi < positional.length) input[key] = coerce(props[key], positional[pi++]);
  }
  return input;
}

/**
 * Compile a typed line into a structured intent.
 * @returns one of:
 *   { kind: 'empty' }
 *   { kind: 'error', message }
 *   { kind: 'help', target? }          (target: a resolved command name or raw)
 *   { kind: 'py', code }               (operator door to the Kiln kernel)
 *   { kind: 'unknown', verb, suggestions }
 *   { kind: 'command', name, input, command }
 */
export function compile(line, registry) {
  const trimmed = String(line == null ? '' : line).trim();
  if (trimmed === '') return { kind: 'empty' };
  if (!trimmed.startsWith('/')) {
    return { kind: 'error', message: 'commands start with "/". Try /help.' };
  }
  const body = trimmed.slice(1);
  const tokens = tokenize(body);
  if (tokens.length === 0) return { kind: 'empty' };
  const verb = tokens[0];
  if (verb === 'help') {
    if (tokens[1]) return { kind: 'help', target: resolveCommandName(tokens[1], registry) || tokens[1] };
    return { kind: 'help' };
  }
  if (verb === 'py') return { kind: 'py', code: body.slice(2).trim() };
  const resolved = resolveName(tokens, registry);
  if (!resolved) {
    const suggestions = registry.searchCommands(verb).map((m) => m.name).slice(0, 5);
    return { kind: 'unknown', verb, suggestions };
  }
  const command = registry.describeCommand(resolved.name);
  const input = parseArgs(command, tokens.slice(resolved.consumed));
  return { kind: 'command', name: resolved.name, input, command };
}
