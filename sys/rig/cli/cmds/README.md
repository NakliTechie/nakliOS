# Shell command modules

U0 provides the shared foundation. U1 adds command flags, sed, awk, and find. U2 adds text, numeric, filesystem and inspection utilities:

| Module | Commands |
| --- | --- |
| `builtins.mjs` | Shell state, discovery and chmod |
| `core.mjs` | Byte-preserving cat, display flags, and tee append |
| `files.mjs` | touch, mkdir, stat, mv, recursive cp and no-clobber transfers |
| `list.mjs` | Directory selection, classification and ordering |
| `text.mjs` | sort, head, tail, wc, uniq, cut, tr, echo, printf, od |
| `search.mjs` | Indexed recursive grep/rg and recursive diffs |
| `utility.mjs` | env, xargs, test, basename, dirname, which, sleep |
| `sed.mjs` | U1b stream editing, addresses, hold space, branching and governed in-place edits |
| `awk.mjs` | U1c records, patterns, expressions, arrays, functions and governed file streams |
| `find.mjs` | U1d bounded traversal, predicates, expressions, governed deletion and nested commands |
| `records.mjs` | U2a tac, rev, nl, paste, join, comm, split |
| `layout.mjs` | U2a fold, fmt, expand, unexpand, column, ptx |
| `numeric.mjs` | U2a seq, shuf, tsort, expr, numfmt, factor |
| `bc.mjs` | U2a exact decimal calculator language and math library |
| `generators.mjs` | U2a virtual printenv and bounded yes producer |
| `paths.mjs`, `path-resolution.mjs` | U2b governed readlink and realpath; explicit ln/link refusals |
| `mutation.mjs` | U2b rmdir, mktemp, truncate and unlink |
| `inspection.mjs` | U2b du, tree, file, strings and cmp |
| `u2-common.mjs`, `u2-decimal.mjs`, `streams.mjs` | Bounded byte I/O, exact arithmetic, and producer cleanup |

Quoted and escaped operator arguments now remain literal. The full language expansion remains scheduled for U3. Agent interceptors for recursive grep,
in-place editors and heredoc writes remain unchanged until the agent migration.
Before U3's nested-command analysis, executable env, xargs, and find actions
use the fail-closed permission-rule path when an owner sets shell deny/ask rules.
Dynamic verbs, find action tokens, and unquoted find globs also take that path.
Escaped command arguments cannot safely match textual multiword prefixes yet; those also fail closed. Textual rules cannot
safely match quoted or escaped verbs yet, so those also fail closed.

- Handle every operand, or refuse the form with exit 2. A command that reads
  its first operand and drops the rest exits 0 with a wrong answer; the
  false-friends suite has one test per command that takes several.

- Parse argv with `parseArgs` from `../args.mjs`. It supports bundled short
  flags, attached values, long options, and `--`. `ArgError` carries exit 2
  and lists the supported spellings. Commands validate their option values.
- Use the `createIO` context from `../io.mjs` for filesystem access. Paths
  resolve against the shell's current directory. Grant checks, staging, and
  the operation log remain in the face. Failures throw `IOFailure`.
  `readBytes(path, {maxBytes})` requests a bounded read before content allocation.
  Storage without bounded-read support returns `ENOTSUP` before metadata reads.
  `readBytes`, `stat`, and nonrecursive `list` accept `rejectSymlinks:true` for already canonical paths.
  This prevents those calls from following aliases introduced after canonical grant checks.
  With `stat({follow:false})`, final-link metadata remains available while ancestor links refuse.
  `io.invoke` accepts registry-shaped inputs for indexed search. It passes through
  the same grant/staging boundary; callers resolve its paths explicitly.
- Call `io.run(argv, stdin)` for a nested command. Arguments are already
  separated; the shell does not expand variables or globs a second time.
- Return `{ text, code }`, where `text` is a string or `Uint8Array`. Return
  `raw: true` for text whose exact final newline must survive pipes and redirection.
  Byte output always survives pipes and redirects verbatim. The terminal
  displays valid UTF-8 as text and other byte output as `<N bytes>`.
  Text-only commands decode at entry.
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

## Awk

