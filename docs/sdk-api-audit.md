# SDK API audit — `sdk/naklios.js`

*The ledger, not the manual: status and stabilization criteria per member. The member reference in
[`docs/app-contract.md`](app-contract.md) (the one SDK document) is rendered from this table by
`node scripts/sdk-reference.mjs --write`, and the gate is red when the two disagree.*

Every member of the public surface (`window.naklios`, walked to depth 3 by `scripts/sdk-surface.mjs`
after running the SDK standalone) has one line here: its kind, its status, and — for an experimental
member — the criteria that stabilize it. `scripts/test-sdk-audit.mjs` reads the SDK and this table and
goes red on a member with no line, a line with no member, or an `experimental_` member with no
criteria. The pattern is bb's (`docs/api_to_audit.md`, read 2026-09-12): a new public member ships
under an `experimental_` prefix and an entry naming what stabilizes it; stabilizing is the audit, a
rename across every consumer (the five inline-SDK apps re-splice the canonical copy), and the entry
becoming `stable`. Read `docs/app-contract.md` for the contract each member belongs to.

**The rule (from 2026-09-12; the SDK's own banner will carry it at its next byte change — this item
changed no SDK bytes):** a new public member is `experimental_<name>` with a line here whose criteria
column says what must be true to drop the prefix. Consumers vendor the canonical file; a prefix
rename is a fleet change and is done once, in the audit.

Status today: every member below is `stable` by grandfathering — all shipped before this ledger
existed. Most are in use by the vendored apps (Books, VaultMind, Tijori, KanZen, NakliPoster) or the
host's own system apps; four (`net.available`, `net.info`, `ai.searchStatus`, `ai.cancelAll`) have no
app consumer yet and say so in their note. The first `experimental_` member was `fs.experimental_autosave`
(2026-09-24); it walked the checklist below the same day and is now `fs.autosave`. No member carries the
prefix today.

