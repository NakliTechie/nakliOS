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
// knows. `help` lists the dispatch table; unsupported commands exit 127.

import { createJsRunner } from '../../kiln/js-runner.mjs';
import { parseShell, languageLimits as resolveLanguageLimits } from './language-parser.mjs';
import { createLanguage } from './language-runtime.mjs';
import { commandStreams, lineData, streamResult } from './command-streams.mjs';
import { parseArgs } from './args.mjs';
import { createIO, normalizePath, concatData, autoData, toText, toBytes, renderData } from './io.mjs';
import { createExecution, ShellInterrupted } from './execution.mjs';
import { createBuiltins } from './cmds/builtins.mjs';
import { createCoreCommands } from './cmds/core.mjs';
import { createFileCommands } from './cmds/files.mjs';
import { createTextCommands } from './cmds/text.mjs';
import { createSearchCommands } from './cmds/search.mjs';
import { createUtilityCommands } from './cmds/utility.mjs';
import { createListCommands } from './cmds/list.mjs';
import { createSedCommands } from './cmds/sed.mjs';
import { createAwkCommands } from './cmds/awk.mjs';
import { createFindCommands } from './cmds/find.mjs';
import { createRecordCommands } from './cmds/records.mjs';
import { createLayoutCommands } from './cmds/layout.mjs';
import { createNumericCommands } from './cmds/numeric.mjs';
import { createBcCommands } from './cmds/bc.mjs';
import { createGeneratorCommands } from './cmds/generators.mjs';
import { createPathCommands } from './cmds/paths.mjs';
import { createMutationCommands } from './cmds/mutation.mjs';
import { createInspectionCommands } from './cmds/inspection.mjs';
import { createEncodingCommands } from './cmds/encodings.mjs';
import { createChecksumCommands } from './cmds/checksums.mjs';
import { createRuntimeCommands } from './cmds/runtime.mjs';
import { isByteStream, ownByteStream, closeByteStream, collectByteStream, createStreamingHead } from './cmds/streams.mjs';
import { createPatch } from '../fileops/patch.mjs';

// bash verb -> registry command name. The dotted name (fs.list) always works too.
// ls, stat, mkdir, mv and cp are commands of their own (cmds/), which take every operand.
const REGISTRY_ALIAS = { rm: 'fs.remove', glob: 'fs.glob', patch: 'fs.patch' };

// Short flags -> registry input keys (per command, resolved in buildRegistryInput).
const LIST_FLAGS = { R: 'recursive', a: 'all' };
const RM_FLAGS = { r: 'recursive', R: 'recursive', f: 'force' };
export const SLEEP_MAX_S = 300; // the longest `sleep` — above any run's wall budget it is a hang, not a wait
// B6 (osaurus, 2026-09-17): a listing shown to the model is capped by ENTRIES, at the terminal only — a
// piped listing (`find … | xargs`, `| wc -l`) is never cut, its consumer bounds it. Past the cap the
// text ends in a trailer that says how many there were and how to narrow.
export const LISTING_MAX_ENTRIES = 500;
export function truncateListing(text, entries, max = LISTING_MAX_ENTRIES) {
  if (!(entries > max)) return { text, shown: entries, truncated: false };
  const out = []; let shown = 0;
  for (const line of String(text).split('\n')) {
    const isEntry = line !== '' && !/:$/.test(line);
    if (isEntry && shown >= max) break;
    out.push(line); if (isEntry) shown++;
  }
  while (out.length && (out[out.length - 1] === '' || /:$/.test(out[out.length - 1]))) out.pop(); // no dangling header or blank before the trailer
  out.push(`[listing truncated: ${shown} of ${entries} entries shown — narrow the path, add -name / -maxdepth, or pipe through grep]`);
  return { text: out.join('\n'), shown, truncated: true };
}

// SH3 (2026-09-24): heredocs as stdin. `python - <<'PY' … PY` — the form a model reaches for to run a
// short script — failed with a misleading `<: ENOENT`: the lines of a multi-line call reached the
// tokenizer as one line, newlines as spaces. The body is lifted out BEFORE parsing and replaced by a
// marker token the parser attaches to its statement, where it is that statement's stdin (the same
// path `< file` takes). `<<'TAG'` / `<<"TAG"` are literal; `<<TAG` is literal when the body has no `$`
// — this shell does not expand inside a heredoc, so a body that would expand is refused, not run
// with a different meaning; `<<-` strips leading tabs, as bash does. A missing terminator is an error.
// Escaped whitespace belongs to the current word, so a following # is data.
function tokenBoundaryAt(source, at) {
  if (at === 0) return true;
  if (!/\s/.test(source[at - 1])) return false;
  let slashes = 0;
  for (let i = at - 2; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 0;
}

export const HEREDOC_MARK = '\u0002';
export function extractHeredocs(raw) {
  const lines = String(raw == null ? '' : raw).split('\n');
  const bodies = [];
  const kept = [];
  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    const found = [];
    let quote = null, out = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\' && quote !== "'" && i + 1 < line.length) { out += c + line[++i]; continue; }
      if (quote) { out += c; if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; out += c; continue; }
      if (c === '#' && tokenBoundaryAt(line, i)) { out += line.slice(i); break; }
      if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line.slice(i));
        if (!m) return { error: 'heredoc: `<<` needs a terminator word — e.g. <<\'EOF\'' };
        const tag = m[2] ?? m[3] ?? m[4];
        found.push({ tag, strip: m[1] === '-', quoted: m[4] == null });
        out += ` ${HEREDOC_MARK}HD${bodies.length + found.length - 1}${HEREDOC_MARK} `;
        i += m[0].length - 1;
        continue;
      }
      out += c;
    }
    kept.push(out);
    for (const h of found) {
      const body = [];
      let closed = false;
      for (li++; li < lines.length; li++) {
        const l = h.strip ? lines[li].replace(/^\t+/, '') : lines[li];
        if (l === h.tag) { closed = true; break; }
        body.push(l);
      }
      if (!closed) return { error: `heredoc: no line \`${h.tag}\` ends the here-document` };
      const text = body.join('\n') + (body.length ? '\n' : '');
      if (!h.quoted && /\$/.test(text)) return { error: `heredoc: this shell does not expand inside a here-document — quote the tag (<<'${h.tag}') for a literal body` };
      bodies.push(text);
    }
  }
  return { line: kept.join('\n'), bodies };
}

