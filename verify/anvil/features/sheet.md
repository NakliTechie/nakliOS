# The ⋯ sheet

The phone-and-tablet home for the header's orphaned controls: eleven rows, each `data-act`, wired in
`apps/anvil/index.html` (`#sheet .sheet-row` → `row.dataset.act`). Every row calls the same handler
the desktop control does, so a row's pass is the desktop control's pass on a narrow layout. Shared
prerequisites: the launch in `../README.md`; a narrow viewport (≤ 978 px, `resize_window` mobile) so
`#more-btn` is visible; open the sheet with ⋯.

### sheet:open-folder
- **Goal:** the same as the `Open folder` button — point the agent at a real disk folder.
- **Source:** `data-act="open-folder"` → `call('open-folder')`.
- **Prerequisites:** narrow layout; a visible, focused tab (the picker needs user activation).
- **Reach and drive:** ⋯ → 📁 Open folder…
- **Observable success:** the directory picker opens; on a hidden or unfocused tab it is refused — that is the picker-gated rung (`pending.md`), not a sheet defect.
- **Gotchas:** ATTENDED — cannot be driven headless.

### sheet:storage
- **Goal:** where this workspace is stored and what Browser / Folder / Crate mean.
- **Source:** `data-act="storage"` → `openStorageInfo()`; the `#sheet-store` sub-label.
- **Prerequisites:** narrow layout.
- **Reach and drive:** ⋯ → 🗄 Storage.
- **Observable success:** the preview pane opens with the storage explanation; the row's sub-label names the current store (`memory · scratch` / `folder` / `crate`).
- **Gotchas:** raises the preview surface on phones.

### sheet:campaign
- **Goal:** the Proof build (Assay campaign) starts as from the Advanced menu.
- **Source:** `data-act="campaign"` → `call('campaign-btn')`.
- **Prerequisites:** narrow layout.
- **Reach and drive:** ⋯ → ⚑ Proof build.
- **Observable success:** the campaign dialog/pane appears (same as `button:campaign-btn`).
- **Gotchas:** beta; needs an endpoint for a live campaign.

### sheet:memory
- **Goal:** open the project memory reader.
- **Source:** `data-act="memory"` → `openProjectMemory()`.
- **Prerequisites:** narrow layout; a project with ≥ 1 fact for a non-empty view.
- **Reach and drive:** ⋯ → 🧠 Project memory.
- **Observable success:** the reader lists the facts with statuses in the preview pane.
- **Gotchas:** an empty project shows the empty state, not nothing.

### sheet:skills
- **Goal:** open the Skills reader.
- **Source:** `data-act="skills"` → `openSkills()`.
- **Prerequisites:** narrow layout.
- **Reach and drive:** ⋯ → ✨ Skills.
- **Observable success:** each skill renders as a document with its frontmatter block, status and lint notes; an empty list offers the `working-in-anvil` seed.
- **Gotchas:** activation controls are in this reader.

### sheet:hooks
- **Goal:** open the Hooks pane.
- **Source:** `data-act="hooks"` → `openHooks()`.
- **Prerequisites:** narrow layout.
- **Reach and drive:** ⋯ → ⚓ Hooks.
- **Observable success:** the pane shows `.anvil/hooks.json`'s parsed rules (or the empty state).
- **Gotchas:** none.

### sheet:policy
- **Goal:** open the Policy pane — standing permissions and the mode.
- **Source:** `data-act="policy"` → `openPolicy()`; the `#sheet-policy` sub-label; `sys/ai/action-policy.mjs`, `permission-rules.mjs`.
- **Prerequisites:** narrow layout.
- **Reach and drive:** ⋯ → 🛡 Policy.
- **Observable success:** the pane lists granted/revoked actions and the permission mode; a standing grant given from a run's "Always allow" appears here and can be revoked.
- **Gotchas:** the sub-label shows the mode when it is loud (`modeIsLoud`).

### sheet:window
- **Goal:** set the configured model's context window, which sizes the budget and the next run's carried transcript (X1).
- **Source:** `data-act="window"` → `setContextWindow()` → `state.contextWindows[aiModel]`; `resolveWindow()`; `carryLimits` in `sys/ai/context-budget.mjs`.
- **Prerequisites:** narrow layout; a model configured in NakliOS Settings → AI (`capabilities.aiModel`).
- **Reach and drive:** ⋯ → 📏 Context window → enter `128k` → Save.
- **Observable success:** a system row names the window and the carry threshold (`~63,000 tokens` for 128k); `context_remaining` reports `set by you for <model>`; an empty value clears it.
- **Gotchas:** with no model configured it says so and changes nothing; a value outside 1,000–10,000,000 is refused.

### sheet:learn
- **Goal:** start the read-only "Learn this project" pass.
- **Source:** `data-act="learn"` → `primeProject()`.
- **Prerequisites:** narrow layout; an endpoint.
- **Reach and drive:** ⋯ → 🎓 Learn from this project.
- **Observable success:** a priming run starts in ask mode with `rememberTool`; its tool calls show in the log; facts land under `.anvil/memory`.
- **Gotchas:** fuel — one run.

### sheet:home
- **Goal:** pick the Anvil home folder where run records are kept durably.
- **Source:** `data-act="home"` → `call('home-chip')`.
- **Prerequisites:** narrow layout; a visible, focused tab.
- **Reach and drive:** ⋯ → 🗄 Anvil home folder.
- **Observable success:** the directory picker opens; records are then written under `anvil/runs/…` in that folder (the resilience ladder: OPFS → home → Crate).
- **Gotchas:** ATTENDED (picker); the 0.1 rung in `pending.md`.

### sheet:foreign
- **Goal:** inspect selected, read-only local-agent transcript copies without merging them into Anvil's own run chain.
- **Source:** `data-act="foreign"` → `openForeignArchive()`; the foreign archive stores in `apps/anvil/index.html`.
- **Prerequisites:** narrow layout, an empty disposable archive, and synthetic Claude and Codex JSONL fixtures with known importable row counts. No active Anvil task is required.
- **Reach and drive:** open ⋯ → Imported conversations; select one fixture file per source; search the copied entries, filter by provider and project, reload, then forget one source.
- **Observable success:** the stored count matches each fixture's expected importable rows after metadata-only, malformed, oversized, and repeated lines are excluded. Common credential patterns are redacted in displayed text. Search and filters select matching entries after reload. Forget removes only that source's local copy; the selected input file remains unchanged.
- **Gotchas:** ATTENDED (native file picker); a local result does not establish deployed behavior. Imported records are untrusted evidence. Unrecognized secrets may remain in this browser. Raw text stays separately labeled and source deletion affects only the copied archive. A personal transcript requires an owner-selected file.