`awk` accepts `-F`, repeated `-v` assignments, and repeated `-f` script files.
Programs support patterns, ranges, `BEGIN`/`END`, expressions, fields, arrays,
functions, loops, `print`/`printf`, builtins, and `getline`.
Script files and data files resolve against the shell's current directory.
`-F` and `-v` assignments apply in argument order before `BEGIN`.
Operand assignments take effect during input traversal.

Strings and regular expressions use byte-oriented C-locale semantics.
`ENVIRON` contains the shell's virtual variables. It never reads the host process environment.
`ARGC` and `ARGV` expose the command's operands and govern subsequent file traversal.
Field assignments rebuild `$0` through `OFS`; assigning `$0` rebuilds fields.
Paragraph records follow GNU/Unix field splitting: an additional newline separator applies only to single-character `FS`.
Empty `FS`, regex `RS`, and embedded NUL preservation are explicit extensions.
At EOF, `getline` returns zero and retains its target's previous value.

File-directed `getline`, output redirection, and `close` use governed I/O.
Streams use literal filename strings as their identities, including for `close`.
The first `>` opening truncates its file. Subsequent writes append to that open stream.
Closing a stream permits a later `>` opening to truncate again.
`>>` preserves existing content and requires read access when that content exists.
Program validation precedes execution and file mutations.

The interpreter bounds total input at 64 MiB and programs at 256 KiB.
File reads require bounded-read support: Memory, FSA/OPFS, and supported overlays provide it.
The current Crate adapter refuses these reads because its metadata fallback loads whole files.
Output, individual buffers, aggregate array storage, and aggregate scalar storage each have 16 MiB limits.
It permits 262,144 records, 100,000 fields or array entries, 64 open streams, and 128 function calls of recursion.
Execution and regex matching share a one-million-step budget.
Floating-point format precision above 100 fails explicitly.
Unsigned integer formats use 64-bit wrapping.
Long-running loops yield so Stop can cancel the current invocation.
`system()` and command pipes fail explicitly because this runtime cannot start processes.
File stream operations honor grants and the registry's existing confirmation policy.
The default `fs.write` executes immediately; a registry marking writes destructive requires confirmation before each write.
The interpreter awaits those proposals and preserves Stop while suspended.

## Find contract (U1d)

`find [path...] [expression]` visits roots at depth zero and preserves their display spelling.
Omitted paths mean `.`; its descendants display as `./name`. Empty directories are real entries.
Traversal does not follow final symlinks, including dangling links.
A trailing slash requires a directory; trailing-slash symlink dereferencing is explicitly unsupported.
Pathguard continues to reject control characters, including newlines, in filesystem names.
Metadata-only stat, listing, and deletion requests refuse backends that would load content to synthesize metadata.
FSA metadata requests propagate provider failures; deletion remains nonrecursive if a directory gains children during the operation.
Overlay also refuses deletion of unpinned base files when preserving its conflict guarantees would require an unbounded preimage read. Ancestor links retain governed mount containment checks.
`-type` accepts `f`, `d`, and `l`; unsupported special file kinds fail explicitly.

Expressions support parentheses, `!`, implicit or explicit `-a`, and `-o`, in that precedence order.
Predicates include `-name`, ASCII-insensitive `-iname`, `-path`, `-regex`, `-size`, `-mtime`, `-mmin`, `-newer`, and `-empty`.
`-regex` matches the whole display path with bounded POSIX ERE, differing from GNU find's default Emacs syntax.
Size tests use rounded-up 512-byte blocks by default, with `c`, `w`, `b`, `k`, `M`, and `G` units.
Numeric `+n` and `-n` mean strictly greater and strictly less than n.
Time predicates require available backend timestamps; zero timestamps produce an explicit metadata diagnostic when evaluated.
Use `-type f` before time predicates when directory timestamps are unavailable.
`-mindepth` and `-maxdepth` control evaluation and descent globally.

Default output is `-print` unless any print, execution, or deletion action occurs in the expression.
`-print0` preserves UTF-8 pathname bytes separated by NUL.
`-prune` prevents descent when its branch evaluates true.
`-delete` uses postorder, nonrecursive, non-following removal through the existing confirmation boundary.
Combining `-delete` with `-prune` fails before traversal. Earlier accepted deletions remain if later operations fail or stop.

