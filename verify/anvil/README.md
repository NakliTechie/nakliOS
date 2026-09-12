# Verify Anvil — the feature map

One recipe per surface Anvil exposes, and a check that fails when a surface has no recipe
(`node scripts/verify-inventory.mjs`; `--write` rebaselines after you have read the drift). The
surfaces are enumerated from the code — the tools the model is handed in every mode, the
`__anvil.test` door, the `.anvil/` files the app reads, the ⋯ sheet and the header buttons — and
`inventory.json` maps each to the file that owns its `### <surface>` recipe. A recipe has six
fields (bb's shape, read 2026-09-12): **Goal · Source · Prerequisites · Reach and drive ·
Observable success · Gotchas**. A pass on a node lane is not a pass here: these are the app's own
doors, driven in a browser or through the test door, and the run record is the evidence.

## Launch (shared by every recipe)

The recipe from `plan/bench-playbook.md` and the memory `drive-the-real-app-for-app-claims`:

1. `node scripts/serve-coi.mjs` and open the host (this repo's root `index.html`) in the in-app
   Browser pane or Chrome — the COI headers are what make Kiln's `python` run; a plain static serve
   cannot exercise a python gate.
2. On the host origin seed `nakliOS.aiSettings.v1` (a `custom` endpoint you control — hermes proxy
   `http://127.0.0.1:8645/v1` for cheap checks, DeepSeek as configured for real runs, **never a local
   Ollama model**) and `nakliOS.aiPermissions.v1` granting `local-endpoint:<base>` to `anvil`; set
   `localStorage['anvil-test']='1'`; reload; `openApp(APPS.find(a=>a.id==='anvil'))`.
3. The iframe is same-origin: `iframe.contentWindow.__anvil.test` is the door; `#prompt` and `#send`
   are in its document. Run records land in the iframe's OPFS at `anvil/runs/<project>/<task>/<ts>.json`
   — read the record, not the DOM, for anything the loop did.
4. Reload after editing a module (the run uses the old code otherwise). Clean the workspace root
   between tasks (empty dirs survive `fs.remove` on files). Validate a gate criterion red-on-seed and
   green-on-reference in CPython before arming it.

Evidence for a pass: the record's stop (`foldStatus`), the file bytes read back through
`__anvil.test.fs.read`, the tool result the model saw (from the record), and a screenshot where the
surface is visual. Mark each recipe `passed` / `failed` / `not run` / `blocked` with the reason;
an unexecuted recipe is never a pass by source reading.

## Files

| file | surfaces |
|---|---|
| `features/tools-files.md` | read · edit · write · apply_patch · todowrite · shell |
| `features/tools-loop.md` | clarify · task · dispatch · review · task_done |
| `features/tools-store.md` | remember · recall · revise · skill · skill_manage · learn_this_run · history · context_remaining · checkpoint · synthesize |
| `features/test-door.md` | the 12 `__anvil.test.*` hooks |
| `features/workspace-files.md` | the 6 `.anvil/` files |
| `features/sheet.md` | the 9 ⋯ sheet actions |
| `features/header.md` | the 22 header and pane buttons |
