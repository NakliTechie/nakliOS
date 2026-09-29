// Shell state and the legacy awk subset; command implementations live in their own modules.
// All filesystem access uses the shell's confirmation-aware face.
import { parseArgs } from '../args.mjs';

// Split text into lines the way coreutils do: a single trailing newline is a
// line terminator, not an extra empty line.
const linesOf = (t) => {
  const s = String(t == null ? '' : t);
  return (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');
};

export function createBuiltins({ state, face, normalizePath, decodeData, SLEEP_MAX_S, commandNames }) {
  // ── builtins: shell-native, may consume/produce piped text ──
  const builtins = {
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

    clear() { return { text: '', code: 0, clear: true }; },
    history(argv) {
      if (argv.length > 1 || (argv.length && !/^\d+$/.test(argv[0]))) return { text: 'history: takes one optional count — history [N]', code: 2 };
      const from = argv.length ? Math.max(0, state.history.length - Number(argv[0])) : 0;
      return { text: state.history.slice(from).map((h, i) => `${from + i + 1}  ${h}`).join('\n'), code: 0 };
    },

    true() { return { text: '', code: 0 }; },
    false() { return { text: '', code: 1 }; },

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
        + '\n  grep -r -R -l -L -o -w -x -q -s -e -f -m -A -B -C --include --exclude (also -nvicEFhH)'
        + '\n  rg -A -B -C -w -o -F -v -i -l -n -c -t/--type -g/--glob --files'
        + '\n  head/tail -n/-c [+N]   wc -lwmc   sort -k -t -h -V -s -b -d -g -o -c -rnuf'
        + '\n  find [dir...] -name -type -maxdepth    sed -n -e -f -E -r -i[SUFFIX] -s -z; addresses, hold space, branches'
        + '\n  awk -F with {print $N}      ls -1 -A -d -h -S -t -r -F -Ral      sleep N[s|m|h|d] (cap ' + SLEEP_MAX_S + ' s)'
        + '\n  od -c -b -x -o -d -t x1 -A -N -j        here-documents as stdin: cmd <<\'EOF\' … EOF  (literal; python - <<\'PY\' runs it)'
        + '\ncat -nbsAET   echo -ne   printf width/precision, %s %d %x %o %f %c %b   tee -a'
        + '\n  mv/cp [-n -t DIR] SOURCE... DEST; cp -r for directories; mkdir -pv; touch -c; stat -c; rm -vd'
        + '\n  xargs -n -I -0 -d -r -L; env -i -u CMD; which -a; basename -a -s; test ! -a -o ( ) -nt -ot'
        + '\n  uniq -cdu -i -f -s -w; cut -d -f -c -b --complement; tr -d -c -s, ASCII classes; diff -uqrNwbi'
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
  return builtins;
}
