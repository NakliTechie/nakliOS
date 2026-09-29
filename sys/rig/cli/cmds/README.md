# Shell command modules

U0 provides the shared foundation for the Unix expansion. Existing curated
commands live in `builtins.mjs`; `core.mjs` uses the new context directly.
The language remains unchanged until U3.

- Parse argv with `parseArgs` from `../args.mjs`. It supports bundled short
  flags, attached values, long options, and `--`. `ArgError` carries exit 2
  and lists the supported spellings. Commands validate their option values.
- Use the `createIO` context from `../io.mjs` for filesystem access. Paths
  resolve against the shell's current directory. Grant checks, staging, and
  the operation log remain in the face. Failures throw `IOFailure`.
- Call `io.run(argv, stdin)` for a nested command. Arguments are already
  separated; the shell does not expand variables or globs a second time.
- Return `{ text, code }`, where `text` is a string or `Uint8Array`. Return
  `raw: true` for text whose exact final newline must survive pipes and redirection.
  Byte output always survives pipes and redirects verbatim. The terminal
  renders byte output as `<N bytes>`. Text-only commands decode at entry.
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
