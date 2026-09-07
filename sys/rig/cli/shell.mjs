// shell — a bash-flavoured faux shell over the C1 registry (Forge C5, Layer 1).
//
// The C4b `repl` is a typed command bus with slash syntax (`/ls -R src`). Forge's
// terminal wants a real bash/zsh feel instead: bare `ls`, `cd src`, `cat`,
// `grep`, `git status`, a working directory, flags, globs, pipes, and redirects
// — all still compiling down to the SAME safe Rig registry commands underneath.
//
// This is the headless core, the system under test: `feed(line) -> { output }`.
// xterm is only the screen (attached in Layer 2). No PTY, no arbitrary binaries:
// unknown commands are reported, not spawned. Destructive verbs (rm) route
// through the C4 agent face and stage for a `y` confirm, exactly like the repl.
//
// It is deliberately a CURATED shell — the command set below is everything it
// knows; `sed`/`awk`/`node`/etc. are "command not found" until implemented.

import { tokenize } from './parser.mjs';

// bash verb -> registry command name. The dotted name (fs.list) always works too.
const REGISTRY_ALIAS = {
  ls: 'fs.list', stat: 'fs.stat', mkdir: 'fs.mkdir',
  rm: 'fs.remove', mv: 'fs.move', cp: 'fs.copy',
  glob: 'fs.glob', patch: 'fs.patch',
};

// Short flags -> registry input keys (per command, resolved in buildRegistryInput).
const LIST_FLAGS = { R: 'recursive', a: 'all' };
const RM_FLAGS = { r: 'recursive', R: 'recursive', f: 'force' };

// ── path helpers: cwd lives inside the fileops root; '' is the root, and a
// path can never climb above it. ──
function normalizePath(cwd, arg) {
  // the quote fix's internal marker is never part of a real path
  const raw = String(arg == null ? '' : arg).replace(/\u0001/g, '');
  const abs = raw.startsWith('/');
  const base = abs ? [] : cwd.split('/').filter(Boolean);
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (base.length) base.pop(); continue; }
    base.push(seg);
  }
  return base.join('/');
}

// ── split a line into statements (`;`, `&&`) then pipelines (`|`) then argv,
// pulling trailing redirects (`>`, `>>`) off the last stage. Reuses the
// quote-aware tokenizer so quoted operators stay literal. ──
function parseLine(line) {
  const tokens = tokenizeOps(line);
  const statements = [];
  let stmt = { op: 'first', pipeline: [], redirect: null, stdinFrom: null };
  let stage = [];
  const pushStage = () => { if (stage.length) { stmt.pipeline.push(stage); stage = []; } };
  const pushStmt = () => { pushStage(); if (stmt.pipeline.length) statements.push(stmt); };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === ';' || t === '&&' || t === '||') { pushStmt(); stmt = { op: t, pipeline: [], redirect: null, stdinFrom: null }; }
    else if (t === '|') { pushStage(); }
    else if (t === '>' || t === '>>') { stmt.redirect = { append: t === '>>', path: tokens[++i] }; }
    else if (t === '<') { stmt.stdinFrom = tokens[++i]; } // was silently ignored → empty stdin, exit 0 (R2e)
    else stage.push(t);
  }
  pushStmt();
  return statements;
}

// Tokenize while keeping the shell operators as their own tokens. Quotes
// protect operators (so `echo "a|b"` is one token). Builds on `tokenize` by
// pre-splitting unquoted operators with spaces.
//
// Stderr/stdout fd-merge idioms are normalized here because this shell already
// combines stdout+stderr into one stream (see runStage's python branch and the
// merged returns). So `2>&1` / `1>&2` / `2>&-` are pure no-ops — stripped
// rather than parsed as a redirect to a literal `&1` file. `&>` / `&>>`
// (redirect BOTH streams to a file) and fd-prefixed redirects `2>file` /
// `2>>file` collapse to a plain `>` / `>>` of the already-merged stream.
function tokenizeOps(line) {
  let out = '';
  let quote = null;
  const s = String(line == null ? '' : line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { out += c; if (c === quote) quote = null; continue; }
    // an unquoted `#` at a token boundary starts a comment — it used to be a 127 (R2e)
    if (c === '#' && (out === '' || /\s$/.test(out))) break;
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === ';') { out += ` ${c} `; continue; }
    if (c === '|') {
      if (s[i + 1] === '|') { out += ' || '; i++; } else { out += ' | '; }
      continue;
    }
    // fd-prefixed redirect: a lone `1`/`2` (token start) immediately before `>`.
    // `2>&1`/`1>&2`/`2>&-` are no-ops; `2>file`/`2>>file` become a plain redirect.
    if ((c === '1' || c === '2') && s[i + 1] === '>') {
      const prevCh = out.length ? out[out.length - 1] : '';
      if (prevCh === '' || prevCh === ' ') {
        let j = i + 1;                                   // at the first '>'
        let op = '>';
        if (s[j + 1] === '>') { op = '>>'; j++; }        // '>>' operator
        if (s[j + 1] === '&' && /[12-]/.test(s[j + 2] || '')) {
          i = j + 2; continue;                           // N>&M / N>&- → strip
        }
        out += ` ${op} `; i = j; continue;               // N>file → merged redirect
      }
    }
    if (c === '>') {
      if (s[i + 1] === '>') { out += ' >> '; i++; } else { out += ' > '; }
      continue;
    }
    if (c === '<') { out += ' < '; continue; }
    if (c === '&') {
      if (s[i + 1] === '&') { out += ' && '; i++; continue; }
      // `&>` / `&>>` — redirect both streams to a file. Already merged, so this
      // is just a redirect of the combined stream.
      if (s[i + 1] === '>') {
        let j = i + 1; let op = '>';
        if (s[j + 1] === '>') { op = '>>'; j++; }
        out += ` ${op} `; i = j; continue;
      }
      out += c; continue;
    }
    out += c;
  }
  return tokenize(out, { markLiteral: true });
}

// eslint-disable-next-line no-control-regex
const BINARY_BYTES = new RegExp("[\\u0000-\\u0008\\u000e-\\u001f]");

// Split text into lines the way coreutils do: a single trailing newline is a
// line terminator, not an extra empty line.
const linesOf = (t) => {
  const s = String(t == null ? '' : t);
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
};
// Written files carry a trailing newline (like echo's), so round-trips through
// the fs stay line-clean.
const withTrailingNewline = (t) => (t === '' || t.endsWith('\n') ? t : t + '\n');

// printf backslash escapes: \n \t \r \\ \0 \a \b \f \v.
function unescapePrintf(s) {
  const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
  return String(s).replace(/\\(n|t|r|\\|0|a|b|f|v)/g, (_, c) => map[c]);
}

function decodeData(data) {
  if (typeof data === 'string') return data;
  if (data && data.byteLength != null) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      if (!BINARY_BYTES.test(text)) return text;
    } catch (_) { /* binary */ }
    return `<${data.byteLength} bytes>`;
  }
  return '';
}

