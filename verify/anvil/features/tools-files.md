# The file tools

The six tools every mode's toolset starts from (`codingToolset` in `sys/ai/agent-tools.mjs`;
`runToolset` in `sys/ai/run-assembly.mjs` adds the rest). `plan` offers `read` + `todowrite`,
`ask` offers `read` only; the model is refused, not silently ignored, when it names a hidden one.
Shared prerequisites: the launch in `../README.md`; a fresh project with a seeded file
(`__anvil.test.fs.write('cfg.js','const v = 1;\n')`). Every drive step is a prompt sent through
`#prompt` + `#send` (or `Enter`) and read back from the run record and `__anvil.test.fs.read`.

### tool:read
- **Goal:** the model sees a file's content with line numbers, sliced by `offset`/`limit`, capped.
- **Source:** `sys/ai/agent-tools.mjs` (`readTool`, the `read` branch, `READ_MAX_LINES`/`READ_MAX_BYTES`); the app's executor wrapper in `apps/anvil/index.html` (`const executeTool`).
- **Prerequisites:** launch; a seeded file of > 2,000 lines for the cap case.
- **Reach and drive:** prompt "Read cfg.js and tell me the value of v; do not change anything." Then, for the cap, "Read big.txt" and, for the slice, "Read big.txt from line 2099, two lines."
- **Observable success:** the record's `tool.responded` for `read` carries the numbered lines; the cap case ends with `(Showing lines 1–2000 of N. Use offset=2001 to continue.)`; the slice returns exactly two numbered lines; `cfg.js` is byte-identical afterwards.
- **Gotchas:** `read` also records the version the model saw (F8) — a later `edit` after a shell rewrite is refused as stale; that is the next recipe, not a failure here.

### tool:edit
- **Goal:** an exact-string replacement lands only on a file the model has read at its current version.
- **Source:** `sys/ai/agent-tools.mjs` (`applyEdit` chain, the `edit` branch, `readLedger`, `contentToken`, `staleReply`).
- **Prerequisites:** launch; `cfg.js` seeded.
- **Reach and drive:** (a) "Change v to 2 in cfg.js" on a fresh task — the model must read first. (b) After a read, rewrite the file behind the tools (`__anvil.test.fs.write('cfg.js','const v = 1;\nconst w = 2;\n')`), then prompt "Change v to 3 in cfg.js" and watch the first edit.
- **Observable success:** (a) an `edit` without a prior `read` is refused with "has not been read yet"; after the read, `Edited cfg.js (1 replacement, exact match)` and the file reads `const v = 2;`. (b) the first `edit` is refused `Refused: cfg.js is stale — …`, classified `rejected` in the record; the model re-reads; the next edit applies over the shell's content.
- **Gotchas:** an identical-bytes rewrite is not stale (the token is content, not time). Whitespace-tolerant matching: `old_string` need not be byte-exact; a non-unique match is refused, not guessed.

### tool:write
- **Goal:** a whole-file create/overwrite, establishing the version the model now knows.
- **Source:** `sys/ai/agent-tools.mjs` (`writeTool`, the `write` branch; `asStored`).
- **Prerequisites:** launch.
- **Reach and drive:** "Create hello.txt containing exactly the word hello." Then "Change hello to hullo in hello.txt" with no read in between.
- **Observable success:** `hello.txt` reads `hello`; the follow-up `edit` applies without a read (a write is a known version). The result line notes an absolute path rebases against the root if the model used one.
- **Gotchas:** the write is staged through the agent face when the grant says so; the tool result says `Wrote <path>` either way — read the file back, do not trust the line.

### tool:apply_patch
- **Goal:** a multi-file patch (Add / Update / Delete) applies atomically per file, with the same read-before-edit and version rules as `edit` on its updates.
- **Source:** `sys/ai/agent-tools.mjs` (`parseApplyPatch`, the `apply_patch` branch).
- **Prerequisites:** launch; `b.txt` seeded with `keep\nremove me\n`.
- **Reach and drive:** "Using apply_patch in one call: add a.txt with hello, update b.txt to drop the line 'remove me', delete old.txt." Then the stale case: read `b.txt`, rewrite it behind the tools, prompt an update.
- **Observable success:** `Applied patch: add a.txt, update b.txt, delete old.txt`; files as described; the stale update is refused `is stale` and `b.txt` untouched; an update on a never-read file is refused `has not been read yet`.
- **Gotchas:** an `Add File` body has no trailing newline unless the patch carries one.

### tool:todowrite
- **Goal:** the model keeps one checklist; at most one item is `in_progress`.
- **Source:** `sys/ai/agent-tools.mjs` (`todoTool`, the `todowrite` branch).
- **Prerequisites:** launch; a multi-step prompt.
- **Reach and drive:** "Plan three steps for adding a README, mark the first in progress, then do them one at a time, updating the list." Then, in a new task: "Call todowrite once with two items both marked in_progress, then tell me what it said."
- **Observable success:** each `todowrite` result renders `Todo (k/3):` with `[ ] [~] [x]` marks; the two-in-progress call's result in the record is `Error: only one todo may be in_progress at a time.` and the list is unchanged.
- **Gotchas:** the list is per executor (per run); a new task starts empty.

### tool:shell
- **Goal:** the curated shell runs a command in the workspace and returns output plus `[exit N]`; unsupported flags are refused, never ignored; a single-file `cat/head/tail` counts as a read.
- **Source:** `sys/rig/cli/shell.mjs` (the builtins), `sys/ai/agent-tools.mjs` (the `shell` branch, `capOutput`, `expect`), `sys/ai/agent-loop.mjs` (`interceptBashCommand`).
- **Prerequisites:** launch; for `python`, the COI serve.
- **Reach and drive:** "Run `ls -la`, then `rg -n 'const' cfg.js`, then `sed -i 's/a/b/' cfg.js`." Then "Run `python -c 'print(1+1)'`." Then a shell call with a missing `command` parameter (ask the model to call the tool with `cmd`).
- **Observable success:** `ls` and `rg` output with `[exit 0]`; `sed -i` refused with "use the `edit` tool"; python prints `2` with `[exit 0]`; the mis-parameterised call is refused before anything runs, naming `"command"` and the keys sent, with no exit code.
- **Gotchas:** output over the cap spills to `.forge/out-N.txt` with a pointer; a `[expect]` line is graded live when the model passed `expect`. Shell `cd` moves python's cwd since `e6b6f0f`.
