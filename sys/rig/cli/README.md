# Governed shell

`createShell({ registry, face, ...options })` executes commands over the virtual filesystem.
It does not launch host processes. All filesystem effects use the supplied agent face.

`feed(source)` returns `output` for terminal rendering, exact `stdout` and `stderr` data,
plus confirmation and listing metadata when applicable. Data can be strings or `Uint8Array`.
`lastCode` holds the last command status. A pipeline returns its final stage's status;
`!` negates that status. Refusal, expired deadlines and failed producer transport stop
remaining stages with the owning operation’s status. Pipes carry stdout. Diagnostics remain on stderr unless redirected.

## Language

The shared parser preserves quote boundaries, newlines, comments and continuations.
It supports and/or lists, pipelines, if/elif/else, list for, while/until, case,
groups, copied subshell scopes, functions, local variables, return, positional parameters,
shift, break/continue and read -r. Functions persist until reset or redefinition.

Expansions include variables, positionals, command substitution, backticks,
signed 64-bit arithmetic, parameter defaults/assignment/errors/alternatives,
lengths, prefix/suffix patterns, replacement and substrings. Unquoted expansions
undergo IFS splitting and pathname expansion. Quoted "$@" preserves fields.
Substitution removes trailing newlines and refuses NUL, binary controls or invalid UTF-8.
Ordinary pipelines and redirects preserve bytes.

Input redirects, literal heredocs, stdout/stderr redirects, append, descriptor
duplication/closing and combined redirects apply left to right. `/dev/null` is virtual.
Ordinary file redirects open before command execution. Output redirects retain
automatic parent creation, subject to lexical fences and canonical target grants. Destructive staged writes
collect the owning command's final payload into one proposal; workspace reads retain
approved contents until acceptance. Authorization is checked before execution and
again on the final write or acceptance. Refusal and Stop clean up pending proposals.

The complete source parses before execution. Background jobs, host descriptors,
process substitution, ANSI-C quoting and expanding heredocs are unavailable.
Unsupported forms report errors rather than silently changing meaning.

## Bounds and cancellation

`languageLimits` supports source bytes, tokens, nesting, loop iterations, function
depth, runtime steps, argument bytes, output bytes and cooperative yield cadence.
Defaults appear in `LANGUAGE_LIMITS` in language-parser.mjs. All overrides must be
nonnegative safe integers; parser/function depths and yield cadence must be positive.
Nested substitutions and wrappers share invocation budgets. Stop awaits owned work.

Redirects prefer bounded backend reads. Legacy whole-object hosts, including Crate,
retain their existing read route when that capability is unavailable. Their byte
ceiling is checked after the host allocates its response. U2 utilities retain strict
bounded-read requirements. Crate metadata lookup uses keys without reading content;
it does not advertise bounded reads or invent unavailable sizes and timestamps.

## Permission inspection

`language-inspect.mjs` reads the same AST as execution. It inspects every branch,
substitution, function body, redirect expansion, alias and supported executable wrapper.
Dynamic executable positions fail closed under shell deny/ask rules.
Allow rules must cover every executable segment. Canonical matching uses argv,
never a reparsed argument string.

Anvil attaches `shell.permissionContext` with `withShellContext` before applying rules.
This includes persisted functions and their shadowed command names. The trusted context
uses a private Symbol; JSON tool arguments cannot replace it. Reset clears that state.

The U3 suites exercise the public shell, governed filesystem and Anvil consumer.
Native comparison and review receipts are recorded in the private plan directory.

### Agent action classification

Anvil classifies static executable segments using the shell AST and trusted persisted functions. Unknown executable positions require approval even with empty permission rules or bypass mode. Anvil also supplies `beforeCommand` to check fully expanded dispatcher argv. This guard rejects critical actions before their command handler, including arguments supplied through functions and wrappers. It cannot lift filesystem grants, staging, or transport restrictions. Earlier commands in an approved compound can already have run before a later dynamic critical action is refused.