// Render a registry result as terminal text (bash-ish, not the repl's format).
function renderResult(name, res, { long } = {}) {
  if (res.entries) {
    return res.entries
      .map((e) => (long ? `${e.type === 'dir' ? 'd' : '-'} ${e.name}` : e.name))
      .join(long ? '\n' : '  ');
  }
  if (res.matches) return res.matches.map((m) => (typeof m === 'object' ? `${m.path}:${m.line}: ${m.text}` : m)).join('\n');
  if (typeof res.data === 'string' || (res.data && res.data.byteLength != null)) return decodeData(res.data);
  if (res.stat) return `${res.stat.type} ${res.stat.size}`;
  if (res.commits) return res.commits.map((c) => `${c.oid.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n');
  if (res.branches) return res.branches.join('\n');
  if (res.changes) return res.changes.map((c) => `${c.status[0].toUpperCase()} ${c.path}`).join('\n') || '(clean)';
  if (res.oid) return res.oid;
  return '';
}

// Map an isomorphic-git statusMatrix row [filepath, head, workdir, stage] to a
// short porcelain code. null = unmodified (omit from `git status`).
function statusCode(row) {
  const [f, head, work, stage] = row;
  if (head === 1 && work === 1 && stage === 1) return null; // clean
  if (head === 0 && stage === 0) return `?? ${f}`;           // untracked
  if (head === 0) return `A  ${f}`;                          // staged new
  if (work === 0) return `${stage === 0 ? 'D ' : ' D'} ${f}`; // deleted
  const staged = stage !== 1;                                // differs from HEAD in index
  const dirty = work === 2 && stage === 1;                   // differs from index in tree
  return `${staged ? 'M' : ' '}${dirty ? 'M' : ' '} ${f}`;
}

function renderGit(sub, res) {
  if (sub === 'status') {
    if (res.matrix) return res.matrix.map(statusCode).filter(Boolean).join('\n') || '(clean)';
    if (typeof res.status === 'string') return res.status;
  }
  if (res.commits) return res.commits.map((c) => `${c.oid.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n');
  if (res.branches) return res.branches.join('\n');
  if (typeof res.diff === 'string') return res.diff;
  if (res.oid) return `[${res.oid.slice(0, 7)}]`;
  return 'ok';
}

// The file types `rg -t` knows. Small and explicit: an agent that asks for a
// type we do not know gets told, with the list, rather than an empty result.
const RG_TYPES = Object.freeze({
  py: ['py'], js: ['js', 'mjs', 'cjs'], ts: ['ts', 'tsx'], jsx: ['jsx'],
  html: ['html', 'htm'], css: ['css'], json: ['json'], md: ['md', 'markdown'],
  rust: ['rs'], go: ['go'], java: ['java'], c: ['c', 'h'], cpp: ['cpp', 'cc', 'hpp'],
  sh: ['sh', 'bash', 'zsh'], yaml: ['yml', 'yaml'], toml: ['toml'], xml: ['xml'],
  sql: ['sql'], txt: ['txt'], svg: ['svg'],
});

function globToRe(glob) {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*'; }
    else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp(re + '$');
}

export function createShell({ registry, face, cwd = '', kiln = null } = {}) {
  if (!registry || !face) throw new Error('createShell requires { registry, face }');
  const state = { cwd, history: [], vars: new Map([['HOME', '/']]) };

  // $VAR / ${VAR} / $? / $PWD expansion. NOTE: the tokenizer already stripped
  // quotes, so (unlike POSIX) single-quotes don't suppress expansion here — a
  // known simplification tracked under the POSIX-later agenda.
  function expand(token) {
    // A `$` carrying LITERAL_MARK came from inside single quotes and is NOT a variable.
    const out = String(token).replace(
      /\u0001\$|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|\$\?/g,
      (m, braced, bare) => {
        if (m.charCodeAt(0) === 1) return '$';
        if (m === '$?') return String(lastCode);
        const name = braced || bare;
        if (name === 'PWD') return '/' + state.cwd;
        return state.vars.has(name) ? state.vars.get(name) : '';
      },
    );
    return out; // markers survive until after glob expansion, then stripArgMarks clears them
  }
  let pending = null; // { proposalId, verb }
  let lastCode = 0;

  // Build a registry command input from argv, resolving paths against cwd.
  function buildRegistryInput(cmdName, argv) {
    const command = registry.describeCommand(cmdName);
    const props = (command.inputSchema && command.inputSchema.properties) || {};
    const input = {};
    const positional = [];
    const flagMap = cmdName === 'fs.list' ? LIST_FLAGS : cmdName === 'fs.remove' ? RM_FLAGS : {};
    for (let i = 0; i < argv.length; i++) {
      const t = argv[i];
      if (t.startsWith('--')) {
        const key = t.slice(2);
        const prop = props[key];
        if (prop && prop.type === 'boolean') input[key] = true;
        else input[key] = argv[++i];
      } else if (t.length > 1 && t[0] === '-') {
        for (const ch of t.slice(1)) { const key = flagMap[ch]; if (key && props[key]) input[key] = true; }
      } else positional.push(t);
    }
    // Path-shaped keys resolve against cwd; two-arg commands use from/to.
    if ('from' in props && 'to' in props) {
      input.from = normalizePath(state.cwd, positional[0] || '');
      input.to = normalizePath(state.cwd, positional[1] || '');
    } else if ('path' in props) {
      input.path = positional.length ? normalizePath(state.cwd, positional[0]) : state.cwd;
    } else if ('pattern' in props) {
      input.pattern = positional[0] || '';
      if (positional[1]) input.cwd = normalizePath(state.cwd, positional[1]);
      else input.cwd = state.cwd;
    }
    if (props.encoding && !('encoding' in input)) input.encoding = 'utf-8';
    return input;
  }

  async function runRegistry(cmdName, argv, stdin) {
    const long = cmdName === 'fs.list' && argv.includes('-l');
    // Multi-path fan-out for `rm`: a glob (`rm *.txt`) expands to several
    // positionals, but fs.remove takes one `path`. Invoke per path so every
    // match is removed (bash semantics), and batch the destructive confirms
    // into one prompt instead of losing all but the first match.
    if (cmdName === 'fs.remove') {
      const flags = argv.filter((a) => a.length > 1 && a[0] === '-');
      const paths = argv.filter((a) => !(a.length && a[0] === '-'));
      if (paths.length > 1) {
        const proposals = [];
        const errors = [];
        for (const p of paths) {
          const res = await face.invoke('fs.remove', buildRegistryInput(cmdName, [...flags, p]));
          if (res.staged) proposals.push({ proposalId: res.proposalId, verb: `rm ${p}` });
          else if (!res.ok) errors.push(`rm: ${p}: ${res.message || 'failed'}`);
        }
        if (proposals.length) {
          return { staged: proposals[0].proposalId, proposals, verb: `rm (${proposals.length} paths)` };
        }
        if (errors.length) return { text: errors.join('\n'), code: 1 };
        return { text: '', code: 0 };
      }
    }
    const input = buildRegistryInput(cmdName, argv);
    const res = await face.invoke(cmdName, input);
    if (res.staged) return { staged: res.proposalId, verb: cmdName };
    if (!res.ok) return { text: `${cmdName}: ${res.code || 'error'}: ${res.message || 'failed'}`, code: 1 };
    return { text: renderResult(cmdName, res, { long }), code: 0 };
  }

  // ── builtins: shell-native, may consume/produce piped text ──
  const builtins = {
    cd(argv) {
      const target = normalizePath(state.cwd, argv[0] || '');
      state.cwd = target;
      return { text: '', code: 0 };
    },
    pwd() { return { text: '/' + state.cwd, code: 0 }; },
    echo(argv) { return { text: argv.join(' '), code: 0 }; },
    clear() { return { text: '', code: 0, clear: true }; },
    history() { return { text: state.history.map((h, i) => `${i + 1}  ${h}`).join('\n'), code: 0 }; },
    which(argv) {
      const v = argv[0];
      const known = builtins[v] || REGISTRY_ALIAS[v] || registry.describeCommand(v) || (v === 'git' || v === 'python' || v === 'python3' || v === 'py');
      return { text: known ? v : `${v} not found`, code: known ? 0 : 1 };
    },
    async cat(argv, stdin) {
      if (!argv.length) return { text: stdin || '', code: 0 };
      const parts = [];
      for (const a of argv) {
        const res = await face.invoke('fs.read', { path: normalizePath(state.cwd, a), encoding: 'utf-8' });
        if (res.ok) parts.push(decodeData(res.data));
        else return { text: `cat: ${a}: ${res.code || 'error'}`, code: 1 };
      }
      return { text: parts.join(''), code: 0 };
    },
    // -v INVERTED (it returned exactly the lines it was asked to exclude), -i was ignored so a
    // match reported none, -c was ignored, -r returned empty exit 1 — all silently (R2b).
    async grep(argv, stdin) {
      const { flags, positionals } = splitArgs(argv);
      if (flags.some((f) => !f.startsWith('--') && f.slice(1).includes('r'))) {
        return { text: 'grep: -r is not implemented here — use `rg <pattern>` for a recursive search', code: 2 };
      }
      const bad = unsupportedFlag('grep', flags, ['n', 'v', 'i', 'c', 'E', 'F', 'h', 'H']);
      if (bad) return flagErr('grep', bad);
      const has = (ch) => flags.some((f) => !f.startsWith('--') && f.slice(1).includes(ch));
      const nline = has('n'), invert = has('v'), icase = has('i'), count = has('c');
      const pattern = positionals[0] || '';
      const files = positionals.slice(1);
      const fixed = has('F');
      const re = new RegExp(fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, icase ? 'i' : '');
      const filter = (text, prefix) => linesOf(text)
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => re.test(l) !== invert)
        .map(({ l, i }) => `${prefix ? prefix + ':' : ''}${nline ? (i + 1) + ':' : ''}${l}`);
      let hits = [];
      if (files.length) {
        for (const f of files) {
          const res = await face.invoke('fs.read', { path: normalizePath(state.cwd, f), encoding: 'utf-8' });
          if (!res.ok) return { text: `grep: ${f}: ${res.code || 'ENOENT'}`, code: 2 };
          hits.push(...filter(decodeData(res.data), files.length > 1 ? f : ''));
        }
      } else {
        hits = filter(stdin || '', '');
      }
      if (count) return { text: String(hits.length), code: hits.length ? 0 : 1 };
      return { text: hits.join('\n'), code: hits.length ? 0 : 1 };
    },
    async head(argv, stdin) {
      const { flags, positionals } = splitArgs(argv, { valueFlags: ['-n'] });
      const bad = unsupportedFlag('head', flags, ['n']); if (bad) return flagErr('head', bad);
      const n = flagNum(argv, 10);
      if (n && typeof n === 'object' && n.bad !== undefined) return { text: `head: invalid line count: ${n.bad}`, code: 2 };
      const inp = await textInput('head', positionals, stdin); if (inp.failed) return inp;
      return { text: linesOf(inp.text).slice(0, n).join('\n'), code: 0 };
    },
    async tail(argv, stdin) {
      const { flags, positionals } = splitArgs(argv, { valueFlags: ['-n'] });
      const bad = unsupportedFlag('tail', flags, ['n']); if (bad) return flagErr('tail', bad);
      const n = flagNum(argv, 10);
      if (n && typeof n === 'object' && n.bad !== undefined) return { text: `tail: invalid line count: ${n.bad}`, code: 2 };
      const inp = await textInput('tail', positionals, stdin); if (inp.failed) return inp;
      const lines = linesOf(inp.text);
      return { text: lines.slice(Math.max(0, lines.length - n)).join('\n'), code: 0 };
    },
    async wc(argv, stdin) {
      const { flags, positionals } = splitArgs(argv);
      const bad = unsupportedFlag('wc', flags, ['l', 'w', 'c', 'm']); if (bad) return flagErr('wc', bad);
      const inp = await textInput('wc', positionals, stdin); if (inp.failed) return inp;
      const text = inp.text;
      // LINES, not newlines: a pipeline's last line usually has no trailing newline, so counting
      // "\n" made `grep x | wc -l` undercount by one on every non-empty result (R2e).
      const lines = text === '' ? 0 : linesOf(text).length;
      const words = text.split(/\s+/).filter(Boolean).length;
      const has = (ch) => flags.some((f) => f.slice(1).includes(ch));
      if (has('l')) return { text: String(lines), code: 0 };
      if (has('w')) return { text: String(words), code: 0 };
      if (has('c') || has('m')) return { text: String(text.length), code: 0 };
      return { text: `${lines} ${words} ${text.length}`, code: 0 };
    },
    async sort(argv, stdin) {
      const { flags, positionals } = splitArgs(argv);
      const bad = unsupportedFlag('sort', flags, ['r', 'n', 'u', 'f']); if (bad) return flagErr('sort', bad);
      const inp = await textInput('sort', positionals, stdin); if (inp.failed) return inp;
      const has = (ch) => flags.some((f) => f.slice(1).includes(ch));
      let lines = linesOf(inp.text);
      lines = has('n') ? lines.slice().sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0))
            : has('f') ? lines.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
            : lines.slice().sort();
      if (has('r')) lines.reverse();
      if (has('u')) lines = [...new Set(lines)];
      return { text: lines.join('\n'), code: 0 };
    },
    async uniq(argv, stdin) {
      const { flags, positionals } = splitArgs(argv);
      const bad = unsupportedFlag('uniq', flags, ['c', 'd', 'u']); if (bad) return flagErr('uniq', bad);
      const inp = await textInput('uniq', positionals, stdin); if (inp.failed) return inp;
      const has = (ch) => flags.some((f) => f.slice(1).includes(ch));
      const runs = [];
      for (const l of linesOf(inp.text)) {
        if (runs.length && runs[runs.length - 1].l === l) runs[runs.length - 1].n++;
        else runs.push({ l, n: 1 });
      }
      let keep = runs;
      if (has('d')) keep = runs.filter((r) => r.n > 1);
      if (has('u')) keep = runs.filter((r) => r.n === 1);
      return { text: keep.map((r) => (has('c') ? `${String(r.n).padStart(7)} ${r.l}` : r.l)).join('\n'), code: 0 };
    },
    async touch(argv) {
      const path = normalizePath(state.cwd, argv[0] || '');
      const exists = await face.invoke('fs.stat', { path });
      if (exists.ok) return { text: '', code: 0 };
      const res = await face.invoke('fs.write', { path, data: '', createParents: true });
      return { text: res.ok ? '' : `touch: ${res.message || 'failed'}`, code: res.ok ? 0 : 1 };
    },
    // ls that lists a directory but PRINTS a file (coreutils behaviour). The old
    // path routed every `ls X` through fs.list, so `ls afile` threw ENOTDIR and
    // misled callers into thinking a file was a directory.
    async ls(argv) {
      { const bad = unsupportedFlag('ls', argv.filter((a) => a.startsWith('-')), ['R', 'a', 'l']); if (bad) return flagErr('ls', bad); }
      const long = argv.some((a) => /^-\w*l/.test(a));
      const positionals = argv.filter((a) => !a.startsWith('-'));
      const targets = positionals.length ? positionals : [null];
      const results = [];
      let failed = false;
      for (const p of targets) {
        const abs = p == null ? state.cwd : normalizePath(state.cwd, p);
        const st = await face.invoke('fs.stat', { path: abs });
        if (st.ok && st.stat && st.stat.type === 'file') {
          const name = p != null ? p : abs.split('/').pop();
          results.push(long ? `- ${name}` : name);
          continue;
        }
        const input = { path: abs };
        for (const t of argv) {
          if (t.length > 1 && t[0] === '-' && t[1] !== '-') {
            for (const ch of t.slice(1)) { if (LIST_FLAGS[ch]) input[LIST_FLAGS[ch]] = true; }
          }
        }
        const res = await face.invoke('fs.list', input);
        if (!res.ok) { results.push(`ls: ${p ?? '.'}: ${res.code || 'error'}`); failed = true; continue; }
        results.push(renderResult('fs.list', res, { long }));
      }
      // a missing path used to still exit 0, so `ls d || mkdir d` never took the fallback (R2e)
      return { text: results.filter((s) => s !== '').join('\n'), code: failed ? 1 : 0 };
    },
    // printf FORMAT [ARGS] — backslash escapes + %s/%d/%%. Unlike echo it adds no
    // trailing newline of its own; the format supplies it (\n).
    true() { return { text: '', code: 0 }; },
    false() { return { text: '', code: 1 }; },
    printf(argv) {
      if (!argv.length) return { text: '', code: 0 };
      const fmt = unescapePrintf(argv[0]);
      const args = argv.slice(1);
      let ai = 0;
      const text = fmt.replace(/%[sd%]/g, (m) => {
        if (m === '%%') return '%';
        const v = ai < args.length ? args[ai++] : '';
        return m === '%d' ? String(parseInt(v, 10) || 0) : String(v);
      });
      return { text, code: 0, raw: true };
    },
    // test / [ EXPR ] — the condition primitive. No output; the exit code is the
    // answer, so it composes with && and || (e.g. `[ -d src ] || mkdir src`).
    test(argv) { return evalTest(argv); },
    '['(argv) {
      const a = argv.slice();
      if (a[a.length - 1] !== ']') return { text: '[: missing `]`', code: 2 };
      a.pop();
      return evalTest(a);
    },
    // sed — the common subset: `s/pat/rep/[g]` substitution, `-n 'Np'` print line
    // N, `-n '/re/p'` print matching lines. Reads stdin.
    async sed(argv, stdin) {
      if (argv.some((a) => a === '-i' || a.startsWith('-i'))) {
        return { text: 'sed: -i (in-place) is not implemented — use the `edit` tool, which is checked and reversible', code: 2 };
      }
      { const bad = unsupportedFlag('sed', argv.filter((a) => a.startsWith('-')), ['n', 'E', 'r']); if (bad) return flagErr('sed', bad); }
      const pos = argv.filter((a) => !a.startsWith('-'));
      const script = pos[0] || '';
      // a file argument used to be IGNORED, so `sed 's/a/b/' f.txt` returned "" exit 0 (R2a)
      const inp = await textInput('sed', pos.slice(1), stdin); if (inp.failed) return inp;
      const lines = linesOf(inp.text);
      let m = /^s\/((?:[^/\\]|\\.)*)\/((?:[^/\\]|\\.)*)\/([gips]*)$/.exec(script);
      if (m) {
        const re = new RegExp(m[1], m[3].includes('g') ? 'g' : '');
        const rep = m[2].replace(/\\\//g, '/');
        return { text: lines.map((l) => l.replace(re, rep)).join('\n'), code: 0 };
      }
      let pm = /^(\d+)p$/.exec(script);
      if (pm) { const l = lines[Number(pm[1]) - 1]; return { text: l == null ? '' : l, code: 0 }; }
      let rp = /^\/(.*)\/p$/.exec(script);
      if (rp) { const re = new RegExp(rp[1]); return { text: lines.filter((l) => re.test(l)).join('\n'), code: 0 }; }
      return { text: `sed: unsupported script: ${script}`, code: 1 };
    },
    // rg — recursive content search (ripgrep-flavoured), the tool coding agents
    // reach for by default, so its flag surface has to be honest. It used to
    // accept ANY flag and quietly ignore it: `rg "def solve" --type py` parsed
    // "py" as the search PATH, found nothing, and returned empty with no error —
    // so an agent asked the same question four ways and got four blanks. Now it
    // implements -i/-l/-n/-c/--files/-t/--type/-g/--glob and REFUSES the rest,
    // like every other builtin here.
    async rg(argv) {
      const rawFlags = argv.filter((a) => a.startsWith('-'));
      const bad = unsupportedFlag('rg', rawFlags, ['i', 'l', 'n', 'c', '--files', '--type', '--glob', 't', 'g']);
      if (bad) return flagErr('rg', bad);

      // -t/--type and -g/--glob take a value, which must not be read as a path.
      const positionals = []; const types = []; const globs = [];
      let ignoreCase = false, filesOnly = false, listFiles = false, countOnly = false;
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--files') { listFiles = true; continue; }
        if (a === '-t' || a === '--type') { types.push(argv[++i]); continue; }
        if (a === '-g' || a === '--glob') { globs.push(argv[++i]); continue; }
        if (a.startsWith('--type=')) { types.push(a.slice(7)); continue; }
        if (a.startsWith('--glob=')) { globs.push(a.slice(7)); continue; }
        if (a.startsWith('-') && a.length > 1) {
          for (const ch of a.slice(1)) {
            if (ch === 'i') ignoreCase = true;
            else if (ch === 'l') filesOnly = true;
            else if (ch === 'c') countOnly = true;
          }
          continue;
        }
        positionals.push(a);
      }

      const pattern = listFiles ? null : (positionals.shift() ?? '');
      const paths = positionals.length ? positionals : [state.cwd || ''];
      const extsFor = (ty) => (RG_TYPES[ty] || null);
      for (const ty of types) if (!extsFor(ty)) {
        return { text: `rg: unknown type ${ty} — known types: ${Object.keys(RG_TYPES).sort().join(' ')}`, code: 2 };
      }
      const wantExts = types.length ? new Set(types.flatMap(extsFor)) : null;
      const globRes = globs.map((g) => globToRe(g));

      // Collect candidate files from every path argument: a file is itself, a
      // directory is everything under it. Previously only the FIRST extra
      // positional was honoured, and only ever as a directory.
      const seen = new Set(); const files = [];
      const missing = [];
      for (const raw of paths) {
        const norm = normalizePath(state.cwd, raw);
        const st = await face.invoke('fs.stat', { path: norm });
        if (st && st.ok && st.stat && st.stat.type === 'file') {
          if (!seen.has(norm)) { seen.add(norm); files.push(norm); }
          continue;
        }
        const g = await face.invoke('fs.glob', { pattern: (norm ? norm + '/' : '') + '**', cwd: '' });
        if (!g.ok) return { text: `rg: ${g.message || 'search failed'}`, code: 1 };
        // A path that is neither a file nor a non-empty directory is a mistake
        // worth reporting. Returning empty made `rg PATTERN --type py` — where
        // "py" was read as a path — indistinguishable from "no matches", which
        // is how an agent ends up asking the same question four times.
        if (!g.matches.length && !(st && st.ok)) { missing.push(raw); continue; }
        for (const f of g.matches) if (!seen.has(f)) { seen.add(f); files.push(f); }
      }
      if (missing.length && !files.length) {
        return { text: missing.map((m) => `rg: ${m}: no such file or directory`).join('\n'), code: 2 };
      }

      const prefix = state.cwd ? state.cwd + '/' : '';
      const rel = (p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
      const keep = (p) => {
        if (wantExts) { const dot = p.lastIndexOf('.'); if (dot < 0 || !wantExts.has(p.slice(dot + 1))) return false; }
        if (globRes.length && !globRes.some((re) => re.test(rel(p)) || re.test(p.split('/').pop()))) return false;
        return true;
      };
      const chosen = files.filter(keep);

      if (listFiles) return { text: chosen.map(rel).join('\n'), code: chosen.length ? 0 : 1 };

      const t0 = Date.now();
      let filesRead = 0, bytesRead = 0;
      const re = new RegExp(pattern, ignoreCase ? 'i' : '');
      const out = [];
      for (const path of chosen) {
        const r = await face.invoke('fs.read', { path, encoding: 'utf-8' });
        if (!r.ok) continue;
        const text = decodeData(r.data);
        // Binary detection by NUL byte, as grep and ripgrep do. This was
        // `text.startsWith('<')`, which silently discarded every HTML, XML and
        // SVG file in the workspace.
        if (typeof text !== 'string' || text.includes('\u0000')) continue;
        filesRead++;
        bytesRead += text.length;
        const hits = [];
        linesOf(text).forEach((l, i) => { re.lastIndex = 0; if (re.test(l)) hits.push({ l, i }); });
        if (!hits.length) continue;
        if (filesOnly) { out.push(rel(path)); continue; }
        if (countOnly) { out.push(`${rel(path)}:${hits.length}`); continue; }
        for (const { l, i } of hits) out.push(`${rel(path)}:${i + 1}:${l}`);
      }
      // Measurement only (plan/anvil-indexed-search.md §6); never fails the search.
      try {
        await face.invoke('fs.recordSearch', {
          via: 'shell.rg', pattern: String(pattern), cwd: state.cwd || '', glob: '**',
          filesWalked: files.length, filesRead, bytesRead,
          matches: out.length, truncated: false, ms: Date.now() - t0,
        });
      } catch (_) { /* a meter never breaks a search */ }
      return { text: out.join('\n'), code: out.length ? 0 : 1 };
    },
    // awk — the common one-liner subset: `awk [-F sep] '{print $N}'` / `'{print}'`.
    async awk(argv, stdin) {
      { const bad = unsupportedFlag('awk', argv.filter((a) => a.startsWith('-') && !a.startsWith('-F')), ['F']); if (bad) return flagErr('awk', bad); }
      let sep = null; const parts = [];
      for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '-F') { sep = argv[++i]; }
        else if (argv[i].startsWith('-F')) { sep = argv[i].slice(2); }
        else parts.push(argv[i]);
      }
      // the program is the first positional; anything after it is a FILE, which used to be
      // swallowed into the program text and then ignored, returning "" exit 0 (R2a)
      const prog = parts[0] || '';
      const inp = await textInput('awk', parts.slice(1), stdin); if (inp.failed) return inp;
      stdin = inp.text;
      const m = /\{\s*print\s*(.*?)\s*\}/.exec(prog);
      const fields = (line) => (sep ? line.split(sep) : line.split(/\s+/).filter(Boolean));
      const spec = m ? m[1].trim() : '$0';
      const render = (line) => {
        if (spec === '' || spec === '$0') return line;
        return spec.split(/\s*,\s*/).map((tok) => {
          const fm = /^\$(\d+)$/.exec(tok);
          if (fm) { const n = Number(fm[1]); return n === 0 ? line : (fields(line)[n - 1] ?? ''); }
          return tok.replace(/^["']|["']$/g, '');
        }).join(' ');
      };
      return { text: linesOf(stdin || '').map(render).join('\n'), code: 0 };
    },
    // diff — line-level unified-ish diff of two files (enough for the agent to see
    // what changed / confirm an edit).
    async diff(argv) {
      const files = argv.filter((a) => !a.startsWith('-'));
      if (files.length < 2) return { text: 'usage: diff <a> <b>', code: 2 };
      const a = await face.invoke('fs.read', { path: normalizePath(state.cwd, files[0]), encoding: 'utf-8' });
      const b = await face.invoke('fs.read', { path: normalizePath(state.cwd, files[1]), encoding: 'utf-8' });
      if (!a.ok) return { text: `diff: ${files[0]}: not found`, code: 2 };
      if (!b.ok) return { text: `diff: ${files[1]}: not found`, code: 2 };
      const la = linesOf(decodeData(a.data)); const lb = linesOf(decodeData(b.data));
      const out = []; const n = Math.max(la.length, lb.length);
      for (let i = 0; i < n; i++) {
        if (la[i] === lb[i]) continue;
        if (la[i] !== undefined) out.push(`- ${la[i]}`);
        if (lb[i] !== undefined) out.push(`+ ${lb[i]}`);
      }
      return { text: out.join('\n'), code: out.length ? 1 : 0 };
    },
    // xargs — take stdin tokens and append them to a command, then run it.
    async xargs(argv, stdin) {
      const tokens = String(stdin || '').split(/\s+/).filter(Boolean);
      if (!argv.length) return { text: tokens.join(' '), code: 0 };
      return runStage([...argv, ...tokens], '');
    },
    // tee — write stdin to a file and also pass it through.
    async tee(argv, stdin) {
      const path = normalizePath(state.cwd, argv.find((a) => !a.startsWith('-')) || '');
      if (path) await face.invoke('fs.write', { path, data: withTrailingNewline(stdin || ''), createParents: true });
      return { text: stdin || '', code: 0 };
    },
    async cut(argv, stdin) {
      // both spellings: `-d: -f2` (attached) and `-d : -f 2` (separate)
      let delim = '\t', spec = '', mode = 'f', badFlag = null;
      const files = [];
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('-') || a === '-') { files.push(a); continue; }
        const k = a[1], attached = a.slice(2);
        if (k === 'd') { delim = attached !== '' ? attached : (argv[++i] ?? '\t'); continue; }
        if (k === 'f' || k === 'c') { mode = k; spec = attached !== '' ? attached : (argv[++i] ?? ''); continue; }
        badFlag = `-${k}`; break;
      }
      if (badFlag) return flagErr('cut', badFlag);
      // ranges too: -f1-3 and -f1,3 were both misread as a single field (R2e)
      const want = [];
      for (const part of String(spec).split(',')) {
        const m = /^(\d+)-(\d+)$/.exec(part);
        if (m) { for (let n = Number(m[1]); n <= Number(m[2]); n++) want.push(n); }
        else if (/^\d+$/.test(part)) want.push(Number(part));
      }
      const inp = await textInput('cut', files, stdin); if (inp.failed) return inp;
      const pick = (line) => (mode === 'c'
        ? want.map((n) => line[n - 1] ?? '').join('')
        : want.map((n) => line.split(delim)[n - 1] ?? '').join(delim));
      return { text: linesOf(inp.text).map(pick).join('\n'), code: 0 };
    },
    async tr(argv, stdin) {
      const { flags, positionals } = splitArgs(argv);
      const bad = unsupportedFlag('tr', flags, ['d', 's']); if (bad) return flagErr('tr', bad);
      const del = flags.some((f) => f.slice(1).includes('d'));
      // a-z used to be taken LITERALLY (three characters), so `tr a-z A-Z` mapped almost nothing
      const expandRange = (spec) => {
        const out = [];
        const t = String(spec || '');
        for (let i = 0; i < t.length; i++) {
          if (t[i + 1] === '-' && t[i + 2] && t.charCodeAt(i) <= t.charCodeAt(i + 2)) {
            for (let c = t.charCodeAt(i); c <= t.charCodeAt(i + 2); c++) out.push(String.fromCharCode(c));
            i += 2;
          } else out.push(t[i]);
        }
        return out;
      };
      const from = expandRange(positionals[0]);
      const to = del ? [] : expandRange(positionals[1]);
      const files = positionals.slice(del ? 1 : 2);
      const inp = await textInput('tr', files, stdin); if (inp.failed) return inp;
      const text = inp.text;
      let out = '';
      for (const ch of text) {
        const k = from.indexOf(ch);
        if (k < 0) { out += ch; continue; }
        if (del) continue;
        out += to.length ? (to[Math.min(k, to.length - 1)]) : ch;
      }
      return { text: out, code: 0 };
    },
    basename(argv) {
      let b = String(argv[0] || '').replace(/\/+$/, '').split('/').pop() || '/';
      if (argv[1] && b.endsWith(argv[1])) b = b.slice(0, -argv[1].length);
      return { text: b, code: 0 };
    },
    dirname(argv) {
      const p = String(argv[0] || '').replace(/\/+$/, '');
      const i = p.lastIndexOf('/');
      return { text: i > 0 ? p.slice(0, i) : (i === 0 ? '/' : '.'), code: 0 };
    },
    // chmod — accepted for script compatibility; the virtual fs has no POSIX
    // permission bits, so it is a successful no-op (documented).
    chmod() { return { text: '', code: 0 }; },
    env() {
      const lines = [...state.vars.entries()].sort().map(([k, v]) => `${k}=${v}`);
      lines.push(`PWD=/${state.cwd}`);
      return { text: lines.join('\n'), code: 0 };
    },
    export(args) {
      for (const a of args) {
        const eq = a.indexOf('=');
        if (eq > 0) state.vars.set(a.slice(0, eq), a.slice(eq + 1));
      }
      return { text: '', code: 0 };
    },
    unset(args) { for (const a of args) state.vars.delete(a); return { text: '', code: 0 }; },
    help() {
      const cmds = ['cd', 'pwd', 'ls', 'cat', 'echo', 'printf', 'grep', 'rg', 'sed', 'awk', 'diff',
        'find', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'tee', 'xargs', 'basename', 'dirname',
        'test', '[', 'touch', 'mkdir', 'rm', 'mv', 'cp', 'chmod', 'stat', 'git', 'python', 'python3',
        'env', 'export', 'unset', 'clear', 'history', 'which'];
      // Say what is ACTUALLY here. `help` used to list these as if they were coreutils, and the
      // agent believed it — flags it did not implement were ignored rather than refused
      // (forward-pass R3a). An unsupported flag is now an error, so this text and the behaviour
      // agree.
      return { text: 'commands: ' + cmds.join(' ')
        + '\noperators: | && || ; > >> < 2>&1   globs: * ?   comments: #'
        + '\nvars: NAME=value, $NAME, ${NAME}, $?, $PWD  (single quotes are literal; double quotes expand)'
        + '\nThis is a CURATED shell, not coreutils. Each builtin implements a documented subset and'
        + '\nREFUSES an unsupported flag (exit 2) rather than ignoring it. Notably:'
        + '\n  grep -n -v -i -c -E -F      (no -r; use `rg` for a recursive search)'
        + '\n  rg -i -l -n -c -t/--type -g/--glob --files   (PATTERN [paths...])'
        + '\n  head/tail -n   wc -l -w -c   sort -r -n -u -f   uniq -c -d -u   cut -d -f -c   tr [-d], ranges'
        + '\n  find [dir] -name -type -maxdepth       sed s/// on stdin or a file (no -i; use the edit tool)'
        + '\n  awk -F with {print $N}      ls -R -a -l'
        + '\nNo subshells, loops, functions, heredocs, background jobs or command substitution.'
        + '\nPython is a real kernel (`python file.py`); it is the scripting layer, not bash.', code: 0 };
    },
  };

  // ── argv handling for the text builtins ──────────────────────────────────────────────
  //
  // These were stdin-only and SILENTLY IGNORED file arguments, returning "" with exit 0 — so the
  // agent read `head -2 notes.txt` as "the file is empty" and carried that premise forward
  // (forward-pass R2a). And any flag they did not implement was ignored rather than refused, which
  // is the same failure in a different costume (R2d). Both are fixed here, once, for all of them.
  //
  // A missing command exits 127 and the agent adapts. A wrong exit 0 is believed. So an
  // unsupported flag is now an ERROR naming the flag, never a silent difference in meaning.

  // Split argv into flags and positionals, knowing which flags consume the next token.
  function splitArgs(argv, { valueFlags = [] } = {}) {
    const flags = [], positionals = [], seen = [];
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--') { positionals.push(...argv.slice(i + 1)); break; }
      if (a.startsWith('-') && a !== '-') {
        flags.push(a); seen.push(a);
        if (valueFlags.includes(a) && i + 1 < argv.length) { i++; }
        continue;
      }
      positionals.push(a);
    }
    return { flags, positionals, seen };
  }

  // Refuse a flag the builtin does not actually implement. `supported` are single letters (short
  // flags may be bundled, e.g. -in) plus any long forms.
  function unsupportedFlag(name, flags, supported) {
    const longs = new Set(supported.filter((f) => f.startsWith('--')));
    const shorts = new Set(supported.filter((f) => !f.startsWith('--')));
    for (const f of flags) {
      if (f.startsWith('--')) { if (!longs.has(f)) return f; continue; }
      if (/^-\d+$/.test(f)) continue;                    // -5, the numeric line count
      for (const ch of f.slice(1)) if (!shorts.has(ch)) return `-${ch}`;
    }
    return null;
  }
  const flagErr = (name, f) => ({ text: `${name}: unsupported flag ${f} — this shell implements a subset; run \`help\` for what each builtin supports`, code: 2 });

  // Text in: the named files if any, otherwise stdin. Reading is what makes a file argument mean
  // something instead of being dropped on the floor.
  async function textInput(name, positionals, stdin) {
    if (!positionals.length) return { text: stdin || '', code: 0 };
    const parts = [];
    for (const f of positionals) {
      const res = await face.invoke('fs.read', { path: normalizePath(state.cwd, f), encoding: 'utf-8' });
      if (!res.ok) return { text: `${name}: ${f}: ${res.code || 'ENOENT'}`, code: 1, failed: true };
      parts.push(decodeData(res.data));
    }
    return { text: parts.join(''), code: 0 };
  }

  // Returns a number, or { bad } when -n was given a non-numeric value — which used to fall back
  // to the default and quietly return a different amount of text than was asked for.
  function flagNum(argv, dflt) {
    const i = argv.findIndex((a) => a === '-n');
    if (i >= 0) {
      const v = argv[i + 1]; const n = Number(v);
      if (v === undefined || !Number.isFinite(n)) return { bad: v === undefined ? '-n' : v };
      return n;
    }
    const m = argv.find((a) => /^-\d+$/.test(a));
    return m ? Number(m.slice(1)) : dflt;
  }

  // Evaluate a test/[ ] expression → exit code only (0 true, 1 false, 2 error).
  // Unary file tests hit fs.stat; string/int comparisons are pure.
  async function evalTest(argv) {
    const yes = { text: '', code: 0 };
    const no = { text: '', code: 1 };
    if (argv.length === 0) return no;
    if (argv.length === 1) return argv[0] !== '' ? yes : no;
    if (argv.length === 2) {
      const [op, val] = argv;
      if (op === '-z') return val === '' ? yes : no;
      if (op === '-n') return val !== '' ? yes : no;
      if (op === '-f' || op === '-d' || op === '-e' || op === '-s') {
        const res = await face.invoke('fs.stat', { path: normalizePath(state.cwd, val) });
        const st = res.ok ? res.stat : null;
        if (!st) return no;
        if (op === '-e') return yes;
        if (op === '-s') return (st.size || 0) > 0 ? yes : no;
        if (op === '-f') return st.type === 'file' ? yes : no;
        if (op === '-d') return st.type === 'dir' ? yes : no;
      }
      return { text: `test: unknown unary operator ${op}`, code: 2 };
    }
    if (argv.length === 3) {
      const [l, op, r] = argv;
      const nl = Number(l); const nr = Number(r);
      switch (op) {
        case '=': case '==': return l === r ? yes : no;
        case '!=': return l !== r ? yes : no;
        case '-eq': return nl === nr ? yes : no;
        case '-ne': return nl !== nr ? yes : no;
        case '-lt': return nl < nr ? yes : no;
        case '-le': return nl <= nr ? yes : no;
        case '-gt': return nl > nr ? yes : no;
        case '-ge': return nl >= nr ? yes : no;
        default: return { text: `test: unknown operator ${op}`, code: 2 };
      }
    }
    return { text: 'test: too many arguments', code: 2 };
  }

  const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

  // Bash-style filename globbing: a token with * or ? expands to matching paths
  // (cwd-relative; the glob command returns root-relative, so strip the cwd
  // prefix). No match → the literal token is kept (nullglob off). Flags (-x) and
  // env-looking tokens are left alone.
  const stripArgMarks = (t) => String(t).replace(/\u0001/g, '');
  async function expandGlobs(tokens) {
    const out = [];
    const prefix = state.cwd ? state.cwd + '/' : '';
    for (const t of tokens) {
      // a glob character carrying LITERAL_MARK was quoted, so it is a pattern for the COMMAND
      // (find -name '*.txt'), not a filename for the shell to expand
      const unmarkedGlob = /(^|[^\u0001])[*?]/.test(t);
      if (unmarkedGlob && !t.startsWith('-')) {
        const res = await face.invoke('fs.glob', { pattern: t, cwd: state.cwd });
        if (res.ok && res.matches.length) {
          out.push(...res.matches.map((m) => (m.startsWith(prefix) ? m.slice(prefix.length) : m)).sort());
          continue;
        }
      }
      out.push(t);
    }
    return out;
  }

  async function runStage(rawArgv, stdin) {
    // Leading NAME=value tokens set shell variables; if nothing follows, the
    // stage is a pure assignment.
    let argv = rawArgv;
    let ai = 0;
    while (ai < argv.length && ASSIGN.test(argv[ai])) {
      const eq = argv[ai].indexOf('=');
      // strip here too: a stored value keeps its markers otherwise, and `env` prints them
      state.vars.set(argv[ai].slice(0, eq), stripArgMarks(expand(argv[ai].slice(eq + 1))));
      ai++;
    }
    if (ai > 0) argv = argv.slice(ai);
    if (argv.length === 0) return { text: '', code: 0 };
    // Expand $VARs, then globs (`*.txt`) in the argument tokens.
    argv = argv.map(expand);
    argv = [argv[0], ...(await expandGlobs(argv.slice(1)))];
    argv = argv.map(stripArgMarks); // markers are internal; no command ever sees one
    const verb = argv[0];
    const args = argv.slice(1);
    if (builtins[verb]) return builtins[verb](args, stdin);
    if (verb === 'python' || verb === 'py' || verb === 'python3') {
      if (!kiln) return { text: 'python: the Kiln kernel is not available (needs cross-origin isolation — open Forge as a tab)', code: 1 };
      // Resolve the code to run: `-c "<code>"`, a `<file.py>`, or bare text.
      let code;
      const ci = args.indexOf('-c');
      if (ci >= 0 && args[ci + 1] != null) code = args[ci + 1];
      else if (args[0] && !args[0].startsWith('-')) {
        const rd = await face.invoke('fs.read', { path: normalizePath(state.cwd, args[0]), encoding: 'utf-8' });
        if (!rd.ok) return { text: `python: can't open file '${args[0]}': ${rd.code || 'error'}`, code: 2 };
        code = decodeData(rd.data);
      } else code = args.join(' ');
      const r = await kiln.exec('shell', code);
      if (r.status === 'unavailable') return { text: 'python: ' + (r.message || 'kernel unavailable'), code: 1 };
      return { text: (r.stdout || '') + (r.stderr || ''), code: r.status === 'ok' ? 0 : 1 };
    }
    if (verb === 'find') {
      // -name / -type / -maxdepth were SILENTLY IGNORED, so `find . -name "*.txt"` returned every
      // file in the tree and the agent believed that was the answer (forward-pass R2e).
      let base = null, name = null, type = null, maxdepth = null, bad = null;
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '-name') { name = args[++i]; continue; }
        if (a === '-type') {
          type = args[++i];
          if (type !== 'f' && type !== 'd') return { text: `find: -type ${type ?? ''}: expected f or d`, code: 2 };
          continue;
        }
        if (a === '-maxdepth') {
          const v = args[++i]; maxdepth = Number(v);
          if (!Number.isInteger(maxdepth) || maxdepth < 0) return { text: `find: -maxdepth ${v ?? ''}: expected a non-negative integer`, code: 2 };
          continue;
        }
        if (a.startsWith('-')) { bad = a; break; }
        if (base == null) base = a;
      }
      if (bad) return { text: `find: ${bad} is not implemented — this shell supports -name, -type and -maxdepth`, code: 2 };
      const root = base ? normalizePath(state.cwd, base) : state.cwd;
      const res = await face.invoke('fs.glob', { pattern: (root ? root + '/' : '') + '**', cwd: '' });
      if (!res.ok) return { text: `find: ${res.message}`, code: 1 };
      // a glob, anchored to the basename, exactly as find's -name means it
      const rx = name ? new RegExp('^' + String(name).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
      const depthOf = (m) => m.slice(root ? root.length + 1 : 0).split('/').length;
      // fs.glob yields FILES only, so `-type d` over it alone could never match anything — it
      // would have returned an empty success, which is the very failure this batch removes.
      // Directories are the distinct path prefixes of the files found.
      let candidates = res.matches;
      if (type === 'd') {
        const dirs = new Set();
        for (const m of res.matches) {
          const parts = m.split('/');
          for (let k = (root ? root.split('/').length : 0) + 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join('/'));
        }
        candidates = [...dirs].sort();
      }
      const out = [];
      for (const m of candidates) {
        if (rx && !rx.test(m.split('/').pop())) continue;
        if (maxdepth != null && depthOf(m) > maxdepth) continue;
        if (type) {
          const st = await face.invoke('fs.stat', { path: m });
          const isDir = st.ok && st.stat && st.stat.type === 'dir';
          if (type === 'f' && isDir) continue;
          if (type === 'd' && !isDir) continue;
        }
        out.push(m);
      }
      return { text: out.join('\n'), code: 0 };
    }
    if (verb === 'git') return runGit(args);
    const cmdName = REGISTRY_ALIAS[verb] || (registry.describeCommand(verb) ? verb : null);
    if (cmdName) return runRegistry(cmdName, args, stdin);
    return { text: `${verb}: command not found`, code: 127 };
  }

  // git <sub> [args]: map porcelain to the Rig git.* registry commands. Paths
  // resolve against cwd (git core dir is the root). Commits go through the face
  // as agent@rig.local and stage like any destructive op.
  async function runGit(args) {
    const sub = args[0];
    const rest = args.slice(1);
    const positional = rest.filter((a) => !a.startsWith('-'));
    const flags = rest.filter((a) => a.startsWith('-'));
    const rel = (p) => normalizePath(state.cwd, p);
    if (!sub) return { text: 'usage: git <init|add|rm|commit|status|log|diff|branch|checkout|clone|fetch|push>', code: 1 };

    let name; let input = {};
    switch (sub) {
      case 'init': input = {}; name = 'git.init'; break;
      case 'add': {
        // Multi-path fan-out: `git add *.txt` expands to several positionals;
        // stage each (git.add is non-destructive — no confirm) so all matches
        // are added, not just the first.
        if (positional.length > 1) {
          const errors = [];
          for (const f of positional) {
            const r = await face.invoke('git.add', { filepath: rel(f) });
            if (!r.ok) errors.push(`git add: ${f}: ${r.message || 'failed'}`);
          }
          return errors.length
            ? { text: errors.join('\n'), code: 1 }
            : { text: renderGit('add', { ok: true }), code: 0 };
        }
        name = 'git.add'; input = { filepath: rel(positional[0] || '') }; break;
      }
      case 'rm': name = 'git.remove'; input = { filepath: rel(positional[0] || '') }; break;
      case 'commit': {
        const mi = rest.findIndex((a) => a === '-m' || a === '--message');
        const message = mi >= 0 ? rest[mi + 1] : positional[0];
        if (!message) return { text: 'git commit: need -m "<message>"', code: 1 };
        name = 'git.commit'; input = { message, actor: 'agent' };
        break;
      }
      case 'status':
        if (positional[0]) { name = 'git.status'; input = { filepath: rel(positional[0]) }; }
        else { name = 'git.statusMatrix'; input = {}; }
        break;
      case 'log': name = 'git.log'; input = flagNum(rest, 0) ? { depth: flagNum(rest, 0) } : {}; break;
      case 'diff': name = 'git.diff'; input = positional[0] ? { ref: positional[0] } : {}; break;
      case 'branch': name = 'git.branch'; input = positional[0] ? { name: positional[0] } : {}; break;
      case 'checkout': name = 'git.checkout'; input = { ref: positional[0] || '' }; break;
      // These three existed in the registry, were tested, and were simply unreachable from the
      // shell — runGit had no case for them (forward-pass R3b). Network rides the sovereign
      // egress, so an unconfigured backend fails loudly rather than silently doing nothing.
      case 'clone': {
        if (!positional[0]) return { text: 'usage: git clone <url> [ref]', code: 2 };
        name = 'git.clone'; input = { url: positional[0], ...(positional[1] ? { ref: positional[1] } : {}) }; break;
      }
      case 'fetch': {
        if (!positional[0]) return { text: 'usage: git fetch <url> [ref]', code: 2 };
        name = 'git.fetch'; input = { url: positional[0], ...(positional[1] ? { ref: positional[1] } : {}) }; break;
      }
      case 'push': {
        if (positional.length < 2) return { text: 'usage: git push <url> <ref> [remoteRef]', code: 2 };
        name = 'git.push';
        input = { url: positional[0], ref: positional[1],
                  ...(positional[2] ? { remoteRef: positional[2] } : {}),
                  ...(flags.includes('-f') || flags.includes('--force') ? { force: true } : {}) };
        break;
      }
      default: return { text: `git: '${sub}' is not a rig git command`, code: 1 };
    }
    if (!registry.describeCommand(name)) return { text: `git: '${sub}' is unavailable (no git core wired)`, code: 1 };
    const res = await face.invoke(name, input);
    if (res.staged) return { staged: res.proposalId, verb: `git ${sub}` };
    if (!res.ok) return { text: `git ${sub}: ${res.code || 'error'}: ${res.message || 'failed'}`, code: 1 };
    return { text: renderGit(sub, res), code: 0 };
  }

  async function runPipeline(pipeline, stdinFrom = null) {
    let stdin = '';
    if (stdinFrom && pipeline.length > 1) {
      // bash attaches `<` to the command it is written beside; this shell records it per
      // STATEMENT and cannot say which stage owns it. A guess is the failure this batch removes.
      return { text: '<: input redirection combined with a pipe is ambiguous here — feed the file explicitly (`cat FILE | ...`)', code: 2 };
    }
    if (stdinFrom) {
      // `< $F` never expanded the variable and reported the literal name as missing
      const res = await face.invoke('fs.read', { path: normalizePath(state.cwd, expand(stdinFrom)), encoding: 'utf-8' });
      if (!res.ok) return { text: `${stdinFrom}: ${res.code || 'ENOENT'}`, code: 1 };
      stdin = decodeData(res.data);
    }
    let last = { text: '', code: 0 };
    for (const argv of pipeline) {
      last = await runStage(argv, stdin);
      if (last.staged) return last; // destructive: surface for confirm
      if (last.clear) return last;
      stdin = last.text;
    }
    return last;
  }

  async function feed(line) {
    const out = [];
    const write = (s) => { if (s != null && s !== '') out.push(String(s)); };

    // Resolve a pending destructive confirm first.
    if (pending) {
      const ans = String(line == null ? '' : line).trim().toLowerCase();
      const p = pending; pending = null;
      // One or many staged proposals (a glob like `rm *.txt` batches several
      // under a single confirm). Accept/reject them all as a unit.
      const proposals = p.proposals || [{ proposalId: p.proposalId, verb: p.verb }];
      if (ans === 'y' || ans === 'yes') {
        const errs = [];
        for (const pr of proposals) {
          const r = await face.accept(pr.proposalId);
          if (!r.ok) errs.push(`${pr.verb}: ${r.message || 'failed'}`);
        }
        write(errs.join('\n'));
      } else {
        for (const pr of proposals) face.reject(pr.proposalId);
        write(`cancelled: ${p.verb}`);
      }
      return { output: out.join('\n') };
    }

    const raw = String(line == null ? '' : line);
    if (raw.trim() !== '') state.history.push(raw.trim());
    let cleared = false;

    for (const stmt of parseLine(raw)) {
      if (stmt.op === '&&' && lastCode !== 0) continue; // short-circuit on failure
      if (stmt.op === '||' && lastCode === 0) continue; // short-circuit on success
      const res = await runPipeline(stmt.pipeline, stmt.stdinFrom);
      lastCode = res.code || 0;
      if (res.clear) { cleared = true; continue; }
      if (res.staged) {
        pending = { proposalId: res.staged, verb: res.verb, proposals: res.proposals };
        write(`${res.verb} is destructive. confirm? [y/N]`);
        return { output: out.join('\n'), awaitingConfirm: res.staged };
      }
      if (stmt.redirect) {
        const path = normalizePath(state.cwd, expand(stmt.redirect.path));
        // printf writes its bytes verbatim; everything else gets a line-clean
        // trailing newline (echo semantics).
        const chunk = res.raw ? res.text : withTrailingNewline(res.text);
        let data = chunk;
        if (stmt.redirect.append) {
          const cur = await face.invoke('fs.read', { path, encoding: 'utf-8' });
          data = (cur.ok ? decodeData(cur.data) : '') + chunk;
        }
        const w = await face.invoke('fs.write', { path, data, createParents: true });
        // a redirect that wrote NOTHING used to leave the pipeline's exit 0, so `cmd > bad && next`
        // ran `next` as though the write had succeeded
        if (!w.ok) { write(`${path}: ${w.message || 'write failed'}`); lastCode = 1; }
      } else {
        // Terminal display: drop the single trailing newline (the screen adds
        // its own line break); inner newlines are preserved.
        write(res.text.endsWith('\n') ? res.text.slice(0, -1) : res.text);
      }
    }
    return { output: out.join('\n'), cleared };
  }

  return {
    feed,
    get cwd() { return state.cwd; },
    get lastCode() { return lastCode; },
    get awaitingConfirm() { return pending ? pending.proposalId : null; },
  };
}
