// Existing curated builtins. U1 extends these subsets command by command.
// All filesystem access uses the shell's confirmation-aware face.
import { ArgError, parseArgs } from '../args.mjs';
import { toBytes } from '../io.mjs';
import { createPatch } from '../../fileops/patch.mjs';

// Split text into lines the way coreutils do: a single trailing newline is a
// line terminator, not an extra empty line.
const linesOf = (t) => {
  const s = String(t == null ? '' : t);
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
};
const shortFlags = (letters) => Object.fromEntries([...letters].map((short) => [short, { short }]));

// printf backslash escapes: \n \t \r \\ \0 \a \b \f \v.
function unescapePrintf(s) {
  const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
  return String(s).replace(/\\(n|t|r|\\|0|a|b|f|v)/g, (_, c) => map[c]);
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

export function createBuiltins({ state, face, registry, normalizePath, decodeData,
  renderResult, runStage, signal, SLEEP_MAX_S, LIST_FLAGS, commandNames }) {
  // ── builtins: shell-native, may consume/produce piped text ──
  const builtins = {
    // `cd` used to move to ANY path and exit 0 — `cd w` twice put the shell in `w/w`, and every command
    // after it failed ENOENT while the model believed the directory had vanished (live prod, 2026-09-17,
    // a child stopped on three missed predictions). It refuses a target that is not a directory, as bash does.
    async cd(argv) {
      if (argv.length > 1) return { text: 'cd: too many arguments', code: 1 };
      const target = argv.length ? normalizePath(state.cwd, argv[0]) : ''; // bare `cd` goes to the workspace root, as bash's goes home
      if (target !== '') {
        const st = await face.invoke('fs.stat', { path: target });
        if (!st.ok || !st.stat) return { text: `cd: ${argv[0]}: No such file or directory`, code: 1 };
        if (st.stat.type !== 'dir') return { text: `cd: ${argv[0]}: Not a directory`, code: 1 };
      }
      state.cwd = target;
      return { text: '', code: 0 };
    },
    pwd() { return { text: '/' + state.cwd, code: 0 }; },
    // `sleep N` — seconds, decimals allowed, capped at SLEEP_MAX_S (a longer wait than any run budget is
    // a hang, and Stop has no way into a builtin). Live 2026-09-17: a child asked to pace itself spent
    // its whole step budget looking for one. It is also the honest stall for a liveness check: no
    // events while it waits, so the parent's row shows the silence (B1 `unverifiable`).
    async sleep(argv) {
      if (!argv.length) return { text: 'sleep: missing operand', code: 1 };
      if (argv.length > 1) return { text: 'sleep: one interval only (seconds)', code: 1 };
      const secs = /^\d+(\.\d+)?$/.test(argv[0]) ? Number(argv[0]) : NaN;
      if (!Number.isFinite(secs)) return { text: `sleep: invalid time interval '${argv[0]}' (seconds)`, code: 1 };
      if (secs > SLEEP_MAX_S) return { text: `sleep: ${argv[0]} exceeds the ${SLEEP_MAX_S} s cap`, code: 1 };
      const sig = typeof signal === 'function' ? signal() : signal;
      if (sig && sig.aborted) return { text: 'sleep: interrupted', code: 130, interrupted: true };
      const interrupted = await new Promise((resolve) => {
        const t = setTimeout(() => { if (sig) sig.removeEventListener('abort', onAbort); resolve(false); }, Math.round(secs * 1000));
        const onAbort = () => { clearTimeout(t); resolve(true); };
        if (sig) sig.addEventListener('abort', onAbort, { once: true });
      });
      return interrupted ? { text: 'sleep: interrupted', code: 130, interrupted: true } : { text: '', code: 0 };
    },
    echo(argv) { return { text: argv.join(' '), code: 0 }; },
    clear() { return { text: '', code: 0, clear: true }; },
    // `history N` shows the last N lines; the count used to be ignored and every line printed.
    history(argv) {
      if (argv.length > 1 || (argv.length && !/^\d+$/.test(argv[0]))) return { text: 'history: takes one optional count — history [N]', code: 2 };
      const from = argv.length ? Math.max(0, state.history.length - Number(argv[0])) : 0;
      return { text: state.history.slice(from).map((h, i) => `${from + i + 1}  ${h}`).join('\n'), code: 0 };
    },
    // One line per name; exit 1 when any is unknown. `which a b` used to answer for `a` alone.
    which(argv) {
      const { operands } = parseArgs(argv, {}, { command: 'which' });
      if (!operands.length) return { text: 'which: missing operand', code: 2 };
      const names = commandNames();
      return { text: operands.map((v) => (names.includes(v) ? v : `${v} not found`)).join('\n'),
        code: operands.every((v) => names.includes(v)) ? 0 : 1 };
    },
    // -v INVERTED (it returned exactly the lines it was asked to exclude), -i was ignored so a
    // match reported none, -c was ignored, -r returned empty exit 1 — all silently (R2b).
    async grep(argv, stdin) {
      let parsed;
      try { parsed = parseArgs(argv, shortFlags('nvicEFhH'), { command: 'grep' }); }
      catch (error) {
        if (error instanceof ArgError && error.message.startsWith('grep: unsupported flag -r;')) {
          return { text: error.text + '; use `rg <pattern>` for a recursive search', code: error.code };
        }
        throw error;
      }
      const { options, operands: positionals } = parsed;
      const has = (ch) => !!options[ch];
      const nline = has('n'), invert = has('v'), icase = has('i'), count = has('c');
      const pattern = positionals[0] || '';
      const files = positionals.slice(1);
      const fixed = has('F');
      let re; try { re = new RegExp(fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, icase ? 'i' : ''); } catch (e) { return { text: `grep: invalid pattern: ${e.message}`, code: 2 }; }
      const filter = (text, prefix) => linesOf(text)
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => re.test(l) !== invert)
        .map(({ l, i }) => `${prefix ? prefix + ':' : ''}${nline ? (i + 1) + ':' : ''}${l}`);
      // -h drops the file prefix, -H forces it; both used to be accepted and ignored
      const prefixed = has('H') || (files.length > 1 && !has('h'));
      const out = []; let matched = false, errored = false;
      const take = (text, name) => {
        const hits = filter(text, prefixed ? name : '');
        if (hits.length) matched = true;
        // -c counts per file, as grep does; several files used to share one total
        out.push(...(count ? [`${prefixed ? name + ':' : ''}${hits.length}`] : hits));
      };
      if (files.length) {
        for (const f of files) {
          const res = await face.invoke('fs.read', { path: normalizePath(state.cwd, f), encoding: 'utf-8' });
          // a missing file used to end the search and drop the matches already found
          if (!res.ok) { out.push(`grep: ${f}: ${res.code || 'ENOENT'}`); errored = true; continue; }
          take(decodeData(res.data), f);
        }
      } else take(stdin || '', '');
      return { text: out.join('\n'), code: errored ? 2 : matched ? 0 : 1 };
    },
    async head(argv, stdin) {
      const { options, operands: positionals } = lineArgs('head', argv);
      const n = flagNum(options.n, 10);
      if (n && typeof n === 'object' && n.bad !== undefined) return { text: `head: invalid line count: ${n.bad}`, code: 2 };
      const take = (text) => linesOf(text).slice(0, n).join('\n');
      if (positionals.length > 1) return eachFile('head', positionals, take);
      const inp = await textInput('head', positionals, stdin); if (inp.failed) return inp;
      return { text: take(inp.text), code: 0 };
    },
    async tail(argv, stdin) {
      const { options, operands: positionals } = lineArgs('tail', argv);
      const n = flagNum(options.n, 10);
      if (n && typeof n === 'object' && n.bad !== undefined) return { text: `tail: invalid line count: ${n.bad}`, code: 2 };
      const take = (text) => { const lines = linesOf(text); return lines.slice(Math.max(0, lines.length - n)).join('\n'); };
      if (positionals.length > 1) return eachFile('tail', positionals, take);
      const inp = await textInput('tail', positionals, stdin); if (inp.failed) return inp;
      return { text: take(inp.text), code: 0 };
    },
    async wc(argv, stdin) {
      const { options, operands: positionals } = parseArgs(argv, shortFlags('lwcm'), { command: 'wc' });
      // Columns in coreutils order. `wc -lw` used to print lines only, and -c counted UTF-16
      // units, not bytes.
      const cols = ['l', 'w', 'm', 'c'].filter((ch) => options[ch]);
      if (!cols.length) cols.push('l', 'w', 'c');
      const count = (text) => ({
        // LINES, not newlines: a pipeline's last line usually has no trailing newline, so counting
        // "\n" made `grep x | wc -l` undercount by one on every non-empty result (R2e).
        l: text === '' ? 0 : linesOf(text).length,
        w: text.split(/\s+/).filter(Boolean).length,
        m: [...text].length,
        c: new TextEncoder().encode(text).length,
      });
      const row = (n) => cols.map((ch) => n[ch]).join(' ');
      if (positionals.length > 1) {
        // One row per file and a total, as coreutils prints. The rows used to merge into one count.
        const rows = [], total = { l: 0, w: 0, m: 0, c: 0 }; let failed = false;
        for (const f of positionals) {
          const inp = await textInput('wc', [f], '');
          if (inp.failed) { rows.push(inp.text); failed = true; continue; }
          const n = count(inp.text); for (const k in total) total[k] += n[k];
          rows.push(`${row(n)} ${f}`);
        }
        rows.push(`${row(total)} total`);
        return { text: rows.join('\n'), code: failed ? 1 : 0 };
      }
      const inp = await textInput('wc', positionals, stdin); if (inp.failed) return inp;
      return { text: row(count(inp.text)), code: 0 };
    },
    // SH3 (2026-09-24): `od` — asked for in live runs to see a file's exact bytes (a stray \r, a BOM).
    // A documented subset: -c (characters), -b (octal bytes), -t x1 / -tx1 (hex bytes), -t c, -An (no
    // address column). 16 bytes a line, GNU's layout. Anything else is refused and says what works.
    async od(argv, stdin) {
      const types = []; let addr = true; const files = [], errors = [];
      for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-c' || a === '-tc') types.push('c');
        else if (a === '-b') types.push('b');
        else if (a === '-tx1') types.push('x');
        else if (a === '-t') { const t = argv[++i]; if (t === 'x1') types.push('x'); else if (t === 'c') types.push('c'); else return { text: `od: unsupported type ${t ?? ''} — od supports -c -b -t x1 -t c -An`, code: 2 }; }
        else if (a === '-An' || (a === '-A' && argv[i + 1] === 'n' && ++i)) addr = false;
        else if (a.startsWith('-') && a !== '-') return { text: `od: unsupported flag ${a} — od supports -c -b -t x1 -t c -An`, code: 2 };
        else files.push(a);
      }
      if (!types.length) return { text: 'od: give a format — -c (characters), -b (octal bytes) or -t x1 (hex bytes)', code: 2 };
      let bytes;
      if (files.length) {
        const parts = [];
        for (const f of files) {
          const r = await face.invoke('fs.read', { path: normalizePath(state.cwd, f) });
          if (!r.ok) { errors.push(`od: ${f}: ${r.code || 'ENOENT'}`); continue; }
          parts.push(typeof r.data === 'string' ? new TextEncoder().encode(r.data) : new Uint8Array(r.data));
        }
        bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
      } else bytes = toBytes(stdin || '');
      const ESC = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
      const cell = { c: (b) => (ESC[b] ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'))).padStart(4), b: (b) => ' ' + b.toString(8).padStart(3, '0'), x: (b) => ' ' + b.toString(16).padStart(2, '0') };
      const out = [];
      for (let off = 0; off < bytes.length; off += 16) {
        const row = bytes.subarray(off, off + 16);
        types.forEach((t, k) => out.push((addr ? (k === 0 ? off.toString(8).padStart(7, '0') : ' '.repeat(7)) : '') + Array.from(row, cell[t]).join('')));
      }
      if (addr) out.push(bytes.length.toString(8).padStart(7, '0'));
      return { text: [...errors, ...out].join('\n'), code: errors.length ? 1 : 0 };
    },
    async sort(argv, stdin) {
      const { options, operands: positionals } = parseArgs(argv, shortFlags('rnuf'), { command: 'sort' });
      const inp = await textInput('sort', positionals, stdin); if (inp.failed) return inp;
      const has = (ch) => !!options[ch];
      let lines = linesOf(inp.text);
      lines = has('n') ? lines.slice().sort((a, b) => (parseFloat(a) || 0) - (parseFloat(b) || 0))
            : has('f') ? lines.slice().sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
            : lines.slice().sort();
      if (has('r')) lines.reverse();
      if (has('u')) lines = [...new Set(lines)];
      return { text: lines.join('\n'), code: 0 };
    },
    async uniq(argv, stdin) {
      const { options, operands: positionals } = parseArgs(argv, shortFlags('cdu'), { command: 'uniq' });
      // POSIX reads a second operand as the OUTPUT file; it used to be read as more input.
      if (positionals.length > 1) return { text: `uniq: an OUTPUT operand ('${positionals[1]}') is not supported — redirect instead: uniq INPUT > OUTPUT`, code: 2 };
      const inp = await textInput('uniq', positionals, stdin); if (inp.failed) return inp;
      const has = (ch) => !!options[ch];
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
    // ls that lists a directory but PRINTS a file (coreutils behaviour). The old
    // path routed every `ls X` through fs.list, so `ls afile` threw ENOTDIR and
    // misled callers into thinking a file was a directory.
    async ls(argv) {
      const { options, operands: positionals } = parseArgs(argv, shortFlags('Ral'), { command: 'ls' });
      const long = !!options.l;
      const targets = positionals.length ? positionals : [null];
      const errors = [], files = [], dirs = [];
      let failed = false, entries = 0;
      for (const p of targets) {
        const abs = p == null ? state.cwd : normalizePath(state.cwd, p);
        const st = await face.invoke('fs.stat', { path: abs });
        if (st.ok && st.stat && st.stat.type === 'file') {
          const name = p != null ? p : abs.split('/').pop();
          files.push(long ? `- ${name}` : name); entries++;
          continue;
        }
        const input = { path: abs };
        for (const ch of Object.keys(options)) if (LIST_FLAGS[ch]) input[LIST_FLAGS[ch]] = true;
        const res = await face.invoke('fs.list', input);
        if (!res.ok) { errors.push(`ls: ${p ?? '.'}: ${res.code || 'error'}`); failed = true; continue; }
        entries += (res.entries || []).length;
        const body = renderResult('fs.list', res, { long, recursive: !!input.recursive, root: abs });
        // Several targets: each directory under a `NAME:` header, as coreutils prints. The listings
        // used to run together, so `ls a b` could not say which name was in which directory.
        // -R blocks already carry their own headers.
        dirs.push(targets.length > 1 && !input.recursive ? `${p}:${body ? '\n' + body : ''}` : body);
      }
      // a missing path used to still exit 0, so `ls d || mkdir d` never took the fallback (R2e)
      const blocks = [...errors, files.join('\n'), ...dirs].filter((s) => s !== '');
      return { text: blocks.join(options.R || targets.length > 1 ? '\n\n' : '\n'), code: failed ? 1 : 0, listing: { tool: 'ls', entries } }; // -R: a blank line between targets' blocks too
    },
    // printf FORMAT [ARGS] — backslash escapes + %s/%d/%%. Unlike echo it adds no
    // trailing newline of its own; the format supplies it (\n).
    true() { return { text: '', code: 0 }; },
    false() { return { text: '', code: 1 }; },
    printf(argv) {
      if (!argv.length) return { text: '', code: 0 };
      const fmt = unescapePrintf(argv[0]);
      const args = argv.slice(1);
      let ai = 0, text = '', bad = null;
      // %d takes what the shell's printf takes: decimal, 0x hex, 0 octal, 'c for a character code.
      // Anything else printed 0 with exit 0; it is now an error (exit 1), as in bash.
      const toInt = (v) => {
        const t = String(v).trim();
        if (t === '') return 0;
        if (/^['"]./u.test(t)) return t.codePointAt(1);
        if (/^[-+]?0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
        if (/^[-+]?0[0-7]+$/.test(t)) return parseInt(t, 8);
        if (/^[-+]?\d+$/.test(t)) return parseInt(t, 10);
        bad ??= v;
        return parseInt(t, 10) || 0;
      };
      // POSIX reuses the format until the arguments run out: `printf '%s\n' a b c` prints three
      // lines. It used to print `a` and drop the rest. A format that takes no argument runs once.
      do {
        const before = ai;
        text += fmt.replace(/%[sd%]/g, (m) => {
          if (m === '%%') return '%';
          const v = ai < args.length ? args[ai++] : '';
          return m === '%d' ? String(toInt(v)) : String(v);
        });
        if (ai === before) break;
      } while (ai < args.length);
      if (bad != null) return { text: `${text}${text && !text.endsWith('\n') ? '\n' : ''}printf: ${bad}: invalid number`, code: 1 };
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
      let parsed;
      try { parsed = parseArgs(argv, shortFlags('nEr'), { command: 'sed' }); }
      catch (error) {
        if (error instanceof ArgError && error.message.startsWith('sed: unsupported flag -i;')) {
          return { text: error.text + '; use the `edit` tool for in-place edits', code: error.code };
        }
        throw error;
      }
      const { operands: pos } = parsed;
      const script = pos[0] || '';
      // a file argument used to be IGNORED, so `sed 's/a/b/' f.txt` returned "" exit 0 (R2a)
      const inp = await textInput('sed', pos.slice(1), stdin, { keepGoing: true });
      const lines = linesOf(inp.text);
      let m = /^s\/((?:[^/\\]|\\.)*)\/((?:[^/\\]|\\.)*)\/([gips]*)$/.exec(script);
      if (m) {
        let re; try { re = new RegExp(m[1], m[3].includes('g') ? 'g' : ''); } catch (e) { return { text: `sed: invalid pattern: ${e.message}`, code: 2 }; }
        const rep = m[2].replace(/\\\//g, '/');
        return withErrors(inp, lines.map((l) => l.replace(re, rep)).join('\n'));
      }
      let pm = /^(\d+)p$/.exec(script);
      if (pm) { const l = lines[Number(pm[1]) - 1]; return withErrors(inp, l == null ? '' : l); }
      let rp = /^\/(.*)\/p$/.exec(script);
      if (rp) { const re = new RegExp(rp[1]); return withErrors(inp, lines.filter((l) => re.test(l)).join('\n')); }
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
      const { options, operands: positionals } = parseArgs(argv, {
        ...shortFlags('ilnc'),
        type: { short: 't', long: 'type', value: true, multiple: true },
        glob: { short: 'g', long: 'glob', value: true, multiple: true },
        files: { long: 'files' },
        help: { short: 'h', long: 'help' },
      }, { command: 'rg' });
      if (options.help) {
        return { text: [
          'rg PATTERN [paths...] — recursive content search over the workspace.',
          '  -i            ignore case',
          '  -l            list matching files only',
          '  -c            count matches per file',
          '  -n            line numbers (on by default)',
          '  -t, --type T  restrict to a file type: ' + Object.keys(RG_TYPES).sort().join(' '),
          '  -g, --glob G  restrict to paths matching a glob, e.g. -g "*.py"',
          '  --files       list the files that would be searched, do not match',
          'Any other flag is refused rather than ignored.',
        ].join('\n'), code: 0 };
      }
      // -t/--type and -g/--glob take a value, which must not be read as a path.
      const types = options.type || [], globs = options.glob || [];
      const filesOnly = !!options.l, listFiles = !!options.files, countOnly = !!options.c;

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
      // Each path argument becomes a (cwd, glob) pair for fs.grep: a file is
      // itself, a directory is everything under it. Only the FIRST extra
      // positional used to be honoured, and only ever as a directory.
      const roots = []; const missing = []; const files = [];
      for (const raw of paths) {
        const norm = normalizePath(state.cwd, raw);
        const st = await face.invoke('fs.stat', { path: norm });
        if (st && st.ok && st.stat && st.stat.type === 'file') {
          const slash = norm.lastIndexOf('/');
          roots.push({ cwd: slash < 0 ? '' : norm.slice(0, slash), glob: slash < 0 ? norm : norm.slice(slash + 1) });
          files.push(norm);
          continue;
        }
        const g = await face.invoke('fs.glob', { pattern: (norm ? norm + '/' : '') + '**', cwd: '' });
        if (!g.ok) return { text: `rg: ${g.message || 'search failed'}`, code: 1 };
        // A path that is neither a file nor a non-empty directory is a mistake
        // worth reporting. Returning empty made `rg PATTERN --type py` — where
        // "py" was read as a path — indistinguishable from "no matches", which
        // is how an agent ends up asking the same question four times.
        if (!g.matches.length && !(st && st.ok)) { missing.push(raw); continue; }
        roots.push({ cwd: norm, glob: '**' });
        files.push(...g.matches);
      }
      if (missing.length && !roots.length) {
        return { text: missing.map((m) => `rg: ${m}: no such file or directory`).join('\n'), code: 2 };
      }

      const prefix = state.cwd ? state.cwd + '/' : '';
      const rel = (p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
      const keep = (p) => {
        if (wantExts) { const dot = p.lastIndexOf('.'); if (dot < 0 || !wantExts.has(p.slice(dot + 1))) return false; }
        if (globRes.length && !globRes.some((re) => re.test(rel(p)) || re.test(p.split('/').pop()))) return false;
        return true;
      };
      if (listFiles) { const chosen = files.filter(keep); return { text: chosen.map(rel).join('\n'), code: chosen.length ? 0 : 1 }; }

      // Delegate the actual search to fs.grep. That is where the trigram index
      // lives, and where binary detection and the per-line lastIndex reset live.
      // rg used to glob + read every file itself, which meant the builtin the
      // agent is told to use was the one path that never touched the index.
      const t0 = Date.now();
      const rows = [];
      const seenRow = new Set();
      for (const root of roots) {
        const res = await face.invoke('fs.grep', { pattern, cwd: root.cwd, glob: root.glob, maxResults: 10000 });
        if (!res.ok) return { text: `rg: ${res.message || 'search failed'}`, code: 1 };
        for (const m of res.matches) {
          const key = `${m.path}:${m.line}`;
          if (seenRow.has(key)) continue;
          seenRow.add(key);
          rows.push(m);
        }
      }
      const kept = rows.filter((m) => keep(m.path)).sort((a, b) => (a.path === b.path ? a.line - b.line : (a.path < b.path ? -1 : 1)));

      const out = [];
      if (filesOnly) {
        for (const p of [...new Set(kept.map((m) => m.path))]) out.push(rel(p));
      } else if (countOnly) {
        const counts = new Map();
        for (const m of kept) counts.set(m.path, (counts.get(m.path) || 0) + 1);
        for (const [p, n] of counts) out.push(`${rel(p)}:${n}`);
      } else {
        for (const m of kept) out.push(`${rel(m.path)}:${m.line}:${m.text}`);
      }
      // Measurement only. fs.grep records the bytes and files itself, so this
      // entry exists to show WHICH path the agent took, not to re-count the work.
      try {
        await face.invoke('fs.recordSearch', {
          via: 'shell.rg', pattern: String(pattern), cwd: state.cwd || '', glob: '**',
          filesWalked: 0, filesRead: 0, bytesRead: 0,
          matches: out.length, truncated: false, ms: Date.now() - t0,
        });
      } catch (_) { /* a meter never breaks a search */ }
      return { text: out.join('\n'), code: out.length ? 0 : 1 };
    },
    // awk — the common one-liner subset: `awk [-F sep] '{print $N}'` / `'{print}'`.
    async awk(argv, stdin) {
      const { options, operands: parts } = parseArgs(argv, { F: { short: 'F', value: true } }, { command: 'awk' });
      const sep = options.F ?? null;
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
    // diff A B: `- line` / `+ line` for what changed; -u a unified diff (what `patch` applies);
    // -q only whether they differ. Lines are matched by a real line diff: the old one compared line
    // N with line N, so one inserted line reported every line after it as changed.
    async diff(argv) {
      const { options, operands: files } = parseArgs(argv, {
        unified: { short: 'u', long: 'unified' }, brief: { short: 'q', long: 'brief' },
      }, { command: 'diff' });
      if (files.length !== 2) return { text: `usage: diff [-u|-q] <a> <b>${files.length > 2 ? ` — extra operand '${files[2]}'` : ''}`, code: 2 };
      const a = await face.invoke('fs.read', { path: normalizePath(state.cwd, files[0]), encoding: 'utf-8' });
      const b = await face.invoke('fs.read', { path: normalizePath(state.cwd, files[1]), encoding: 'utf-8' });
      if (!a.ok) return { text: `diff: ${files[0]}: not found`, code: 2 };
      if (!b.ok) return { text: `diff: ${files[1]}: not found`, code: 2 };
      const patch = createPatch(decodeData(a.data), decodeData(b.data), { from: files[0], to: files[1] });
      if (!patch) return { text: '', code: 0 };
      if (options.brief) return { text: `Files ${files[0]} and ${files[1]} differ`, code: 1 };
      if (options.unified) return { text: patch.replace(/\n$/, ''), code: 1 };
      const body = patch.split('\n').slice(2).filter((l) => l[0] === '-' || l[0] === '+');
      return { text: body.map((l) => `${l[0]} ${l.slice(1)}`).join('\n'), code: 1 };
    },
    // xargs — take stdin tokens and append them to a command, then run it.
    async xargs(argv, stdin) {
      const tokens = String(stdin || '').split(/\s+/).filter(Boolean);
      if (!argv.length) return { text: tokens.join(' '), code: 0 };
      return runStage([...argv, ...tokens], '', true);
    },
    async cut(argv, stdin) {
      // both spellings: `-d: -f2` (attached) and `-d : -f 2` (separate)
      const { options, operands: files, occurrences } = parseArgs(argv, {
        d: { short: 'd', value: true },
        f: { short: 'f', value: true },
        c: { short: 'c', value: true },
      }, { command: 'cut' });
      const delim = options.d ?? '\t';
      const selection = occurrences.filter(({ key }) => key === 'f' || key === 'c').at(-1);
      const mode = selection?.key || 'f', spec = selection?.value || '';
      // ranges too: -f1-3 and -f1,3 were both misread as a single field (R2e)
      const want = [];
      for (const part of String(spec).split(',')) {
        const m = /^(\d+)-(\d+)$/.exec(part);
        if (m) { for (let n = Number(m[1]); n <= Number(m[2]); n++) want.push(n); }
        else if (/^\d+$/.test(part)) want.push(Number(part));
      }
      const inp = await textInput('cut', files, stdin, { keepGoing: true });
      const pick = (line) => (mode === 'c'
        ? want.map((n) => line[n - 1] ?? '').join('')
        : want.map((n) => line.split(delim)[n - 1] ?? '').join(delim));
      return withErrors(inp, inp.text === '' && inp.errors.length ? '' : linesOf(inp.text).map(pick).join('\n'));
    },
    async tr(argv, stdin) {
      const { options, operands: positionals } = parseArgs(argv, shortFlags('ds'), { command: 'tr' });
      const del = !!options.d;
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
    // basename NAME [SUFFIX]. A third operand used to be dropped; it is refused, as coreutils does.
    basename(argv) {
      const { operands } = parseArgs(argv, {}, { command: 'basename' });
      if (!operands.length) return { text: 'basename: missing operand', code: 2 };
      if (operands.length > 2) return { text: `basename: extra operand '${operands[2]}' — basename NAME [SUFFIX]`, code: 2 };
      const [name, suffix] = operands;
      let b = String(name).replace(/\/+$/, '').split('/').pop() || '/';
      if (suffix && b !== suffix && b.endsWith(suffix)) b = b.slice(0, -suffix.length);
      return { text: b, code: 0 };
    },
    // One line per operand, as coreutils prints; `dirname a/b c/d` used to answer for `a/b` alone.
    dirname(argv) {
      const { operands } = parseArgs(argv, {}, { command: 'dirname' });
      if (!operands.length) return { text: 'dirname: missing operand', code: 2 };
      return { text: operands.map((path) => {
        const p = String(path).replace(/\/+$/, '');
        const i = p.lastIndexOf('/');
        return i > 0 ? p.slice(0, i) : (i === 0 ? '/' : '.');
      }).join('\n'), code: 0 };
    },
    // chmod — accepted for script compatibility; the virtual fs has no POSIX permission bits, so a
    // valid mode changes nothing. It still checks what coreutils checks — a mode, and files that
    // exist. It used to exit 0 for anything, a missing file included.
    async chmod(argv) {
      const args = argv.filter((a) => a !== '-R' && a !== '--recursive');
      const [mode, ...files] = args;
      if (!mode) return { text: 'chmod: missing operand', code: 2 };
      if (!/^([0-7]{1,4}|[ugoa]*[-+=][rwxXst]*([-+=][rwxXst]*)*(,[ugoa]*[-+=][rwxXst]*([-+=][rwxXst]*)*)*)$/.test(mode)) {
        return mode.startsWith('-') && !mode.startsWith('--') && mode.length > 1 && !/^-[rwxXst]+$/.test(mode)
          ? { text: `chmod: unsupported flag ${mode}; chmod supports -R`, code: 2 }
          : { text: `chmod: invalid mode: '${mode}'`, code: 1 };
      }
      if (!files.length) return { text: `chmod: missing operand after '${mode}'`, code: 2 };
      const missing = [];
      for (const f of files) {
        const st = await face.invoke('fs.stat', { path: normalizePath(state.cwd, f) });
        if (!st.ok) missing.push(`chmod: cannot access '${f}': ${st.code || 'ENOENT'}`);
      }
      return { text: missing.join('\n'), code: missing.length ? 1 : 0 };
    },
    // `env CMD` would run CMD in coreutils; here it printed the environment and exited 0.
    env(argv) {
      if (argv.length) return { text: `env: '${argv[0]}': running a command or changing the environment is not supported — use \`export NAME=value\` or \`NAME=value cmd\`, or plain \`env\` to print it`, code: 2 };
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
      const cmds = commandNames();
      // Say what is ACTUALLY here. `help` used to list these as if they were coreutils, and the
      // agent believed it — flags it did not implement were ignored rather than refused
      // (forward-pass R3a). An unsupported flag is now an error, so this text and the behaviour
      // agree.
      return { text: 'commands: ' + cmds.join(' ')
        + '\noperators: | && || ; > >> < 2>&1   globs: * ?   comments: #'
        + '\nvars: NAME=value, $NAME, ${NAME}, $?, $PWD  (single quotes are literal; double quotes expand)'
        + '\nThis is a CURATED shell, not coreutils. Each builtin implements a documented subset and'
        + '\nREFUSES an unsupported flag (exit 2) rather than ignoring it. Notably:'
        + '\n  grep -n -v -i -c -E -F -h -H   (no -r; use `rg` for a recursive search)'
        + '\n  rg -i -l -n -c -t/--type -g/--glob --files   (PATTERN [paths...])'
        + '\n  head/tail -n   wc -l -w -m -c   sort -r -n -u -f   uniq -c -d -u   cut -d -f -c   tr [-d], ranges'
        + '\n  find [dir...] -name -type -maxdepth    sed s/// on stdin or a file (no -i; use the edit tool)'
        + '\n  awk -F with {print $N}      ls -R -a -l      sleep SECONDS (decimals; capped at ' + SLEEP_MAX_S + ' s)'
        + '\n  od -c -b -t x1 -An        here-documents as stdin: cmd <<\'EOF\' … EOF  (literal; python - <<\'PY\' runs it)'
        + '\nEvery operand is handled or refused: touch/mkdir [-p]/stat/rm/cat/tee/which/dirname take many;'
        + '\n  mv/cp [-r] SOURCE... DIR move into DIR and replace a file; head/tail/wc print each file;'
        + '\n  printf reuses its format; cat/cut/sed/grep/od go on past a missing file; diff [-u|-q] A B.'
        + '\n  git: init [-b] | add [-A|-u] PATHS | rm [--cached] [-r] | mv | commit -m [-a] | status [-s] | log [-n N] [REF]'
        + '\n       diff [--name-status|--name-only|--quiet] [--cached | REF [REF]] [-- PATHS] | branch [NAME]'
        + '\n       checkout [-f] REF | checkout -b NAME | clone | fetch | push [-f]'
        + '\nNo subshells, loops, functions or background jobs. Command substitution ($(…), backticks) is REFUSED (exit 2), not run.'
        + '\nPython is a real kernel (`python file.py`); it is the scripting layer, not bash.'
        + '\n`node file.mjs` / `node --test a.test.mjs …` runs a workspace ES module as a gate: node:assert and node:test, relative imports only — no npm, no fs, no network.', code: 0 };
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

  // Preserve the legacy head/tail -N shorthand before shared option parsing.
  // A number following -n is its value; words after -- stay literal operands.
  function lineArgs(command, argv) {
    const normalized = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--') { normalized.push(...argv.slice(i)); break; }
      normalized.push(/^-\d+$/.test(arg) ? '-n' + arg.slice(1) : arg);
      if (arg === '-n' && i + 1 < argv.length) normalized.push(argv[++i]);
    }
    return parseArgs(normalized, { n: { short: 'n', value: true } }, { command });
  }

  // Text in: the named files if any, otherwise stdin. Reading is what makes a file argument mean
  // something instead of being dropped on the floor.
  // keepGoing: a missing file is recorded in `errors` and the rest are still read, as cat, cut and
  // sed do in coreutils; without it the first missing file ends the command (sort does that too).
  async function textInput(name, positionals, stdin, { keepGoing = false } = {}) {
    if (!positionals.length) return { text: stdin || '', code: 0, errors: [] };
    const parts = [], errors = [];
    for (const f of positionals) {
      const res = await face.invoke('fs.read', { path: normalizePath(state.cwd, f), encoding: 'utf-8' });
      if (!res.ok) {
        const line = `${name}: ${f}: ${res.code || 'ENOENT'}`;
        if (!keepGoing) return { text: line, code: 1, failed: true };
        errors.push(line); continue;
      }
      parts.push(decodeData(res.data));
    }
    return { text: parts.join(''), code: 0, errors };
  }
  // This shell has one output stream, so a keep-going read's errors lead the output; the exit is 1.
  function withErrors(inp, text) {
    if (!inp.errors.length) return { text, code: 0 };
    return { text: [...inp.errors, text].filter((t) => t !== '').join('\n'), code: 1 };
  }

  // Several files: each under a `==> NAME <==` header, as coreutils prints. `head -n 1 a b` used
  // to read the files as one stream, so b never showed. A missing file prints its error; the rest
  // still run; the exit is 1.
  async function eachFile(name, positionals, take) {
    const blocks = []; let failed = false;
    for (const f of positionals) {
      const inp = await textInput(name, [f], '');
      if (inp.failed) { blocks.push(inp.text); failed = true; continue; }
      const body = take(inp.text);
      blocks.push(`==> ${f} <==` + (body === '' ? '' : '\n' + body));
    }
    return { text: blocks.join('\n\n'), code: failed ? 1 : 0 };
  }

  // Returns a number, or { bad } when -n was given a non-numeric value — which used to fall back
  // to the default and quietly return a different amount of text than was asked for.
  function flagNum(value, dflt) {
    if (value === undefined) return dflt;
    const n = Number(value);
    return Number.isFinite(n) ? n : { bad: value };
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

  return builtins;
}
