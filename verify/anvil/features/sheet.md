# The ⋯ sheet

The phone-and-tablet home for the header's orphaned controls: nine rows, each `data-act`, wired in
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