`-exec CMD {} \;` runs once per match; `{}` occurrences are replaced within existing arguments without reparsing.
`-exec CMD {} +` requires exactly one standalone `{}` immediately before `+` and batches bounded arguments.
`-execdir` runs within each containing directory using `./basename`; its batches never mix directories.
Starting `.` uses `./.` in the invocation directory; the virtual root uses `.` within `/`.
Nested commands receive empty stdin and retain grants, staging, byte output, and Stop.
The shell `rm` alias now defaults to non-following final-link removal, including within find execution.
Direct registry and fileops removal retain their existing following default.
The caller's directory is restored after nested success, failure, or cancellation.
A nonzero child exit makes the semicolon predicate false; a failed plus batch makes find exit nonzero.
The plus action remains true during expression evaluation. Earlier completed batches retain their effects when later batches fail.
Only a plus immediately following a standalone `{}` terminates a batch template; other plus arguments remain literal.

All expressions and execution templates are parsed before traversal; reference timestamps are checked before actions.
The command bounds traversal entries, depth, matcher steps, retained paths, output, and nested invocations.
The backend supplies each directory listing eagerly; find bounds retained entries after that call returns.
Plain line listings retain the terminal's 500-entry cap; pipes receive all entries within resource limits.
NUL and mixed nested output bypass line-based truncation.

## U2a transport and environment

The U2a commands treat input as bytes under C-locale rules.
Their output retains exact framing through pipes and redirected files.
Terminal rendering classifies complete valid UTF-8 byte output at the display boundary.
Binary output retains the existing byte-count display.

`printenv [-0] [NAME...]` reads the virtual shell environment.
Named variables preserve operand order; missing variables produce status 1 while present values still print.
The virtual PWD follows the current directory unless `env` establishes an explicit environment.
`env -i printenv` therefore remains empty. No host environment is read.

`yes` emits `y` or its words joined by spaces, followed by LF.
`yes | head -n N` and `yes | head -c N` stop normally at the requested boundary.
Count-free `shuf -r` uses the same producer protocol.
Head closes its producer after early completion, invalid arguments, failure, or Stop.
Unsigned or plus-prefixed zero-count head closes the producer without requesting data.
Negative counts mean all except the last N records or bytes; `-0` therefore requires the entire input.
Repeated standard-input operands for head refuse before reading instead of replaying the same input prefix.
File-only head operands close ignored pipeline input before reading the named files.

Other consumers, negative head counts, and mixed head operands require bounded materialization.
Nested executable wrappers also materialize their child results within the byte ceiling.
Streaming through arbitrary wrapper or filter chains is not implemented before U3.
Standalone infinite producers fail at their resource ceiling; they never report a finite prefix as complete.
The default limits are 64 MiB input, 16 MiB output, and 16 MiB auxiliary retention per invocation.
Producer chunks contain at most 64 KiB. Loops yield for Stop and share explicit work limits.

Shared exact decimals use scaled BigInts with explicit rounding and allocation checks.
No numeric command invokes host processes or a remote calculation service.
File readers request the remaining aggregate byte limit before backend content allocation.
Commands preserve typed grant and backend capability failures.

### Record utilities

`tac [-b] [-s SEP] [-r] [FILE...]` reverses records independently for each input.
The regex mode uses bounded POSIX BRE with C-locale byte classes.
`rev [FILE...]` reverses bytes within each LF-delimited line and preserves unterminated tails.
`nl` supports logical page delimiters, header/body/footer numbering styles, line increments, blank groups, numbering formats, and page resets.

`paste [-s] [-d LIST] [-z] [FILE...]` shares one stdin cursor across repeated `-` operands.
`paste - -` therefore consumes alternating records from the same input.
`join` supports selected key fields, delimiters, unmatched rows, replacement fields, output selection, case folding, and order controls.
Duplicate matching key groups produce their complete Cartesian product within resource limits.
`comm [-123] [-z] FILE1 FILE2` retains duplicate multiplicities and adjusts indentation for suppressed columns.
Join and comm require sorted inputs unless `--nocheck-order` explicitly disables checking.
They refuse two simultaneous `-` operands before reading, because shared two-stream stdin semantics are outside this implementation.