| member | kind | status | criteria (experimental only) | note |
|---|---|---|---|---|
| `version` | field | stable | — | The SDK's own protocol version constant (2); nothing compares it today — `ready()` sends feature flags, not this. |
| `capabilities` | namespace | stable | — | What the host has granted; mutated in place — read fields directly, or subscribe. |
| `capabilities.hosted` | field | stable | — | Set at construction: embedded in a frame, or `?naklios` present. Never rewritten by the host's messages. |
| `capabilities.flagged` | field | stable | — | `?naklios` was present — a hint, never a transport switch. |
| `capabilities.version` | field | stable | — | A constant 2 in the SDK, never set from a host message. |
| `capabilities.fs` | field | stable | — | App-scoped filesystem available (Folder or Crate connected). |
| `capabilities.fsBackends` | field | stable | — | The backends the host offers, as descriptors `[{ id, label, name }]` — ids `fsa` (a picked folder) and `crate`; the browser's own OPFS is not on this list. |
| `capabilities.fsBackend` | field | stable | — | The backend in use. |
| `capabilities.fsBoundedReads` | field | stable | — | True when the active host storage backend supports a byte-limited read. |
| `capabilities.fsRangeReads` | field | stable | — | True when the active host Folder backend supports explicit bounded byte ranges. |
| `capabilities.system` | field | stable | — | The app is a system app (same-origin, `kind: system`). |
| `capabilities.sysFs` | field | stable | — | Whole-store filesystem granted (system apps only). |
| `capabilities.ai` | field | stable | — | Shared host inference granted. |
| `capabilities.aiModel` | field | stable | — | Configured chat model id, or null. |
| `capabilities.aiModelLabel` | field | stable | — | Human label for it. |
| `capabilities.aiProvider` | field | stable | — | Provider of the chat model. |
| `capabilities.aiLocal` | field | stable | — | The chat model runs on-device. |
| `capabilities.aiState` | field | stable | — | `idle` (standalone default) · `loading` · `ready` · `error`, as the host sets it. |
| `capabilities.aiImages` | field | stable | — | Image generation granted. |
| `capabilities.aiImageModel` | field | stable | — | Configured image model id, or null. |
| `capabilities.aiImageModelLabel` | field | stable | — | Human label for it. |
| `capabilities.aiImageProvider` | field | stable | — | Provider of the image model. |
| `capabilities.aiImageLocal` | field | stable | — | The image model runs on-device. |
| `capabilities.aiImageState` | field | stable | — | State of the image runtime. |
| `capabilities.aiSearchState` | field | stable | — | State of the local semantic-search rung (`idle` · `loading` · `ready` · `error`). |
| `capabilities.aiSearch` | field | stable | — | Semantic (local, embedding) search over the app's own namespace granted — not web search. |
| `capabilities.experimental_tex` | field | experimental | As `experimental_tex`. | The app may compile LaTeX projects in its own storage. |
| `capabilities.net` | field | stable | — | Sovereign egress (`naklios.net.fetch`) granted. |
| `capabilities.netBackend` | field | stable | — | Which egress backend the host is configured with: `worker` (the default) · `bridge`; null when none. Never a package name. |
| `capabilities.review` | field | stable | — | The host can stage native diffs from this app and return source-bound review decisions. Enabled for Reckon, Draft, and KanZen. |
| `ready` | function | stable | — | Signal "loaded"; carries the feature flags this SDK build supports. |
| `title` | function | stable | — | Set the host window title. |
| `close` | function | stable | — | Ask the host to close this window. |
| `openSettings` | function | stable | — | Open the host Settings at a section (`ai`, `storage`, …). |
| `beforeClose` | function | stable | — | Register a callback the host awaits before closing (ack protocol). |
| `theme` | namespace | stable | — | Host theme. |
| `theme.current` | getter | stable | — | The last theme the host sent. |
| `theme.onChange` | function | stable | — | Subscribe; called at once when a theme has already arrived; returns an unsubscribe. |
| `theme.request` | function | stable | — | Ask the host to re-send the theme. |
| `onCapabilitiesChange` | function | stable | — | Subscribe to capability changes; replays the current set at registration. |
| `requestCapabilities` | function | stable | — | Ask the host to re-broadcast capabilities. |
| `review` | namespace | stable | — | Host-owned staging queue and person review bridge. The P0 app contract names this stable namespace directly. |
| `review.stage` | function | stable | — | Send a native diff without applying it. Returns a proposal ID; standalone returns a fallback marker. |
| `review.onDecision` | function | stable | — | Register one app decision handler. The SDK acknowledges a successful commit once and re-acknowledges replays without reapplying. |
| `fs` | namespace | stable | — | App-scoped filesystem (paths under `apps/<id>/`). |
| `fs.read` | function | stable | — | Read text. |
| `fs.readBinary` | function | stable | — | Read bytes; Folder offsets require an explicit bounded cap. |
| `fs.supportsBoundedReads` | getter | stable | — | True when the host advertises bounded reads for the active backend. |
| `fs.stat` | function | stable | — | Read path type and size without loading file bytes. |
| `fs.write` | function | stable | — | Write text or bytes. |
| `fs.append` | function | stable | — | Append. |
| `fs.list` | function | stable | — | List entries. |
| `fs.delete` | function | stable | — | Delete a path. |
| `fs.exists` | function | stable | — | Existence check. |
| `fs.subscribe` | function | stable | — | Change subscription over a prefix; async — resolves to a stop function. |
| `fs.useBackend` | function | stable | — | Ask the host to switch the app's backend. |
| `fs.autosave` | function | stable | — | SDK-owned save timing: throttled, immediate on hide / pagehide / the host's beforeclose, a close guard only while unsaved (DUR, 2026-09-24). Returns `{ markDirty, flush, dirty, dispose }`; `{ guard:false }` for a background save. Stabilized 2026-09-24 from `experimental_autosave` (FLEET F1): used by KanZen and NakliPoster through the vendored copy, contract section Durability, host lanes test-sdk-autosave + test-host-durability, live on naklios.dev. |
| `sys` | namespace | stable | — | System-app surfaces. |
| `sys.fs` | namespace | stable | — | Whole-store filesystem (system apps only). |
| `sys.fs.read` | function | stable | — | Read text. |
| `sys.fs.readBinary` | function | stable | — | Read bytes; Folder offsets require an explicit bounded cap. |
| `sys.fs.stat` | function | stable | — | Read path type and size without loading file bytes. |
| `sys.fs.write` | function | stable | — | Write. |
| `sys.fs.append` | function | stable | — | Append. |
| `sys.fs.list` | function | stable | — | List. |
| `sys.fs.delete` | function | stable | — | Delete. |
| `sys.fs.exists` | function | stable | — | Existence check. |
| `experimental_tex` | namespace | experimental | The LaTeX writing app ships on it and it runs on naklios.dev, before stabilization as `tex`. | The shared TeX service (`docs/app-contract.md`, "TeX"): one queue in the host, the engine in a Worker, outputs in `.tex-build/`. |
| `experimental_tex.engines` | function | experimental | As `experimental_tex`. | The engines, the TeX Live version, the licence, the source link and the download size. |
| `experimental_tex.compile` | function | experimental | As `experimental_tex`. | Compile `{ folder, main, engine, onChunk }` from the app's own storage. Answers `{ ok, exitCode, pdf, log, synctex, diagnostics }`, where the three file values are paths; the returned promise carries `id`. |
| `experimental_tex.cancel` | function | experimental | As `experimental_tex`. | Stop a queued or running compile by the promise's `id`; the compile rejects with `ECANCELED`. |
| `experimental_tex.cache` | function | experimental | As `experimental_tex`. | Which TeX packs are in this browser. |
| `experimental_tex.clearCache` | function | experimental | As `experimental_tex`. | Asks the person, then deletes the TeX packs from this browser. |
| `experimental_commands` | namespace | experimental | Notes and Calendar register commands, and the voice assistant calls them live on naklios.dev through the desktop catalog (common rail step 2), before stabilization. | The app's commands on the common rail (`docs/app-contract.md`, "Common rail"); the desktop lists them as `<app-id>.<name>` in `sys/host/catalog.mjs`, checks each caller's grant and stages `destructive` ones. |
| `experimental_commands.register` | function | experimental | As `experimental_commands`. | Declare the app's commands `{ name, description, input, scope, handler }`; replaces the whole set. Standalone: keeps the handlers and sends nothing. |
| `experimental_commands.search` | function | experimental | Anvil finds app commands through it (common rail step 3), before stabilization. | System apps: find other apps' commands by words, with the input each one takes. Standalone: `[]`. |
| `experimental_commands.call` | function | experimental | As `experimental_commands.search`. | System apps: call another app's command; the host applies the caller's grant and asks the person before a change. Standalone: rejects. |
| `experimental_widgets` | namespace | experimental | Notes and Calendar publish desktop cards through it (common rail step 3b), before stabilization. | Small snapshots the desktop draws from fixed templates. |
| `experimental_widgets.update` | function | experimental | As `experimental_widgets`. | Publish a declared widget's snapshot; `null` removes the card; `{ persist: false }` keeps it in memory only. Standalone: returns false. |
| `files.experimental_targets` | function | experimental | Files builds its menu from it (common rail step 4), before stabilization. | Which apps take a file, from their declared `accepts`. Standalone: `[]`. |
| `files.experimental_sendTo` | function | experimental | As `files.experimental_targets`. | Send read-only copies of up to 10 files, 64 MB each and 128 MB in all, to an app that imports them, after the person allows it. Standalone: rejects. |
| `ai.experimental_embeddings` | function | experimental | Awaits an app that keeps its own vector search (common rail step 5). | On-device embeddings for up to 64 texts of 2,000 characters; asks once per app per visit. Standalone: rejects. |
| `ai.experimental_transcribe` | function | experimental | As `ai.experimental_embeddings`. | Speech to text on the assistant's model: 16 kHz mono, at most 30 s. Standalone: rejects. |
| `ai.experimental_speak` | function | experimental | As `ai.experimental_embeddings`. | Text to speech on the assistant's model: at most 1,000 characters, answered as samples. Standalone: rejects. |
| `experimental_skills` | namespace | experimental | Anvil, Dish and Pi all read it live on naklios.dev, and the Settings Skills pane activates a staged skill, before stabilization. | The user's one skills library, `skills/<name>/SKILL.md` on their Folder or Crate (`sys/ai/skill-library.mjs`; plan `plan/2026-10-29-shared-skills-plan.md`). System apps only. |
| `experimental_skills.list` | function | experimental | As `experimental_skills`. | The skills an agent may use (Sentinel-clean, active or stale), as `{ name, description, status }` without bodies. Standalone: `[]`. |
| `experimental_skills.read` | function | experimental | As `experimental_skills`. | One usable skill with its body, or `null`. |
| `experimental_skills.propose` | function | experimental | As `experimental_skills`. | Write a skill as STAGED (never active); refused if Sentinel refuses it or the name exists. Binds only after a person activates it. |
| `files` | namespace | stable | — | Exact-file handoff (`docs/file-handoff-v1.md`). |
| `files.experimental_editInAnvil` | function | experimental | Bounded Editor snapshot; exact-file grant and stale-source refusal tested before stabilization. | Ask the host to stage one selected-file edit in Anvil. |
| `files.experimental_proposeEdit` | function | experimental | One-shot source-bound proposals; real model-to-review flow required before stabilization. | Return a snapshot edit without writing its source. |
| `files.experimental_onEditProposal` | function | experimental | Editor reviews; transactional Browser apply and concurrent-write refusal required before stabilization. | Receive the host-authenticated staged proposal. |
| `files.openWith` | function | stable | — | Hand a file to another app. |
| `files.onOpen` | function | stable | — | Receive a handed file. |
| `files.read` | function | stable | — | Read a handed file. |
| `files.write` | function | stable | — | Write it back. |
| `files.release` | function | stable | — | Release the handle. |
| `ai` | namespace | stable | — | Shared host inference (OpenAI-shaped). |
| `ai.chat` | namespace | stable | — | Chat. |
| `ai.chat.completions` | namespace | stable | — | Completions. |
| `ai.chat.completions.create` | function | stable | — | One completion; `stream:true` returns an async iterable. |
| `ai.images` | namespace | stable | — | Images. |
| `ai.images.generate` | function | stable | — | One image generation. |
| `ai.search` | function | stable | — | Semantic search over the app's OWN files on the connected backend — a local embedding index, no network. Behind the "Enable semantic search?" consent. |
| `ai.searchStatus` | function | stable | — | State of the local semantic-search rung. No app consumer yet (`scripts/test-net-seam.mjs` only). |
| `ai.cancelAll` | function | stable | — | Cancel in-flight chat and image calls (searches are not cancelled). No app consumer yet (`scripts/test-net-seam.mjs` only). |
| `net` | namespace | stable | — | Sovereign egress. |
| `net.available` | function | stable | — | Whether a backend is configured. No app consumer yet (`scripts/test-net-seam.mjs` only). |
| `net.info` | function | stable | — | Which backend, and whether it roams (`{ backend, roams }`). No app consumer yet (`scripts/test-net-seam.mjs` only). |
| `net.fetch` | function | stable | — | A fetch routed through the user's own egress (Grant-gated, History-logged). |

## Stabilization checklist (for the first `experimental_` member)

1. The member is used by at least one shipped app or system app through the vendored copy.
2. Its contract section in `docs/app-contract.md` exists and its acceptance gate covers it.
3. A host-side test drives the real handler (`scripts/test-host-*.mjs` style), not a grep.
4. The rename lands in one commit across `sdk/naklios.js`, the host, and every consumer's re-splice;
   `scripts/test-vendored-sdk.mjs` stays green.
5. This table's row flips to `stable` in the same commit.
