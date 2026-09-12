# The header and pane buttons

Every `<button id=…>` in `apps/anvil/index.html`. Their handlers are the desktop's command surface;
the ⋯ sheet (`sheet.md`) calls the same ones on narrow layouts. Shared prerequisites: the launch in
`../README.md`; a desktop-width viewport unless the recipe says otherwise.

### button:ws
- **Goal:** the workspace chip names the store and explains Browser / Folder / Crate on click.
- **Source:** `#ws` → `openStorageInfo`.
- **Prerequisites:** launch; any viewport.
- **Reach and drive:** read the chip's text; click it.
- **Observable success:** the text names the current store (`memory · scratch` on a fresh browser project); the preview explains the three.
- **Gotchas:** none.

### button:open-folder
- **Goal:** point the agent at a real folder (FSA).
- **Source:** `#open-folder` → `showDirectoryPicker` through `naklios.fs` or FSA.
- **Prerequisites:** launch; a visible, focused desktop tab (the picker needs user activation).
- **Reach and drive:** click with the tab visible and focused.
- **Observable success:** the picker opens; after a pick the chip reads `folder` and files list. Hidden/unfocused tab → refused (picker-gated rung).
- **Gotchas:** ATTENDED.

### button:toggle-preview
- **Goal:** show/hide the preview pane.
- **Source:** `#toggle-preview`.
- **Prerequisites:** launch; desktop.
- **Reach and drive:** click twice.
- **Observable success:** the pane's visibility flips each time; the log pane resizes.
- **Gotchas:** none.

### button:new-project
- **Goal:** create a project.
- **Source:** `#new-project`.
- **Prerequisites:** launch; desktop.
- **Reach and drive:** click; name it.
- **Observable success:** a new project in the list with one empty task; a fresh browser project is seeded with the `working-in-anvil` skill.
- **Gotchas:** none.

### button:hooks-chip
- **Goal:** open the Hooks pane; dimmed until the project has hooks.
- **Source:** `#hooks-chip` → `openHooks`.
- **Prerequisites:** launch; desktop; `__anvil.test.fs` to seed `.anvil/hooks.json`.
- **Reach and drive:** click before and after seeding `.anvil/hooks.json`.
- **Observable success:** dimmed → lit after the seed; the pane shows the rules.
- **Gotchas:** the dim state is computed on load/refresh.

### button:skills-chip
- **Goal:** open the Skills reader; dimmed until the project has skills.
- **Source:** `#skills-chip` → `openSkills`.
- **Prerequisites:** launch; desktop.
- **Reach and drive:** click.
- **Observable success:** the reader as in `sheet:skills`.
- **Gotchas:** none.

### button:mem-chip
- **Goal:** open the memory reader; dimmed until the project has memory.
- **Source:** `#mem-chip` → `openProjectMemory`.
- **Prerequisites:** launch; desktop.
- **Reach and drive:** click.
- **Observable success:** the reader as in `sheet:memory`.
- **Gotchas:** none.

### button:files-scope
- **Goal:** the files pane lists this project only, or the whole store.
- **Source:** `#files-scope` (hidden unless the store has more than one project).
- **Prerequisites:** launch; desktop; a store with two projects.
- **Reach and drive:** with two projects, click to toggle.
- **Observable success:** the label flips `proj` ↔ `all`; the file list widens to the whole store and back.
- **Gotchas:** hidden on a single-project store — not a defect.

### button:learn-btn
- **Goal:** the read-only priming pass (same as `sheet:learn`).
- **Source:** `#learn-btn` → `primeProject`.
- **Prerequisites:** launch; desktop; an endpoint granted (one run of fuel).
- **Reach and drive:** click with an endpoint granted.
- **Observable success:** a priming run in ask mode; facts recorded.
- **Gotchas:** fuel.

### button:home-chip
- **Goal:** pick the Anvil home folder (same as `sheet:home`).
- **Source:** `#home-chip`.
- **Prerequisites:** launch; a visible, focused desktop tab.
- **Reach and drive:** click with the tab visible and focused.
- **Observable success:** the picker; then durable records under the folder.
- **Gotchas:** ATTENDED.

### button:refresh-files
- **Goal:** re-list the workspace.
- **Source:** `#refresh-files` → `renderFiles`.
- **Prerequisites:** launch; desktop.
- **Reach and drive:** write a file through `__anvil.test.fs`, click.
- **Observable success:** the new file appears in the pane.
- **Gotchas:** none.

### button:new-task
- **Goal:** a new task in the project.
- **Source:** `#new-task`.
- **Prerequisites:** launch; desktop.
- **Reach and drive:** click.
- **Observable success:** a new task row, selected, mode `code`, no gate.
- **Gotchas:** none.