`split` supports line, byte, and line-byte pieces, alphabetic/numeric suffixes, numeric starts, and additional suffixes.
It validates destination names, suffix capacity, input collisions, and aggregate output before its first governed write.
Split refuses symlinked input or destination paths, including ancestors, during metadata-only preflight.
This prevents aliases from bypassing input-collision checks. Backends lacking content-free metadata refuse explicitly.
Each write awaits the registry's existing confirmation policy.
Refusal, Stop, or a write failure prevents later pieces; earlier accepted pieces remain.

### Layout utilities

`fold [-b] [-s] [-w N]` distinguishes byte width from C-locale display columns.
`expand [-i] [-t STOPS]` and `unexpand [-a] [-t STOPS] [--first-only]` share checked tab stops.
Layout counts bytes rather than Unicode graphemes or East Asian terminal widths.
`fmt` supports width, goal, split-only, uniform spacing, prefixes, crown margins, and tagged paragraphs.
`column` supports table, separator, output separator, output width, and row-first forms.
It chooses explicit width, virtual `COLUMNS`, then width 80.

`ptx` builds a bounded permuted keyword index with contextual output.
It supports case folding, references, widths/gaps, break files, ignored words, selected words, and optional roff output.
`ptx -o FILE` reads selected words; it is not an output destination.
Every auxiliary file uses governed reads and the same aggregate input limit.

### Numeric utilities

`seq` steps exact decimals and supports separators, equal-width output, and one checked numeric format directive.
Formats support `e/E/f/F/g/G`, bounded width/precision, and literal `%%`; hexadecimal floating formats explicitly refuse.
`shuf` supports input records, explicit elements, inclusive ranges, finite counts, replacement, NUL records, and governed output files.
It uses platform cryptographic entropy with rejection sampling; unavailable entropy fails explicitly.
`shuf -o FILE` reads its input before writing, including same-path input/output.
`tsort` validates token pairs and reports cycles with a nonzero status.

`expr` implements integer arithmetic, comparisons, value-selecting logical operators, string operations, and bounded anchored BRE matching.
It preserves exact BigInt integers and statuses 0 for truthy results, 1 for empty/zero results, and 2 for usage errors.
`numfmt` scales exact decimals using none, SI, IEC, IEC-i, or automatic input units.
It supports selected fields, headers, delimiters, padding, suffixes, rounding, numeric formatting, and invalid-input policies.
`factor` handles exact nonnegative integers through 64 bits with bounded deterministic primality and factor-search work.
Zero and one have no fabricated prime factors. Exhausted work reports failure instead of returning an incomplete factor list.

### Calculator

`bc [-lqsw] [FILE...]` uses a dedicated parser and exact scaled-integer interpreter.
It processes file programs in order, followed by stdin, through governed bounded reads.
The language supports variables, arrays, assignment, arithmetic, comparisons, conditionals, loops, functions, automatic locals, return, and quit.
Functions copy ordinary array parameters; explicit `*array[]` parameters provide the supported reference extension.
GNU-style extensions such as `else`, boolean operators, `print`, and multi-character names are explicit in strict and warning modes.
`-s` refuses extensions; `-w` reports them. Noninteractive `-q` does not add a banner.

`scale`, `ibase`, `obase`, `length`, `scale(expr)`, and `sqrt` retain calculator-specific decimal rules.
Input bases follow GNU's documented 2–16 clamping behavior.
Output bases above the implemented ceiling of 999 fail explicitly.
`read()` remains unsupported; programs receive source through files and stdin.
Numbers use bounded continuation lines rather than losing significant digits during formatting.

`-l` initializes scale 20 and supplies sine, cosine, arctangent, logarithm, exponential, and integer-order Bessel functions.
The math library uses scaled-integer intervals with remainder bounds and precision refinement.
It returns a value only when enclosing endpoints truncate to the same requested decimal result.
It reports a resource error when its bounded precision or work cannot establish that result.

