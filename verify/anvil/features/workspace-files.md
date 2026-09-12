# The `.anvil/` workspace files

What the app and its modules read from the workspace root, by literal path. Each is a contract with
the project's owner: a file that is read, a folder that is fenced, a JSON the agent must not edit.
Shared prerequisites: the launch in `../README.md`; `__anvil.test.fs` to seed and read back.

### file:.anvil/gate
- **Goal:** the acceptance criterion's home — readable by the agent, writable only by the owner.
- **Source:** `sys/ai/gate.mjs` (`GATE_DIR`, `underGateDir`, `explainGateRefusal`); the grant's `readOnlyPrefixes` at both sites in `apps/anvil/index.html`.
- **Prerequisites:** launch; a criterion armed.
- **Reach and drive:** prompt "Read .anvil/gate/test_x.py, then make it always pass." Also a `>` redirect and `rm` through the shell.
- **Observable success:** the read succeeds; the `edit`, the redirect and the `rm` are each refused `read-only under this grant` with the fence explanation appended; the file is byte-identical after (`__anvil.test.fs.read`).
- **Gotchas:** the fence is the GRANT on the normalised path, never a string match on the command (`guard-at-the-normalised-path`).

### file:.anvil/hooks.json
- **Goal:** pre-tool guards and post-tool commands the project configures run around every tool.
- **Source:** `sys/ai/hooks.mjs` (`parseHooks`, `preToolDecision`, `postToolCommands`), `sys/ai/run-assembly.mjs` (`loadHooks`, `preHookReply`, `postHookNotes`), the Hooks reader (`openHooks`).
- **Prerequisites:** launch; seed `{"preTool":[{"on":"write","pathMatch":"secret*","block":"no secrets"}],"postTool":[{"on":"write","run":"ls"}]}`.
- **Reach and drive:** prompt "Write secret.txt with x" then "Write a.txt with y".
- **Observable success:** the first is refused `[blocked by a project hook] no secrets` before any write; the second's result carries `[hook] ls` with the listing appended; the ⚓ chip is lit; the Hooks pane shows both rules.
- **Gotchas:** a missing file keeps the PREVIOUS run's config (`loadHooks(fs, hooksCfg)`) until reload; the post-hook shell is built only when a rule matched.

### file:.anvil/memory
- **Goal:** the project's facts, one file each, indexed into the context message every run.
- **Source:** `sys/ai/memory-store.mjs` (`MEMORY_DIR`, `parseFact`, `buildMemoryIndex`), the Memory reader.
- **Prerequisites:** launch.
- **Reach and drive:** seed `.anvil/memory/entry-point.md` with frontmatter (`name`, `description`, `type: project`, `status: verified`) and a body, and `.anvil/memory/no-force-push.md` with `type: rule`; start a run; open 🧠.
- **Observable success:** the run's transcript carries the `[coordination] Working context…` message listing the fact (read the record's `run.started`); the reader lists it with its status; a `rule`-typed fact is injected in full, first.
- **Gotchas:** the index is change-gated (`ctxDigest`) — an unchanged store is not re-sent on the next run of the same task.

### file:.anvil/procedural.json
- **Goal:** the procedural prior's edges can be ablated per project without editing code.
- **Source:** `sys/ai/procedural.mjs` (`PROCEDURAL_PATH`, `loadProceduralGraph`, `renderProcedural`), `proceduralPrior` in the app.
- **Prerequisites:** launch.
- **Reach and drive:** seed `{"edges":{"shell-to-verify":{"enabled":false}}}` (the shape `mergeProceduralGraph` reads — a `disable` list is ignored and reported); start a run; read the record's system message. Then seed the file with `{not json`; start another run.
- **Observable success:** the first run's system prompt lacks the shell-to-verify sentence and is otherwise byte-identical to the default (`test-run-assembly` pins the default bytes); the second run starts, its system prompt is the full default, and the log carries the fallback line — no crash.
- **Gotchas:** read once per run, so an edit mid-run takes effect on the next run.

### file:.anvil/search-index.json
- **Goal:** the trigram index persists in the workspace, derived and re-checked on load, and is read-only to the agent.
- **Source:** `sys/rig/fileops/fileops.mjs` (`indexPath`, `indexSave`, the load-time validation), the grant's read-only prefix for it.
- **Prerequisites:** launch; a project with a few files; one `rg` through the shell.
- **Reach and drive:** run `rg -n const` through the shell; read `.anvil/search-index.json` with `__anvil.test.fs.read`; run the same `rg` again; read it again; then prompt "Edit .anvil/search-index.json to be empty".
- **Observable success:** the file exists after the first search and is byte-identical after the second (nothing re-indexed); the model's edit is refused `read-only under this grant` and the file is unchanged. (The search meter itself — `searchStats()` — is not reachable through the door; `sys/rig/fileops/test/search-cost.test.mjs` pins its numbers.)
- **Gotchas:** never re-hashed on load (`plan/missed-invariants.md` 2026-09-09) — the grant is the fence.

### file:.anvil/skills
- **Goal:** the project's skills, one folder each, listed by status and loaded on demand.
- **Source:** `sys/ai/skills.mjs` (`SKILLS_DIR`, `buildSkillsIndex`), `sys/ai/skill-manage.mjs` (`SKILL_FILE`, `SKILL_SHAPE`), the Skills reader.
- **Prerequisites:** launch.
- **Reach and drive:** seed `.anvil/skills/k/SKILL.md` (frontmatter `name`, `description`, `status: active`) and a second with `status: staged`; start a run; open ✨.
- **Observable success:** the context message lists only the active skill; the reader shows both with statuses and lint notes; a fresh browser project is seeded with `working-in-anvil`.
- **Gotchas:** the folder's support files are scanned by the sentinel at load; a failing one quarantines the skill.