### button:gate-btn
- **Goal:** set the task's verify command (✓ Must-pass) with the authoring hint.
- **Source:** `#gate-btn` → `askText({title:'Gate command'…})`; `GATE_AUTHORING_HINT`.
- **Prerequisites:** launch; desktop; an active task.
- **Reach and drive:** click; read the dialog; enter `python .anvil/gate/test_x.py`; confirm.
- **Observable success:** the dialog text carries `GATE_AUTHORING_HINT` (assert the type as well as the value; test more than one case; the lint's three refusals named); after confirming, the ✓ chip shows the command and `__anvil.test.taskState().verifyCmd` equals it.
- **Gotchas:** setting the command does not author or lint a criterion — that is `hook:armGate` (test-door.md); a run with this command and no file under `.anvil/gate/` fails its gate with a not-found, which is the honest outcome.

### button:adv-btn
- **Goal:** the Advanced menu opens and exposes the experimental items.
- **Source:** `#adv-btn` (`aria-haspopup`, `aria-expanded`).
- **Prerequisites:** launch; desktop.
- **Reach and drive:** click; press Escape.
- **Observable success:** `aria-expanded` flips; the menu lists `campaign-btn`; Escape closes and restores focus.
- **Gotchas:** none.

### button:campaign-btn
- **Goal:** start a Proof build (Assay campaign).
- **Source:** `#campaign-btn` → `startCampaign`.
- **Prerequisites:** launch; desktop; an endpoint for a live campaign, none for the demo.
- **Reach and drive:** Advanced → click.
- **Observable success:** the campaign dialog; a demo (offline) run reaches a verdict; a live one needs an endpoint.
- **Gotchas:** beta.

### button:stop
- **Goal:** stop the run at the next boundary; members in flight drain.
- **Source:** `#stop` → `stopRun` → `abortController.abort()`.
- **Prerequisites:** launch; desktop; an endpoint; a prompt that takes several tool steps.
- **Reach and drive:** start a multi-step run; click Stop during a tool call.
- **Observable success:** the record ends `stop:'aborted'`; the log says `agent stopped · N steps`; the task's `lastStop` is `'aborted'` (`'interrupted'` is the boot-time reconcile for a task still running when Anvil last closed) and the next Send holds once with a visible reason (AC-8a).
- **Gotchas:** an in-flight tool is not force-killed; its result is recorded if it was already running (F9).

### button:send
- **Goal:** send the prompt; while a run is in flight, queue it.
- **Source:** `#send` → `submit`; `qEnqueue`, `admitRun`.
- **Prerequisites:** launch; desktop; an endpoint.
- **Reach and drive:** send a prompt; send a second one while the first runs; then, in a task whose last three runs ended in error (seed with three runs against a revoked endpoint grant), press Send once more.
- **Observable success:** the first starts a run; the second appears in the queue and runs after the first ends; the fourth Send in the three-failures task is held with a visible reason and the prompt kept (AC-8a); a second press runs it.
- **Gotchas:** Enter sends; Shift+Enter is a newline.

### button:mode-btn
- **Goal:** cycle code → plan → ask; the toolset and the system note follow the mode.
- **Source:** `#mode-btn` → `setModeBtn`/`syncMode`; `runToolset(mode)`; `MODE_NOTE`.
- **Prerequisites:** launch; desktop; `cfg.js` seeded; an endpoint.
- **Reach and drive:** click to `plan`; send "Change v to 2 in cfg.js".
- **Observable success:** the label and `aria-label` read `Mode: plan`; the run's `run.started` tools are the plan set (`read`, `todowrite`, `clarify`, `history`, `context_remaining`, `skill`, `recall`); a `write` the model names anyway is refused `not available in plan mode`; `cfg.js` unchanged.
- **Gotchas:** the mode is per task.

### button:pv-revert
- **Goal:** undo the previewed change from its pre-image.
- **Source:** `#pv-revert` → `planRevert` (`sys/ai/change-preimages.mjs`).
- **Prerequisites:** launch; desktop; a finished run that edited a file with a pre-image.
- **Reach and drive:** after a run that edited `cfg.js`, open its change row; click Revert.
- **Observable success:** `cfg.js` reads its pre-image; the row shows reverted.
- **Gotchas:** hidden until a change with a pre-image is previewed; the pre-image budget (`MAX_PREIMAGE_BUDGET`) prunes old ones.

### button:pv-close
- **Goal:** close the preview.
- **Source:** `#pv-close`.
- **Prerequisites:** launch; desktop; the preview open.
- **Reach and drive:** click.
- **Observable success:** the preview pane hides; focus returns.
- **Gotchas:** none.

### button:drawer-btn
- **Goal:** on tablet, slide the projects & files drawer over the centre.
- **Source:** `#drawer-btn` (`aria-controls="left"`, `aria-expanded`); `closeDrawer`.
- **Prerequisites:** launch; a tablet viewport (`resize_window` tablet).
- **Reach and drive:** tablet viewport; click; click a task in the drawer.
- **Observable success:** `aria-expanded` flips; the scrim appears; choosing a task closes the drawer.
- **Gotchas:** hidden on desktop and phone.

### button:more-btn
- **Goal:** open the ⋯ sheet on phones.
- **Source:** `#more-btn` → `openSheet`; Escape → `closeSheet`.
- **Prerequisites:** launch; a phone viewport (`resize_window` mobile).
- **Reach and drive:** phone viewport; click; press Escape.
- **Observable success:** the sheet opens with focus on its first row and `aria-expanded="true"`; Escape closes it and returns focus to ⋯.
- **Gotchas:** hidden on desktop.

## The phone bar and the surface switcher (no ids — keyed by class and `data-surface`)

### button:.mb-title
- **Goal:** on a phone, the bar's title is the task switcher.
- **Source:** `#mobilebar .mb-title` → `setSurface('tasks')`.
- **Prerequisites:** launch; a phone viewport; two tasks.
- **Reach and drive:** tap the title.
- **Observable success:** the tasks surface shows; picking a task returns to chat with that task active (`taskState().id` changes).
- **Gotchas:** shows "No task" with none; hidden on desktop.

### button:.mb-verify
- **Goal:** the phone's ✓ Must-pass — the same gate dialog as `button:gate-btn`.
- **Source:** `#mobilebar .mb-verify` → `$('gate-btn').onclick`.
- **Prerequisites:** launch; a phone viewport; an active task.
- **Reach and drive:** tap ✓ Must-pass; enter a command.
- **Observable success:** the Gate command dialog with the authoring hint; `taskState().verifyCmd` set.
- **Gotchas:** none beyond `button:gate-btn`'s.

### button:.mb-stop
- **Goal:** the phone's Stop.
- **Source:** `#mobilebar .mb-stop` → `stopRun`; shown only while a run is in flight.
- **Prerequisites:** launch; a phone viewport; an endpoint; a multi-step prompt.
- **Reach and drive:** send; tap ◼ Stop while a tool runs.
- **Observable success:** the record ends `stop:'aborted'`; the button hides again.
- **Gotchas:** `display:none` until a run starts — not a missing control.

### button:tab-chat
- **Goal:** the switcher's Chat tab shows the log and composer.
- **Source:** `.swtab[data-surface="chat"]` → `setSurface('chat', true)`.
- **Prerequisites:** launch; a phone or tablet viewport.
- **Reach and drive:** tap Preview, then Chat.
- **Observable success:** `aria-pressed="true"` moves to the Chat tab; `#prompt` is visible.
- **Gotchas:** hidden on desktop (all three surfaces are side by side).

### button:tab-preview
- **Goal:** the switcher's Preview tab shows the preview pane (changes, readers, storage).
- **Source:** `.swtab[data-surface="preview"]`.
- **Prerequisites:** launch; a phone or tablet viewport; a finished run with a change.
- **Reach and drive:** tap Preview.
- **Observable success:** `aria-pressed="true"` on Preview; the change row or the last opened reader is visible.
- **Gotchas:** a raised preview (`raise('preview')`) switches here on its own on phones.

### button:tab-files
- **Goal:** the switcher's Files tab shows the workspace listing.
- **Source:** `.swtab[data-surface="files"]`.
- **Prerequisites:** launch; a phone or tablet viewport; a seeded file.
- **Reach and drive:** tap Files.
- **Observable success:** `aria-pressed="true"` on Files; the seeded file is listed.
- **Gotchas:** none.

### button:.es-chip
- **Goal:** an empty-state example chip fills the composer with a starter prompt.
- **Source:** the empty-state markup at the `es-egs` block in `apps/anvil/index.html` (chips rendered from `examples`, `data-i`), its click handler.
- **Prerequisites:** launch; a fresh project with an empty task (the empty state showing).
- **Reach and drive:** click the first "Try:" chip.
- **Observable success:** `#prompt` contains the chip's text; nothing is sent.
- **Gotchas:** the chips are generated, not static markup — the drift check keys this surface by its class, so a change to the chips' text is not drift; their existence is.
