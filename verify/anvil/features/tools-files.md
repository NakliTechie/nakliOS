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
- **Reach and drive:** (a) seed `cfg.js` = `const v = 1;\n// const v = 1;\n` (the text occurs twice) and ask "Change the first `const v = 1;` in cfg.js to 2" on a fresh task — the model must read first. (a2) "Change `// const v = 1;` to `// const v = 2;` in cfg.js" — that old_string occurs exactly once, so the edit applies with no read (2026-09-24). (b) After a read, rewrite the file behind the tools (`__anvil.test.fs.write('cfg.js','const v = 1;\nconst w = 2;\n')`), then prompt "Change v to 3 in cfg.js" and watch the first edit.
- **Observable success:** (a) an `edit` without a prior `read` whose old_string is ambiguous is refused with "has not been read yet"; after the read, `Edited cfg.js (1 replacement, exact match) — now at line 1:` and the file reads `const v = 2;`. (a2) the unread exact-once edit applies and its result shows the edited line. (b) the first `edit` is refused `Refused: cfg.js is stale — …`, classified `rejected` in the record; the model re-reads; the next edit applies over the shell's content.
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
- **Goal:** execute supported workspace commands and report their output, actual exit status, and optional prediction grade.
- **Source:** `sys/rig/cli/shell.mjs`, `sys/ai/agent-tools.mjs`, `sys/ai/agent-loop.mjs`, and Anvil's actual `executeTool` wrapper.
- **Prerequisites:** a named disposable workspace and a configured inference endpoint for the model-driven replay.
- **Reach and drive:** ask the agent to execute these commands through its shell tool:

```sh
printf 'a\n' > cfg.js
sed -i.bak 's/a/b/' cfg.js
grep -r b .
cat cfg.js.bak
cat <<'EOF' > literal.txt
$HOME $(echo literal)
EOF
for n in one two; do printf '%s\n' "$(echo $n)" >> loop.txt; done
tar -cf check.tar cfg.js loop.txt
gzip -c check.tar > check.tar.gz
gunzip -c check.tar.gz > restored.tar
mkdir unpacked
tar -xf restored.tar -C unpacked
mkdir disposable
printf x > disposable/to-delete
find disposable -type f -exec rm {} \;
```

- **Observable success:** `cfg.js` contains `b`, its backup contains `a`, the literal file preserves expansion syntax, and `loop.txt` contains both lines.
- **Archive evidence:** extracted files match their source bytes; restored tar bytes match the original archive.
- **Staging evidence:** find-exec removal reports a real confirmation receipt, removes its target, and leaves no pending proposals.
- **Stop check:** run `sleep 30; printf late > after-stop`, press Stop during sleep, and verify that `after-stop` remains absent.
- **Recovery check:** a subsequent independent `echo NEXT` succeeds with no queued writes or pending confirmations.
- **Authority check:** owner deny rules, file grants, pre/post hooks, and protected skill/gate/index paths still govern supported edits.
- **Refusal check:** unsupported flags fail explicitly; unsupported `perl -i` and `awk -i inplace` hints contain no fabricated exit or prediction grade.
- **Parameter check:** a call using `cmd` instead of `command` names the required parameter without running anything or inventing an exit code.
- **Optional runtime check:** with an authorized Kiln runtime, `python -c 'print(1+1)'` prints `2`; SQLite reports explicit availability requirements when absent.
- **Gotchas:** the tool renders shell stdout/stderr together; pipes carry stdout only. Oversized output spills to `.forge/out-N.txt` with a pointer.
- **Evidence:** `scripts/test-anvil-unix-integration.mjs` executes real handlers; the retained shell integration suite checks expanded permissions and cancellation boundaries.
- **B6 structured listings (2026-09-17):** `ls -R` prints directory blocks (`src:` then one entry a line, a blank line between blocks — what coreutils prints to a pipe), never the old flat run of names; a listing (`ls`, `ls -R`, `find`) over 500 entries is cut at the terminal with `[listing truncated: 500 of N entries shown — narrow the path, add -name / -maxdepth, or pipe through grep]` — never inside a pipe (`find … | wc -l` counts every entry). The tool row's tag reads `listing · N entries` or `listing · 500 of N entries (truncated)` (the loop derives it from the text, like a failure `kind`); compaction collapses a stale listing to its real count, including one that was cut. Drive it: a workspace with 600 files, "Run `find . -type f`", then "Run `find . -type f | wc -l`" — the first ends in the trailer with the tag `listing · 500 of 600 entries (truncated)`, the second prints `600`. Also `sleep SECONDS` exists (2026-09-17; capped at 300 s; Stop interrupts it and ends the line). `cd` refuses a missing target or a file (`cd: x: No such file or directory`, exit 1) and stays put — it used to move anywhere and exit 0, so `cd w` twice landed in `w/w` and everything after failed ENOENT (live prod 2026-09-17); bare `cd` returns to the workspace root.