Default calculator limits include 256 KiB source, 100,000 syntax nodes, 128 syntax/function levels, 10,000 decimal digits, and scale 1,000.
Arrays and exponentiation have separate bounds; arithmetic checks intermediate allocation before constructing large values.
Stop interrupts yielded loops and preserves a subsequent independent shell invocation.

## U2b paths, mutations and inspection

`readlink` prints literal link targets or canonical paths with `-f`, `-e`, and `-m`.
It supports LF, NUL, and single-operand no-newline framing.
It reads `POSIXLY_CORRECT` only from the virtual environment when choosing default diagnostics.
`realpath` supports physical and logical resolution, existence policies, lexical stripping, relative output, and NUL framing.
Physical resolution expands links before processing subsequent `..`; logical resolution collapses original dot components first.
Absolute link targets start at the virtual mount root. Paths cannot escape that root.
Every canonical component passes governed metadata checks, including components reached through links.
This requires grants for resolved ancestors and targets, not only the original alias.
`realpath -sm` is the explicit lexical-only form and performs no filesystem I/O.
The default bounds include 1,024 path components, eight link expansions, and shared path-byte and work budgets.
Resolution does not promise an atomic snapshot across independent metadata calls.

`rmdir` removes empty directories and optionally their emptied parents.
`unlink` removes exactly one non-directory entry without following its final link.
Typed deletion requires a backend primitive that preserves the type constraint at deletion.
`mktemp` exclusively creates its result; collisions never overwrite existing entries.
It supports templates and directory creation with bounded cryptographic name generation.
Its default directory is virtual `TMPDIR` when set, otherwise the shell's current directory.
`truncate` shrinks or zero-extends bytes through the backend's bounded mutation capability.
Relative size operations require atomic use of the current size; unsupported provider guarantees fail explicitly.
The new mutations refuse symlink ancestors. Truncation also refuses final symlinks.
Each mutation retains the registry's grants and staging policy; accepted earlier operations survive a later refusal or Stop.
`ln` and `link` report the unavailable governed link-creation capability and exit nonzero.

| Backend | Exclusive creation | Typed removal | Truncation |
| --- | --- | --- | --- |
| Memory | Atomic creation | Atomic type check and deletion | All supported size modes, atomic replacement |
| FSA/OPFS | Explicit refusal | Explicit refusal | Absolute size on existing files through an abortable writable transaction |
| Crate, Overlay, undeclared adapters | Explicit refusal | Explicit refusal | Explicit refusal |

FSA truncation reads a bounded immutable file prefix, then commits a replacement through the selected file handle.
It refuses relative modes and missing-file creation because those guarantees require capabilities the adapter cannot provide.
Its transaction does not compare against external edits made after the immutable snapshot.
Capability refusals precede metadata traversal when the adapter declares the capability unavailable.
Browser handle removal does not establish an atomic type constraint; these commands refuse that path even when `handle.remove` exists.

`du` reports virtual apparent file sizes, using 1 KiB units by default.
It supports summaries, individual files, totals, depth limits, human-readable units, and NUL framing.
It does not invent physical allocation or directory storage overhead. Unknown file sizes produce a diagnostic.
`tree` produces deterministic UTF-8-byte ordering with ASCII branches, hidden-file selection, depth limits, and optional sizes.
Both commands inspect final links without traversing their targets; unsupported dereference flags fail explicitly.
Their metadata operations never load file contents to synthesize metadata.

`file` uses a finite set of signatures and text checks, with a generic data fallback.
It supports brief and MIME output, list files, and explicit link dereferencing through governed canonical paths.
It has no host magic database and refuses decompression options.
`strings` finds C-locale printable byte runs with configurable minimum length, separators, filenames, and byte offsets.
It supports seven-bit and eight-bit single-byte modes; other encodings fail explicitly.
`cmp` preserves binary input and returns zero for equality, one for differences, and two for errors.
It supports silent output, listed differences, byte display, decimal skips, and a decimal comparison limit.
Inspection content reads use canonical targets and the remaining aggregate bounded-read budget.
`file` and `cmp` read bounded complete inputs because the I/O interface has no range-read capability.