// Historical SH4 scanner retained for callers that only detect substitution syntax.
// Execution and permission analysis now use language-parser.mjs. Previously substitution was refused. `$(…)` and backticks used to
// reach the command as literal text — `echo $(ls)` printed "$(ls)" with exit 0 — so an agent could
// believe a command ran that never did. Executing them instead would put a command the permission
// rules cannot see inside another (`echo $(rm -rf src)` reads as `echo`), so this shell refuses them
// and says what to do. Single quotes keep them literal, as in bash; heredoc bodies are data.
export function findSubstitution(line) {
  let q = null;
  const s = String(line == null ? '' : line);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (q === '"' && c === '"') { q = null; continue; }
    if (!q && (c === "'" || c === '"')) { q = c; continue; }
    if (!q && c === '#' && tokenBoundaryAt(s, i)) return null; // a comment
    if (c === '`') return '`…`';
    if (c === '$' && s[i + 1] === '(') return s[i + 2] === '(' ? '$((…))' : '$(…)';
  }
  return null;
}

// eslint-disable-next-line no-control-regex
const BINARY_BYTES = new RegExp("[\\u0000-\\u0008\\u000e-\\u001f]");

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
function renderResult(name, res, { long, recursive = false, root = '' } = {}) {
  if (res.entries) {
    const line = (e) => (long ? `${e.type === 'dir' ? 'd' : '-'} ${e.name}` : e.name);
    if (!recursive) return res.entries.map(line).join(long ? '\n' : '  ');
    // B6: `ls -R` used to flatten every name into one line — `README.md docs guide.md src app.js` —
    // so the model could not tell which directory a name was in. Directory blocks, one entry per
    // line (what coreutils prints to a pipe): the shape every model already knows.
    const blocks = new Map(); // dir -> [lines]
    const dirOf = (e) => { const i = e.path.lastIndexOf('/'); return i < 0 ? '' : e.path.slice(0, i); };
    for (const e of res.entries) { const d = dirOf(e); if (!blocks.has(d)) blocks.set(d, []); blocks.get(d).push(line(e)); }
    const label = (d) => (d === root || d === '' ? (root || '.') : d) + ':';
    const order = [...blocks.keys()].sort((a, b) => (a === root ? -1 : b === root ? 1 : a < b ? -1 : a > b ? 1 : 0));
    return order.map((d) => [label(d), ...blocks.get(d)].join('\n')).join('\n\n');
  }
  if (res.matches) return res.matches.map((m) => (typeof m === 'object' ? `${m.path}:${m.line}: ${m.text}` : m)).join('\n');
  if (typeof res.data === 'string' || (res.data && res.data.byteLength != null)) return autoData(res.data);
  if (res.stat) return `${res.stat.type} ${res.stat.size}`;
  if (res.commits) return res.commits.map((c) => `${c.oid.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n');
  if (res.branches) return res.branches.join('\n');
  if (res.changes) return res.changes.map((c) => `${c.status[0].toUpperCase()} ${c.path}`).join('\n') || '(clean)';
  if (res.oid) return res.oid;
  return '';
}

// Render isomorphic-git statusMatrix rows [filepath, head, workdir, stage] as `git status -s`:
// `XY path`, X the index against HEAD, Y the working tree against the index, untracked `??` rows
// last. It used to print `A ` for a staged file edited again, where git prints `AM`, and to drop
// the `??` row of a file removed with `git rm --cached`.
function porcelain(rows) {
  const changed = [], untracked = [];
  for (const [f, head, work, stage] of rows) {
    if (stage === 0 && work !== 0) untracked.push(`?? ${f}`); // on disk, not in the index
    if (head === 0 && stage === 0) continue;
    const x = head === 0 ? 'A' : stage === 0 ? 'D' : stage !== 1 ? 'M' : ' ';
    const y = stage === 0 ? ' ' : work === 0 ? 'D' : stage !== work ? 'M' : ' ';
    if (x !== ' ' || y !== ' ') changed.push(`${x}${y} ${f}`);
  }
  return [...changed, ...untracked].join('\n');
}

// A git subcommand's failure, rendered as its one line of output with exit 1.
class GitFailed extends Error {}

// `kilnIsolate` marks this shell as the VERIFIER's: its `python` runs on an interpreter
// reset first, so a gate cannot measure state the agent left behind (main-thread-runtime.mjs).
// `signal` (optional): the run's AbortSignal, or a function returning the current one (a shell that
// outlives its runs). The shell has no way to stop a builtin mid-flight in general — a half-run
// `python` must not report "stopped" while its effects land — but a wait has no effects: `sleep`
// races its timer against the signal and returns `sleep: interrupted` (exit 130).
export function createShell({ registry, face, cwd = '', kiln = null, kilnIsolate = false, signal = null, js = null, languageLimits: limitOverrides = {}, beforeCommand = null } = {}) {
  if (!registry || !face) throw new Error('createShell requires { registry, face }');
  if (beforeCommand !== null && typeof beforeCommand !== 'function') throw new TypeError('beforeCommand must be a function');
  // G9: `node` — a workspace ES module as a gate (sys/kiln/js-runner.mjs). The host supplies how to make
  // module URLs and spawn a worker; the runner reads through THIS shell's face, so the grant fences it.
  const jsRunner = js ? createJsRunner({ ...js, read: async (p) => { const r = await face.invoke('fs.read', { path: p, encoding: 'utf-8' }); return r.ok ? decodeData(r.data) : null; } }) : null;
  const limits = resolveLanguageLimits(limitOverrides);
  const state = { cwd, history: [], vars: new Map([['HOME', '/']]), functions: new Map(), positionals: [] };

  const rawFace = face;
  let execution = null, running = null, language = null, feeding = false;
  const currentSignal = () => typeof signal === 'function' ? signal() : signal;
  // Existing and new commands share this suspension point, including nested calls.
  face = { invoke: (name, input) => execution.invoke(name, input) };
  const io = createIO({ invoke: face.invoke, cwd: () => state.cwd,
    run: (argv, stdin) => language.invoke(argv, stdin) });
  let lastCode = 0;
  let lastListing = null; // B6: the listing the last feed() displayed — { tool, entries, shown, truncated } — or null

  // Registry schemas supply long flags; shell aliases supply their short forms.
  function registryArgs(cmdName, argv) {
    const props = registry.describeCommand(cmdName).inputSchema?.properties || {};
    const spec = Object.fromEntries(Object.entries(props).map(([key, prop]) =>
      [key, { long: key, value: prop.type !== 'boolean' }]));
    const shorts = cmdName === 'fs.list' ? LIST_FLAGS : cmdName === 'fs.remove' ? RM_FLAGS
      : cmdName === 'fs.mkdir' ? { p: 'createParents' } : {};
    for (const [short, key] of Object.entries(shorts)) {
      spec[key] ??= { long: key };
      spec[key].short = [...(spec[key].short || []), short];
    }
    if (cmdName === 'fs.list') spec.longListing = { short: 'l' };
    if (cmdName === 'fs.remove') {
      spec.verbose = { short: 'v', long: 'verbose' };
      spec.dir = { short: 'd', long: 'dir' };
    }
    return { ...parseArgs(argv, spec, { command: cmdName }), props };
  }

  // The operands a registry command reads, in order: `fs.read a b` used to read `a` and drop `b`.
  const operandKeys = (props) => ('from' in props && 'to' in props ? ['from', 'to']
    : 'path' in props ? ['path'] : 'pattern' in props ? ['pattern', 'cwd'] : []);

  function registryInput(parsed, positional = parsed.operands) {
    const { props, options } = parsed;
    const input = Object.fromEntries(Object.entries(options).filter(([k]) => k in props));
    for (const [key, value] of Object.entries(input)) {
      if (props[key].type === 'number' || props[key].type === 'integer') input[key] = Number(value);
    }
    if ('from' in props && 'to' in props) {
      input.from = io.resolve(positional[0] ?? input.from ?? '');
      input.to = io.resolve(positional[1] ?? input.to ?? '');
    } else if ('path' in props) {
      input.path = io.resolve(positional[0] ?? input.path ?? '');
    } else if ('pattern' in props) {
      input.pattern = positional[0] ?? input.pattern ?? '';
      input.cwd = io.resolve(positional[1] ?? input.cwd ?? '');
    }
    return input;
  }

  async function runRegistry(cmdName, argv, defaults = {}) {
    const parsed = registryArgs(cmdName, argv);
    parsed.options = { ...defaults, ...parsed.options };
    if (cmdName === 'fs.remove') {
      const paths = parsed.operands.length ? parsed.operands : parsed.options.path !== undefined ? [parsed.options.path] : [];
      const proposals = [], errors = [], removed = [];
      const force = !!parsed.options.force;
      if (!paths.length) return force ? { text: '', code: 0 } : { text: 'rm: missing operand', code: 2 };
      const record = (res, path) => {
        if (!res.ok && !(force && (res.code === 'ENOENT' || /no such path/.test(res.message || '')))) {
          errors.push(`rm: ${path}: ${res.code || 'error'}: ${res.message || 'failed'}`);
        }
        if (res.ok && parsed.options.verbose) removed.push(`removed '${path}'`);
      };
      try {
        // Batch the same rm's paths under one prompt, but leave its caller suspended.
        for (const path of paths) {
          execution.check();
          const st = await face.invoke('fs.stat', { path: io.resolve(path),
            ...(parsed.options.follow === undefined ? {} : { follow: parsed.options.follow }) });
          if (!st.ok) { record(st, path); continue; }
          if (st.stat.type === 'dir' && !parsed.options.recursive && !parsed.options.dir) {
            errors.push(`rm: ${path}: EISDIR: is a directory; use -r or -d`); continue;
          }
          if (st.stat.type === 'dir' && !parsed.options.recursive) {
            const children = await face.invoke('fs.list', { path: io.resolve(path) });
            if (!children.ok) { record(children, path); continue; }
            if (children.entries.length) { errors.push(`rm: ${path}: ENOTEMPTY: directory not empty`); continue; }
          }
          const res = await execution.stage(cmdName, registryInput(parsed, [path]));
          if (res.staged) proposals.push({ proposalId: res.proposalId, path });
          else record(res, path);
        }
        if (proposals.length) {
          const results = await execution.confirm(proposals,
            proposals.length > 1 ? `rm (${proposals.length} paths)` : cmdName, { force });
          results.forEach((res, i) => record(res, proposals[i].path));
        }
      } finally {
        for (const proposal of proposals) rawFace.reject(proposal.proposalId);
      }
      return { text: [...errors, ...removed].join('\n'), stdout: lineData(removed.join('\n')), stderr: lineData(errors.join('\n')), code: errors.length ? 1 : 0 };
    }
    const keys = operandKeys(parsed.props);
    if (parsed.operands.length > keys.length) {
      return { text: `${cmdName}: extra operand '${parsed.operands[keys.length]}' — ${cmdName} takes ${keys.length ? keys.join(', ') : 'no operands'}`, code: 2 };
    }
    const res = await face.invoke(cmdName, registryInput(parsed));
    if (!res.ok) return { text: `${cmdName}: ${res.code || 'error'}: ${res.message || 'failed'}`, code: 1 };
    return { text: renderResult(cmdName, res, { long: !!parsed.options.longListing }), code: 0,
      ...(cmdName === 'fs.read' ? { raw: true } : {}) };
  }

  const builtins = createBuiltins({ state, face, registry, normalizePath, decodeData,
    renderResult, runStage: io.run,
    signal: () => currentSignal()?.aborted ? currentSignal() : execution?.signal,
    SLEEP_MAX_S, LIST_FLAGS, commandNames });
  const commandSignal = () => currentSignal()?.aborted ? currentSignal() : execution?.signal;
  const commandEnvironment = () => {
    const vars = new Map(state.vars);
    if (!state.explicitEnv) vars.set('PWD', '/' + state.cwd);
    return vars;
  };
  Object.assign(builtins, createCoreCommands(io), createFileCommands(io), createTextCommands(io),
    createSedCommands(io, { signal: () => currentSignal()?.aborted ? currentSignal() : execution?.signal }),
    createAwkCommands(io, { signal: () => currentSignal()?.aborted ? currentSignal() : execution?.signal,
      environment: () => new Map(state.vars) }),
    createFindCommands(io, { signal: () => currentSignal()?.aborted ? currentSignal() : execution?.signal,
      runAt: async (directory, argv, stdin = '') => {
        const saved = state.cwd, current = execution;
        try { state.cwd = normalizePath('', directory); return await language.invoke(argv, stdin); }
        finally { if (execution === current) state.cwd = saved; }
      } }),
    createSearchCommands(io), createListCommands(io), createUtilityCommands({ io, state, commandNames, owner: () => execution,
      signal: () => currentSignal()?.aborted ? currentSignal() : execution?.signal, maxSleep: SLEEP_MAX_S }));
  Object.assign(builtins,
    createRecordCommands(io, { signal: commandSignal }),
    createLayoutCommands(io, { signal: commandSignal, environment: commandEnvironment }),
    createNumericCommands(io, { signal: commandSignal }),
    createBcCommands(io, { signal: commandSignal }),
    createGeneratorCommands({ signal: commandSignal, environment: commandEnvironment }),
    createPathCommands(io, { signal: commandSignal, environment: commandEnvironment }),
    createMutationCommands(io, { signal: commandSignal, environment: commandEnvironment }),
    createInspectionCommands(io, { signal: commandSignal }),
    createEncodingCommands(io, { signal: commandSignal }),
    createChecksumCommands(io, { signal: commandSignal }),
    createRuntimeCommands(io, { signal: commandSignal, environment: commandEnvironment,
      runWithTimeout: (milliseconds, argv, stdin) => execution.withTimeout(milliseconds, () => io.run(argv, stdin)) }));
  Object.assign(builtins, {
    egrep: (argv, stdin) => io.run(['grep', '-E', ...argv], stdin),
    fgrep: (argv, stdin) => io.run(['grep', '-F', ...argv], stdin),
    more: (argv, stdin) => io.run(['cat', ...argv], stdin),
    dir: (argv, stdin) => io.run(['ls', ...argv], stdin),
    vdir: (argv, stdin) => io.run(['ls', '-l', ...argv], stdin),
  });
  builtins.head = createStreamingHead({ fallback: builtins.head, signal: commandSignal });

  // One dispatch table also owns discovery and help. Dotted registry names remain reachable.
  const dispatch = new Map(Object.entries(builtins));
  for (const name of ['python', 'python3', 'py', 'node', 'git']) {
    dispatch.set(name, (args, stdin) => runSpecial(name, args, stdin));
  }
  for (const [alias, name] of Object.entries(REGISTRY_ALIAS)) {
    if (!dispatch.has(alias)) dispatch.set(alias, (args) => runRegistry(name, args, alias === 'rm' ? { follow: false } : {}));
  }
  for (const { name } of registry.commands) {
    if (!dispatch.has(name)) dispatch.set(name, (args) => runRegistry(name, args));
  }
  function commandNames() { return [...new Set([...dispatch.keys(), ':', 'read', 'set', 'shift', 'local', 'return', 'break', 'continue', ...state.functions.keys()])].sort(); }

  async function runStage(argv, stdin, allowProducer = false) {
    const incomingStream = isByteStream(stdin) ? ownByteStream(stdin) : null;
    try {
      const current = execution;
      current.check();
      if (beforeCommand) { await beforeCommand(Object.freeze([...argv]), { cwd: state.cwd }); current.check(); }
      const verb = argv[0];
      const handler = dispatch.get(verb);
      if (!handler) return { text: `${verb}: command not found`, code: 127 };
      if (incomingStream) stdin = verb === 'head' ? incomingStream
        : await collectByteStream(incomingStream, { signal: commandSignal, command: verb });
      // Text-only commands decode at their boundary, never in the pipeline itself.
      const input = ['cat', 'tee', 'od', 'head', 'tail', 'wc', 'tr', 'cut', 'env', 'sed', 'awk', 'find',
        'tac', 'rev', 'nl', 'paste', 'join', 'comm', 'split', 'fold', 'fmt', 'expand', 'unexpand', 'column',
        'seq', 'shuf', 'tsort', 'expr', 'numfmt', 'printenv', 'yes', 'ptx', 'bc', 'factor',
        'readlink', 'realpath', 'rmdir', 'mktemp', 'truncate', 'unlink', 'du', 'tree', 'file', 'strings', 'cmp', 'ln', 'link',
        'base64', 'base32', 'basenc', 'md5sum', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'b2sum', 'cksum', 'sum',
        'timeout', 'more'].includes(verb) || !builtins[verb] ? stdin : toText(stdin);
      const result = await handler(argv.slice(1), input);
      if (!result.stream) return result;
      const stream = ownByteStream(result.stream);
      if (allowProducer) return { ...result, stream };
      // Nested callers expect complete results. They cannot accidentally treat
      // a producer as empty text or leave it alive outside its invocation.
      const text = await collectByteStream(stream, { signal: commandSignal, command: verb });
      const { stream: ignored, ...rest } = result;
      return { ...rest, text, raw: true };
    } catch (error) {
      if (error instanceof ShellInterrupted || error?.shellFlow) throw error;
      return { text: error.message, code: typeof error.code === 'number' ? error.code : 1,
        ...(error.cancelled ? { cancelled: true } : {}), ...(error.streamFailed ? { streamFailed: true } : {}) };
    } finally { if (incomingStream) await closeByteStream(incomingStream, { suppress: true }); }
  }

  async function runSpecial(verb, args, stdin) {
    // Runtime code can mutate through its own bridge, outside the shell I/O wrapper.
    if (currentSignal()?.aborted && ['python', 'python3', 'py', 'node'].includes(verb)) throw new ShellInterrupted();
    if (execution?.hasDeadline && ['python', 'python3', 'py'].includes(verb)) {
      return { text: `${verb}: scoped timeout is unavailable for this Python runtime`, code: 2 };
    }
    stdin = toText(stdin);
    if (verb === 'python' || verb === 'py' || verb === 'python3') {
      if (!kiln) return { text: 'python: the Kiln kernel is not available (needs cross-origin isolation — open Forge as a tab)', code: 1 };
      // Resolve the code to run: `-c "<code>"`, a `<file.py>`, or bare text.
      let code;
      const ci = args.indexOf('-c');
      // SH1 (2026-09-24): `python -m pkg …`, asked for in live DeepSeek runs, exited 2. It runs the module as
      // CPython does — runpy as __main__, with the cwd first on sys.path and sys.argv = [module, …args]. The
      // name is checked before it is spliced into code, so an argument can never become Python.
      const mi = ci < 0 && args[0] === '-m' ? 0 : -1;
      if (mi === 0) {
        const mod = args[1];
        if (!mod || !/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(mod)) return { text: `python: -m needs a module name${mod ? ` — "${mod}" is not one` : ''}`, code: 2 };
        code = `import os, runpy, sys\nsys.path.insert(0, os.getcwd())\nrunpy.run_module(${JSON.stringify(mod)}, run_name="__main__", alter_sys=True)`;
      }
      // `python --version` used to be RUN AS SOURCE (NameError: name 'version' is not defined) —
      // live 2026-09-11, three times in one run while the agent tried to find out what it had.
      // Answer the two version spellings; refuse every other flag the way the builtins do.
      if (mi === 0) { /* code set above */ }
      else if (ci < 0 && (args[0] === '--version' || args[0] === '-V')) code = 'import sys; print("Python " + sys.version.split()[0])';
      else if (ci < 0 && args[0] === '-') code = stdin || ''; // SH3: `python -` reads the program from stdin (a heredoc, a pipe), as CPython does
      else if (ci < 0 && args[0] && args[0].startsWith('-')) return { text: `python: unsupported option ${args[0]} — use \`python file.py\`, \`python -m module\`, \`python -c "code"\` or \`python --version\``, code: 2 };
      else if (ci >= 0 && args[ci + 1] != null) code = args[ci + 1];
      else if (args[0] && !args[0].startsWith('-')) {
        const rd = await face.invoke('fs.read', { path: normalizePath(state.cwd, args[0]), encoding: 'utf-8' });
        if (!rd.ok) return { text: `python: can't open file '${args[0]}': ${rd.code || 'error'}`, code: 2 };
        code = decodeData(rd.data);
      } else code = args.join(' ');
      // Defect 7 (live 2026-09-11): `cd sub && python x.py` read x.py relative to the shell's cwd
      // but RAN with cwd = the mount root, so a relative open inside the script missed. The kernel
      // now runs where the shell is.
      // sys.argv as CPython sets it: the script and its arguments, or -c and what follows.
      const argv = mi === 0 ? [args[1], ...args.slice(2)] : (ci < 0 && args[0] === '-') ? args : ci >= 0 ? ['-c', ...args.slice(ci + 2)] : (args[0] && !args[0].startsWith('-') ? args : ['']);
      // what a pipe or `<` fed this command is the script's stdin
      const r = await kiln.exec('shell', code, { isolate: kilnIsolate, cwd: state.cwd, argv, stdin: (ci < 0 && args[0] === '-') ? '' : (stdin || '') });
      if (r.status === 'unavailable') return { text: 'python: ' + (r.message || 'kernel unavailable'), code: 1 };
      // A `sys.exit(n)` rides through as n; anything else that is not ok is 1. `output` is the
      // two streams in write order; a runtime without it hands back stdout then stderr.
      const stdout = r.stdout ?? (r.stderr === undefined ? r.output ?? '' : '');
      return { text: stdout, stdout, stderr: r.stderr || '', combined: r.output ?? stdout + (r.stderr || ''), raw: true, code: r.status === 'ok' ? 0 : (Number.isInteger(r.code) && r.code > 0 ? r.code : 1) };
    }
    if (verb === 'node') {
      // G9 (2026-09-24): a JS project's own test file as its gate. Not Node: ES modules, relative imports
      // from the workspace, node:assert / node:test shims, no npm, no fs, no network (js-runner.mjs).
      if (!jsRunner) return { text: 'node: the JS gate runner is not available in this shell', code: 1 };
      const sig = execution.signal;
      if (args[0] === '--version' || args[0] === '-v') return { text: 'v22-compatible gate runner — ES modules, node:assert, node:test; no npm packages, no fs, no network', code: 0 };
      if (args[0] === '-e' || args[0] === '--eval') {
        if (args[1] == null) return { text: 'node: -e needs code', code: 2 };
        const r = await jsRunner.run({ source: args[1], cwd: state.cwd, argv: args.slice(2), stdin: stdin || '', signal: sig });
        return { text: r.stdout ?? '', stdout: r.stdout ?? '', stderr: r.stderr ?? '', combined: r.output, raw: true, code: r.code };
      }
      if (args[0] === '--test') {
        const files = args.slice(1);
        if (!files.length) return { text: 'node: --test needs the test files to run (no discovery here) — e.g. `node --test test/a.test.mjs test/b.test.mjs`', code: 2 };
        let text = '', stdout = '', stderr = '', code = 0;
        for (const f of files) {
          const r = await jsRunner.run({ entry: normalizePath(state.cwd, f), cwd: state.cwd, argv: [], stdin: stdin || '', signal: sig });
          text += `# ${f}\n${r.output}`; stdout += `# ${f}\n${r.stdout ?? ''}`; stderr += r.stderr ?? ''; if (r.code !== 0 && code === 0) code = r.code;
          if (r.code === 130) break; // stopped
        }
        return { text: stdout, stdout, stderr, combined: text, code, raw: true };
      }
      if (!args[0] || args[0].startsWith('-')) return { text: `node: ${args[0] ? `unsupported option ${args[0]}` : 'give a file'} — use \`node file.mjs\`, \`node --test a.test.mjs …\`, \`node -e "code"\` or \`node --version\``, code: 2 };
      const r = await jsRunner.run({ entry: normalizePath(state.cwd, args[0]), cwd: state.cwd, argv: args.slice(1), stdin: stdin || '', signal: sig });
      return { text: r.stdout ?? '', stdout: r.stdout ?? '', stderr: r.stderr ?? '', combined: r.output, raw: true, code: r.code };
    }
    if (verb === 'git') return runGit(args);
  }

  // git <sub> [args]: porcelain over the Rig git.* registry commands. Each subcommand parses its
  // flags, so an unsupported one is refused (exit 2), never dropped. Before 2026-09-29 flags were
  // filtered out unread: `git add -A` reached git.add as an empty path, `git commit -am` committed
  // without -a, `git rm` left the file on disk, `git branch NAME` sent the wrong field, and
  // `git diff` printed "ok" over a modified tree. Paths resolve against cwd (the git core dir is the
  // root). Commits go through the face as agent@rig.local and stage like any destructive op.
  const GIT_USAGE = 'usage: git <init|add|rm|mv|commit|status|log|diff|branch|checkout|clone|fetch|push>';
  const GIT_FLAGS = {
    init: { branch: { short: 'b', long: 'initial-branch', value: true }, quiet: { short: 'q', long: 'quiet' } },
    add: { all: { short: 'A', long: 'all' }, update: { short: 'u', long: 'update' } },
    rm: { cached: { long: 'cached' }, recursive: { short: 'r' }, force: { short: 'f', long: 'force' }, quiet: { short: 'q', long: 'quiet' } },
    mv: {},
    commit: { message: { short: 'm', long: 'message', value: true, multiple: true }, all: { short: 'a', long: 'all' },
      allowEmpty: { long: 'allow-empty' }, quiet: { short: 'q', long: 'quiet' } },
    status: { short: { short: 's', long: 'short' }, porcelain: { long: 'porcelain' } },
    log: { count: { short: 'n', long: 'max-count', value: true }, oneline: { long: 'oneline' } },
    diff: { cached: { long: ['cached', 'staged'] }, nameOnly: { long: 'name-only' }, nameStatus: { long: 'name-status' },
      quiet: { long: 'quiet' }, exitCode: { long: 'exit-code' } },
    branch: { list: { short: 'l', long: 'list' } },
    checkout: { branch: { short: 'b', value: true }, force: { short: 'f', long: 'force' } },
    clone: {}, fetch: {}, push: { force: { short: 'f', long: 'force' } },
  };
  // A pathspec covers a path when it names it or a directory above it; '' is the whole tree.
  const covers = (spec, path) => spec === '' || path === spec || path.startsWith(spec + '/');
  // statusMatrix rows are [path, head, workdir, stage]. A path is in the index when stage != 0,
  // and the index differs from the working tree when stage != workdir (both use 0 for absent,
  // 1 for "same as HEAD", 2 for "same as the working tree").
  const inIndex = ([, , , stage]) => stage !== 0;
  const tracked = ([, head, , stage]) => head === 1 || stage !== 0;
  const staged = ([, head, , stage]) => (head === 1 ? stage !== 1 : stage !== 0);
  const unstaged = ([, , work, stage]) => stage !== work;

  // Stage every destructive op, then ask once for the batch, as `rm` does.
  async function confirmBatch(label, ops) {
    const proposals = [], results = [];
    try {
      for (const op of ops) {
        const res = await execution.stage(op.name, op.input);
        if (res.staged) proposals.push({ proposalId: res.proposalId }); else results.push(res);
      }
      if (proposals.length) results.push(...await execution.confirm(proposals, proposals.length > 1 ? `${label} (${proposals.length} changes)` : ops[0].name));
    } finally {
      for (const proposal of proposals) rawFace.reject(proposal.proposalId);
    }
    return results;
  }

  async function runGit(args) {
    const sub = args[0];
    if (!sub) return { text: GIT_USAGE, code: 1 };
    const spec = GIT_FLAGS[sub];
    if (!spec) return { text: `git: '${sub}' is not a rig git command`, code: 1 };
    let rest = args.slice(1);
    if (sub === 'log') rest = rest.map((a) => (/^-\d+$/.test(a) ? '-n' + a.slice(1) : a)); // git log -5
    // diff, log and checkout give `--` a meaning of their own (paths after it); the rest read it as
    // the usual end of flags.
    const dd = ['diff', 'log', 'checkout'].includes(sub) ? rest.indexOf('--') : -1;
    const { options, operands } = parseArgs(dd < 0 ? rest : rest.slice(0, dd), spec, { command: `git ${sub}` });
    const paths = dd < 0 ? null : rest.slice(dd + 1);
    const rel = (p) => normalizePath(state.cwd, p);
    const ok = { text: 'ok', code: 0 };
    const call = async (name, input) => {
      if (!registry.describeCommand(name)) throw new GitFailed(`git: '${sub}' is unavailable (no git core wired)`);
      let res;
      try { res = await face.invoke(name, input); }
      catch (error) {
        if (error instanceof ShellInterrupted || error.cancelled) throw error;
        throw new GitFailed(`git ${sub}: ${error.code || 'error'}: ${error.message}`);
      }
      if (!res.ok) throw new GitFailed(`git ${sub}: ${res.code || 'error'}: ${res.message || 'failed'}`);
      return res;
    };
    const matrix = async () => (await call('git.statusMatrix', {})).matrix;
    // Bring the index to the working tree for every covered path: add what changed or is new,
    // drop what was deleted (a destructive index change, so it is confirmed). -u skips untracked.
    const stageTree = async (specs, { trackedOnly = false } = {}) => {
      const adds = [], drops = [];
      for (const row of await matrix()) {
        if (!specs.some((s) => covers(s, row[0])) || !unstaged(row)) continue;
        if (trackedOnly && !tracked(row)) continue;
        (row[2] === 0 ? drops : adds).push(row[0]);
      }
      for (const filepath of adds) await call('git.add', { filepath });
      const results = drops.length ? await confirmBatch('git rm --cached', drops.map((filepath) => ({ name: 'git.remove', input: { filepath } }))) : [];
      const bad = results.find((r) => !r.ok);
      if (bad) throw new GitFailed(`git ${sub}: ${bad.code || 'error'}: ${bad.message || 'failed'}`);
    };

    try {
      switch (sub) {
        case 'init': {
          if (operands.length) return { text: `git init: a directory operand ('${operands[0]}') is not supported — the repository is the workspace root`, code: 2 };
          await call('git.init', options.branch ? { defaultBranch: options.branch } : {});
          return ok;
        }
        case 'add': {
          if (!operands.length && !options.all && !options.update) return { text: "Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?", code: 0 };
          // -A / -u with no pathspec cover the whole tree, wherever the shell is
          const specs = operands.length ? operands.map(rel) : [''];
          const rows = await matrix();
          // A pathspec matches a path under it, or an existing directory: git exits 0 for `git add .`
          // in an empty workspace and for a directory that holds no addable file.
          for (let i = 0; i < operands.length; i++) {
            if (rows.some(([f]) => covers(specs[i], f))) continue;
            const st = await face.invoke('fs.stat', { path: specs[i] });
            if (!st.ok || st.stat?.type !== 'dir') return { text: `git add: pathspec '${operands[i]}' did not match any files`, code: 1 };
          }
          await stageTree(specs, { trackedOnly: !!options.update });
          return ok;
        }
        case 'rm': {
          if (!operands.length) return { text: 'usage: git rm [--cached] [-r] [-f] <path>...', code: 2 };
          const rows = (await matrix()).filter(inIndex); // git rm matches the index
          const targets = new Map(); // path -> row; overlapping pathspecs remove a path once
          for (const p of operands) {
            const s = rel(p);
            const under = rows.filter(([f]) => covers(s, f));
            if (!under.length) return { text: `git rm: pathspec '${p}' did not match any files`, code: 1 };
            if (!under.some(([f]) => f === s) && !options.recursive) return { text: `git rm: not removing '${p}' recursively without -r`, code: 1 };
            for (const row of under) targets.set(row[0], row);
          }
          // Check every target before staging any deletion. Plain rm may discard only
          // committed content; --cached may discard an index copy preserved in HEAD or
          // the working tree. A confirmation is not a substitute for explicit --force.
          if (!options.force) {
            const errors = [];
            for (const [filepath, head, work, stage] of targets.values()) {
              const matchesHead = head === 1 && stage === 1;
              const matchesWork = work !== 0 && stage === work;
              // Native git also accepts an already-removed working-tree file.
              if (!options.cached && work === 0) continue;
              if (options.cached ? !matchesHead && !matchesWork : !matchesHead || !matchesWork) {
                const reason = !matchesHead && !matchesWork
                  ? 'staged content differs from both the working tree and HEAD'
                  : !matchesHead ? 'changes are staged in the index' : 'local modifications';
                errors.push(`git rm: '${filepath}': ${reason} (use -f to force removal)`);
              }
            }
            if (errors.length) return { text: errors.join('\n'), code: 1 };
          }
          // Without --cached the file leaves the working tree too, as git does; it used to stay.
          const ops = [...targets.values()].flatMap(([filepath, , work]) => [{ name: 'git.remove', input: { filepath } },
            ...(!options.cached && work !== 0 ? [{ name: 'fs.remove', input: { path: filepath } }] : [])]);
          // The governed face checks grants while staging. Refuse the whole batch if any
          // target is denied, before accepting another target's index or file deletion.
          const proposals = [];
          let results;
          try {
            for (const op of ops) {
              const result = await execution.stage(op.name, op.input);
              if (!result.staged) return { text: `git rm: ${result.code || 'error'}: ${result.message || 'could not stage removal'}`, code: 1 };
              proposals.push({ proposalId: result.proposalId });
            }
            results = await execution.confirm(proposals, proposals.length > 1 ? `git rm (${proposals.length} changes)` : ops[0].name);
          } finally {
            for (const proposal of proposals) rawFace.reject(proposal.proposalId);
          }
          const bad = results.find((r) => !r.ok);
          if (bad) return { text: `git rm: ${bad.code || 'error'}: ${bad.message || 'failed'}`, code: 1 };
          return { text: options.quiet ? '' : [...targets.keys()].map((f) => `rm '${f}'`).join('\n'), code: 0 };
        }
        // `git mv` (battery 2026-09-24: a model reached for `git mv seed.txt seed2.txt`, got "not a rig
        // git command", and renamed with python — a wasted step). It is a rename plus the index
        // update: fs.move, then, when a repository is wired and answers, stage the new path and drop
        // the old one. Without a repository it is the rename alone, and it says so.
        case 'mv': {
          if (operands.length !== 2) return { text: 'usage: git mv <source> <destination>', code: 2 };
          const [from, to] = operands.map(rel);
          const mv = await face.invoke('fs.move', { from, to });
          if (!mv.ok) return { text: `git mv: ${mv.code || 'error'}: ${mv.message || 'failed'}`, code: 1 };
          if (!registry.describeCommand('git.add') || !registry.describeCommand('git.remove')) return { text: `renamed ${operands[0]} -> ${operands[1]} (no git core wired: nothing staged)`, code: 0 };
          const add = await face.invoke('git.add', { filepath: to });
          if (!add.ok) return { text: `renamed ${operands[0]} -> ${operands[1]} (not staged: ${add.message || add.code || 'no repository'})`, code: 0 };
          const rm = await face.invoke('git.remove', { filepath: from });
          // Dropping the old path from the index is destructive, so the face stages it for the same
          // y/N every `git rm` gets; the rename itself has already happened.
          return { text: `renamed ${operands[0]} -> ${operands[1]}` + (rm.ok ? ' (staged)' : ` (new path staged; old path: ${rm.message || rm.code || 'not in the index'})`), code: 0 };
        }
        case 'commit': {
          const messages = options.message || [];
          if (!messages.length) return { text: 'git commit: need -m "<message>"', code: 1 };
          if (operands.length) return { text: `git commit: pathspecs are not supported ('${operands[0]}') — git add them, then commit`, code: 2 };
          if (options.all) await stageTree([''], { trackedOnly: true });
          if (!options.allowEmpty) {
            // An empty commit used to be recorded and reported as a success.
            const rows = await matrix();
            if (!rows.some(staged)) {
              return { text: rows.some((r) => tracked(r) && unstaged(r)) ? 'no changes added to commit (use "git add" and/or "git commit -a")'
                : rows.some((r) => !tracked(r)) ? 'nothing added to commit but untracked files present (use "git add" to track)'
                : 'nothing to commit, working tree clean', code: 1 };
            }
          }
          const res = await call('git.commit', { message: messages.join('\n\n') });
          return { text: options.quiet ? '' : `[${res.oid.slice(0, 7)}]`, code: 0 };
        }
        case 'status': {
          const specs = operands.map(rel);
          const rows = (await matrix()).filter(([f]) => !specs.length || specs.some((s) => covers(s, f)));
          return { text: porcelain(rows) || '(clean)', code: 0 };
        }
        case 'log': {
          if (paths) return { text: 'git log: path-limited history is not supported — drop the `-- <path>`', code: 2 };
          if (operands.length > 1) return { text: `git log: one ref at most — extra operand '${operands[1]}'`, code: 2 };
          const depth = options.count == null ? 0 : Number(options.count);
          if (!Number.isInteger(depth) || depth < 0) return { text: `git log: -n ${options.count}: expected a non-negative integer`, code: 2 };
          const res = await call('git.log', { ...(operands[0] ? { ref: operands[0] } : {}), ...(depth ? { depth } : {}) });
          return { text: res.commits.map((c) => `${c.oid.slice(0, 7)} ${c.commit.message.split('\n')[0]}`).join('\n'), code: 0 };
        }
        case 'diff': {
          if (operands.length > 2) return { text: `git diff: two refs at most — extra operand '${operands[2]}'`, code: 2 };
          if (options.cached && operands.length) return { text: 'git diff --cached <ref> is not supported — the index is compared with HEAD', code: 2 };
          let changes;
          if (!operands.length) {
            // no ref: the working tree against the index; --cached: the index against HEAD
            const rows = await matrix();
            changes = options.cached
              ? rows.filter(staged).map(([f, head, , stage]) => ({ path: f, letter: head === 0 ? 'A' : stage === 0 ? 'D' : 'M' }))
              : rows.filter((r) => inIndex(r) && unstaged(r)).map(([f, , work]) => ({ path: f, letter: work === 0 ? 'D' : 'M' }));
          } else {
            const res = await call('git.diff', { refA: operands[0], ...(operands[1] ? { refB: operands[1] } : {}) });
            // one ref: the working tree against it, which walks untracked files too; git leaves them out
            const untracked = operands[1] ? new Set() : new Set((await matrix()).filter((r) => !tracked(r)).map(([f]) => f));
            changes = res.changes.filter((c) => !untracked.has(c.path)).map((c) => ({ path: c.path, letter: c.status[0].toUpperCase() }));
          }
          const specs = (paths || []).map(rel);
          changes = changes.filter((c) => !specs.length || specs.some((s) => covers(s, c.path))).sort((a, b) => (a.path < b.path ? -1 : 1));
          const code = (options.quiet || options.exitCode) && changes.length ? 1 : 0;
          if (options.quiet) return { text: '', code };
          if (options.nameOnly || options.nameStatus) {
            const text = changes.map((c) => (options.nameOnly ? c.path : `${c.letter}\t${c.path}`)).join('\n');
            return { text, stdout: lineData(text), stderr: '', code };
          }
          // The patch: each side read where git reads it — the index, a commit, or the working tree.
          const [oldSide, newSide] = options.cached ? ['HEAD', null] : !operands.length ? [null, 'work'] : [operands[0], operands[1] || 'work'];
          const read = async (side, filepath) => (side === 'work'
            ? (await call('fs.read', { path: filepath })).data
            : (await call('git.readBlob', { filepath, ...(side ? { ref: side } : {}) })).data);
          const out = [];
          for (const { path, letter } of changes) {
            const before = letter === 'A' ? '' : await read(oldSide, path);
            const after = letter === 'D' ? '' : await read(newSide, path);
            out.push(`diff --git a/${path} b/${path}`);
            if (letter === 'A') out.push('new file mode 100644');
            if (letter === 'D') out.push('deleted file mode 100644');
            const binary = [before, after].some((d) => typeof d !== 'string' && toBytes(d).includes(0));
            if (binary) { out.push(`Binary files ${letter === 'A' ? '/dev/null' : 'a/' + path} and ${letter === 'D' ? '/dev/null' : 'b/' + path} differ`); continue; }
            const patch = createPatch(toText(before), toText(after), { from: letter === 'A' ? '/dev/null' : `a/${path}`, to: letter === 'D' ? '/dev/null' : `b/${path}` });
            if (patch) out.push(patch.replace(/\n$/, ''));
          }
          return { text: out.join('\n'), stdout: lineData(out.join('\n')), stderr: '', code };
        }
        case 'branch': {
          if (!operands.length) {
            // `* ` marks the checked-out branch, as git prints it
            const names = (await call('git.listBranches', {})).branches;
            const current = registry.describeCommand('git.currentBranch') ? (await call('git.currentBranch', {})).branch : undefined;
            const lines = names.map((n) => (n === current ? '* ' : '  ') + n);
            if (current === null) lines.unshift('* (HEAD detached)');
            return { text: lines.join('\n'), code: 0 };
          }
          if (options.list) return { text: 'git branch --list: patterns are not supported — use `git branch` and grep', code: 2 };
          if (operands.length > 1) return { text: `git branch: a start point is not supported ('${operands[1]}') — a new branch starts at HEAD`, code: 2 };
          await call('git.branch', { ref: operands[0] });
          return ok;
        }
        case 'checkout': {
          if (paths) return { text: 'git checkout -- <path>: restoring files is not supported — git checkout switches branches or commits only', code: 2 };
          if (options.branch) {
            if (operands.length) return { text: `git checkout -b: a start point is not supported ('${operands[0]}') — a new branch starts at HEAD`, code: 2 };
            await call('git.branch', { ref: options.branch, checkout: true });
            return ok;
          }
          if (operands.length !== 1) return { text: 'usage: git checkout [-f] <ref> | git checkout -b <new-branch>', code: 2 };
          await call('git.checkout', { ref: operands[0], ...(options.force ? { force: true } : {}) });
          return ok;
        }
        // These three existed in the registry, were tested, and were simply unreachable from the
        // shell — runGit had no case for them (forward-pass R3b). Network rides the sovereign
        // egress, so an unconfigured backend fails loudly rather than silently doing nothing.
        case 'clone': case 'fetch': {
          if (!operands[0]) return { text: `usage: git ${sub} <url> [ref]`, code: 2 };
          if (operands.length > 2) return { text: `git ${sub}: extra operand '${operands[2]}' — usage: git ${sub} <url> [ref]`, code: 2 };
          const res = await call(`git.${sub}`, { url: operands[0], ...(operands[1] ? { ref: operands[1] } : {}) });
          return { text: res.oid ? `[${res.oid.slice(0, 7)}]` : 'ok', code: 0 };
        }
        case 'push': {
          if (operands.length < 2) return { text: 'usage: git push <url> <ref> [remoteRef]', code: 2 };
          if (operands.length > 3) return { text: `git push: extra operand '${operands[3]}' — usage: git push <url> <ref> [remoteRef]`, code: 2 };
          const res = await call('git.push', { url: operands[0], ref: operands[1],
            ...(operands[2] ? { remoteRef: operands[2] } : {}), ...(options.force ? { force: true } : {}) });
          return { text: res.oid ? `[${res.oid.slice(0, 7)}]` : 'ok', code: 0 };
        }
      }
    } catch (error) {
      if (error instanceof GitFailed) return { text: error.message, code: 1 };
      throw error;
    }
  }

  async function feed(line) {
    if (feeding) throw new Error('shell: feed already in progress');
    feeding = true;
    try {
      let prior = { output: '', stdout: '', stderr: '' };
      lastListing = null;
      if (execution?.pending) {
        const current = execution;
        current.answer(/^(y|yes)$/i.test(String(line ?? '').trim()));
        const result = await current.next();
        if (!result.awaitingConfirm && execution === current) { execution = null; running = null; }
        return result;
      }
      // An abort may finish a suspended command between feed calls. Drain it first.
      if (running) {
        await running;
        if (execution) {
          // A scoped deadline can finish a confirmation while no feed is
          // waiting. Drain that completion before opening a fresh invocation.
          const result = await execution.next();
          prior = result;
          execution = null; running = null;
        }
      }
      const raw = String(line ?? '');
      if (raw.trim()) state.history.push(raw.trim());
      let body;
      try { body = parseShell(raw, limits); }
      catch (error) {
        lastCode = typeof error.code === 'number' ? error.code : 2;
        return { output: [prior.output, error.message].filter(Boolean).join('\n'),
          stdout: prior.stdout, stderr: concatData([prior.stderr, lineData(error.message)]), cleared: false };
      }
      const sig = currentSignal();
      // The terminal can still inspect files after Stop, as before U0. A fresh
      // invocation with an already-aborted signal is diagnostic-only; a Stop
      // arriving during an invocation interrupts that invocation entirely.
      const invocationFace = sig?.aborted ? { ...rawFace, check: async () => { throw new ShellInterrupted(); }, invoke: (name, input) => {
        const command = registry.describeCommand(name);
        if (!command?.annotations?.readOnlyHint || command.destructive) throw new ShellInterrupted();
        return rawFace.invoke(name, input);
      } } : rawFace;
      const current = createExecution({ face: invocationFace, signal: sig?.aborted ? null : sig, describeCommand: (name) => registry.describeCommand(name) });
      current.writeStreams(prior.stdout, prior.stderr, prior.output ? prior.output + '\n' : '');
      execution = current;
      const invocationLanguage = createLanguage({ state, io, execution: current, limits,
        runCommand: runStage, isCurrent: () => execution === current, getCode: () => lastCode, setCode: (value) => { lastCode = value; },
        onListing: (text, listing) => {
          const truncated = truncateListing(text, listing.entries);
          lastListing = { tool: listing.tool, entries: listing.entries, shown: truncated.shown, truncated: truncated.truncated };
          return truncated.text + (String(text).endsWith('\n') && !truncated.text.endsWith('\n') ? '\n' : '');
        } });
      language = invocationLanguage;
      running = (async () => {
        let result = {};
        try { result = await invocationLanguage.run(body); }
        catch (error) {
          if (execution === current) lastCode = typeof error.code === 'number' ? error.code : 1;
          current.writeStreams('', lineData(error.message));
        } finally {
          current.finish({ ...result, ...(lastListing ? { listing: lastListing } : {}) });
        }
      })();
      const result = await current.next();
      if (!result.awaitingConfirm && execution === current) { execution = null; running = null; }
      return result;
    } finally { feeding = false; }
  }

  async function cancel() {
    if (!execution) { lastCode = 130; return { output: 'shell: interrupted', stdout: '', stderr: 'shell: interrupted\n' }; }
    const current = execution, task = running;
    current.cancel();
    await task;
    if (execution === current) lastCode = 130;
    // A feed already waiting for completion owns that event; never replace its waiter.
    const result = feeding ? { output: 'shell: interrupted', stdout: '', stderr: 'shell: interrupted\n' } : await current.next();
    if (execution === current) { execution = null; running = null; }
    return result;
  }

  return {
    feed, cancel,
    get lastListing() { return lastListing; },
    get commands() { return commandNames(); },
    get permissionContext() { return { functions: new Map(state.functions) }; },
    get interrupted() { return !!currentSignal()?.aborted; },
    reset() {
      execution?.cancel();
      execution = null; running = null;
      state.cwd = cwd; state.vars = new Map([['HOME', '/']]); state.functions = new Map(); state.positionals = []; language = null; lastCode = 0;
    },
    get cwd() { return state.cwd; },
    get lastCode() { return lastCode; },
    get awaitingConfirm() { return execution?.pending ?? null; },
  };
}
