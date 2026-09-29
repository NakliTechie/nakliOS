# Shell command modules

U0 provides the shared foundation. U1a extends the command flags. U1b adds sed:

| Module | Commands |
| --- | --- |
| `builtins.mjs` | Shell state, discovery, chmod, existing awk subset |
| `core.mjs` | Byte-preserving cat, display flags, and tee append |
| `files.mjs` | touch, mkdir, stat, mv, recursive cp and no-clobber transfers |
| `list.mjs` | Directory selection, classification and ordering |
| `text.mjs` | sort, head, tail, wc, uniq, cut, tr, echo, printf, od |
| `search.mjs` | Indexed recursive grep/rg and recursive diffs |
| `utility.mjs` | env, xargs, test, basename, dirname, which, sleep |
| `sed.mjs` | U1b stream editing, addresses, hold space, branching and governed in-place edits |

The language remains unchanged until U3. Agent interceptors for recursive grep,
in-place editors and heredoc writes remain unchanged until the agent migration.
Before U3's nested-command analysis, env commands and xargs use the existing
fail-closed permission-rule path when an owner sets shell deny/ask rules.

- Handle every operand, or refuse the form with exit 2. A command that reads
  its first operand and drops the rest exits 0 with a wrong answer; the
  false-friends suite has one test per command that takes several.

- Parse argv with `parseArgs` from `../args.mjs`. It supports bundled short
  flags, attached values, long options, and `--`. `ArgError` carries exit 2
  and lists the supported spellings. Commands validate their option values.
- Use the `createIO` context from `../io.mjs` for filesystem access. Paths
  resolve against the shell's current directory. Grant checks, staging, and
  the operation log remain in the face. Failures throw `IOFailure`.
  `io.invoke` accepts registry-shaped inputs for indexed search. It passes through
  the same grant/staging boundary; callers resolve its paths explicitly.
- Call `io.run(argv, stdin)` for a nested command. Arguments are already
  separated; the shell does not expand variables or globs a second time.
- Return `{ text, code }`, where `text` is a string or `Uint8Array`. Return
  `raw: true` for text whose exact final newline must survive pipes and redirection.
  Byte output always survives pipes and redirects verbatim. The terminal
  renders byte output as `<N bytes>`. Text-only commands decode at entry.
  A result may provide `displayText` for readable terminal diagnostics beside binary
  output. Pipes and redirects continue to use `text` unchanged.
  Legacy line-oriented producers add their newline before entering a pipe;
  `cat` and `tee` transport their input unchanged.
- Add commands to the shell's dispatch table. `help`, `which`, and the
  public `commands` getter use that same table, including dotted registry names.

The confirmation-aware face suspends a command's async call stack at a staged
operation. `feed()` returns the prompt; the next `feed('y')` resumes that same
operation. A refusal returns failure without losing pipeline or statement
control flow. One `rm` batches its paths into one prompt, as before.

`cancel()` rejects pending proposals and abandons the remaining invocation.
Stop has the same effect at safe operation boundaries. An operation already
accepted can complete; cancellation does not roll it back. `reset()` also
abandons a pending invocation before clearing shell variables and cwd.
With an already-stopped signal, a new invocation can inspect files for diagnostics.
It cannot mutate files or run Python/JavaScript runtime code.

The agent executor permits at most 1,024 confirmations per command line.
This replaces the silent eight-confirmation cutoff. At the bound, it cancels
the pending proposal and remainder with exit 130. Existing agent redirects
remain unchanged; moving the agent onto shell tools is a later chunk.

Compatibility limits remain explicit. Streams combine stdout and stderr until
U3. `wc -l` retains the historical unterminated-line count. Single-file `wc`
omits its filename. `uniq INPUT OUTPUT` remains refused; redirect its output.
`od` requires an explicit format. Character classes use the C/ASCII locale.
`stat -c` exposes only name, size, type and backend timestamps; it refuses fake
permission/ownership fields. The virtual filesystem has no POSIX mode bits.
`touch` preserves an existing file without updating its backend timestamp.

## Sed

`sed` accepts `-n`, repeated `-e` and `-f`, `-E`/`-r`, `-i[SUFFIX]`, `-s`,
and `-z`. Script files resolve against the shell's current directory.
Addresses include line numbers, `$`, regular expressions, `first~step`, ranges,
relative range endings, negation, and command groups.
Commands cover substitution, deletion, printing, multiline cycles, text insertion,
transliteration, quitting, listing, file reads/writes, hold space, labels, and branches.

Pattern spaces preserve bytes, including invalid UTF-8 and unterminated records.
Regular expressions use byte semantics and C/ASCII character classes.
The matcher bounds its work. The interpreter bounds steps, buffers, and output.
Unsupported commands and expressions fail explicitly, including shell execution.

Script reads, data reads, `r`, `w`, edits, and backups use the same governed I/O.
The interpreter parses the complete script before opening write destinations.
In-place edits compute a file's replacement before writing it.
An accepted backup write can remain if a later edit is cancelled or refused.
Writes retain the backend's existing atomicity guarantees; sed adds no transaction
across files or independent write destinations.
