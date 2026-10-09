# Application porting template

Copy this document into the new port's private `plan/` directory.
Replace every placeholder before using it as an implementation contract.
Resolve reference links against the repository after copying this template.
Keep reusable adapters and build scripts tracked; keep private runtime evidence outside deployment assets.

Follow [the app contract](app-contract.md) for SDK behavior.
Follow [app loading](app-loading.md) for placement and mirroring.
Use [Dish](../apps/dish/README.md) as a Worker example, not a required architecture.

## 1. Define the port

| Field | Required decision |
| --- | --- |
| App | `<name>`, `<app-id>`, authoritative source URL |
| User outcome | `<existing upstream flow that must work inside NakliOS>` |
| Fidelity | `<upstream UI/runtime retained; intentional changes; unsupported features>` |
| Placement | `<cross-origin sandbox / declared mirror / system app / new tab>` |
| Placement evidence | `<required capability and reproducible reason for this trust level>` |
| Runtime | `<ordinary web / Worker or WASM / server-backed / native-dependent>` |
| Isolation | `<actual boundaries; trusted code; permitted network destinations>` |
| Ownership | `<upstream refresh owner; integration maintainer>` |
| Acceptance | `<concrete flows; asset budget; cold readiness budget; release blockers>` |

Inspect upstream's browser entrypoint before choosing a rewrite.
Preserve upstream's runtime and UI when they satisfy the requested experience.
Identify native dependencies before promising browser equivalence.
Do not grant same-origin access solely to improve performance.

## 2. Pin and reproduce

- Record the upstream release, immutable commit, source archive digest, and license.
- Record toolchain versions and frozen dependency inputs.
- List every loaded asset, including Workers, lazy imports, fonts, WASM, and runtime packages.
- Use manifest-declared synchronization for ordinary mirrors; do not patch generated mirror files manually.
- For a composed runtime, track source verification, patches, packing, finalization, and artifact hashing separately.
- Rebuild from a fresh verified extraction; refuse source drift before applying patches.
- Remove previous generated directories before copying new hashed bundles.
- Preserve redistributed licenses and dependency notices.
- Publish output hashes and byte counts in a tracked artifact lock.

```text
Source acquisition: <command and immutable input>
Dependency installation: <frozen, reviewed command>
Build: <one reproducible command>
Generated output: <paths>
Local patches: <paths and reasons>
Artifact lock: <path>
Refresh procedure: <same pipeline with deliberate pin update>
```

For packed plugin runtimes, inspect the final archive's entrypoints.
Load the packaged adapter in a regression check; checking its source file is insufficient.
Verify the packer's supported export-map shape and pruning behavior.
Keep minification settings, bundle roster, and size metrics reproducible.
Preserve names required by reflection, plugin loading, or debugging.

## 3. Map runtime requirements

| Runtime | Required investigation |
| --- | --- |
| Ordinary web app | Iframe restrictions, routes, relative assets, theme, narrow-window behavior |
| Worker or WASM | COOP/COEP, `crossOriginIsolated`, worker imports, memory, startup, process termination |
| Server-backed app | Service ownership, auth boundary, availability, CORS, offline behavior, deployment scope |
| Native-dependent app | Supported browser substitute or explicit native-service boundary; unsupported commands |

Record which upstream APIs actually work in the chosen runtime.
Replace native default paths and OS discovery with explicit runtime configuration.
Exercise a fresh library and an existing persisted profile.
Older configuration may override new defaults; specify migration or recovery behavior.
For Worker shells, document available commands and unsupported native execution.
Describe VFS scoping separately from code containment.
Curate plugins at build time when runtime installation is unsupported.
Review each packaged plugin's egress, telemetry, credential access, and license.

## 4. Implement host seams

Use thin lifecycle, storage, and inference adapters.
Keep upstream business logic independent of the transport.
Use the canonical SDK for bundled apps; use the documented managed splice for vendored SDK copies.
Wait for the real host capability reply before selecting hosted storage.
Do not interpret initial SDK defaults as a completed handshake.

| Seam | Required behavior |
| --- | --- |
| Lifecycle | Register listeners; report `ready` after usable UI; update title; cancel work on close |
| Theme | Map host tokens; test light/dark themes, reduced motion, and usable dialogs |
| Storage | App-scoped paths; backend affinity; restore before runtime initialization |
| Inference | Host-owned settings and credentials; declared streaming or buffered delivery; cancellation; destination consent |
| Capability changes | Rebind safely or stop with explicit recovery; preserve unsaved changes |
| Standalone | Usable fallback or an explicit hosted-only explanation |

An app must never receive provider keys, Folder handles, Crate secrets, or bucket configuration.
For agent adapters, preserve message roles, tool-call identifiers, results, usage, errors, and cancellation.
Explicitly reject unsupported content types.
Do not imply that every configured model supports tool requests.

## 5. Define durability

```text
Browser format and key: <location>
Folder app-relative format: <location>
Crate app-relative format: <location>
Mutable runtime paths: <allowlist>
Read/restore barrier: <before runtime boot>
Write acknowledgment: <what resolving guarantees>
Autosave: <SDK save callback, delay, dirty state, error UI>
Close barrier: <flush followed by cleanup>
Backend change: <flush/stop/reload behavior>
Remote changes: <clean refresh and dirty conflict behavior>
Recovery/migration: <version handling and user recovery>
```

Browser, Folder, and Crate open separate libraries.
Backend selection must not silently copy or merge data.
For VFS snapshots, preserve bytes, directories, permissions, recursive deletion, and session logs.
Reject traversal and overrides of immutable runtime packages.
Treat in-memory writes separately from completed persistence.
A failed save stays dirty and displays recovery instructions.
Use SDK autosave and its close barrier; `beforeunload` cannot await a save.

## 6. Register and deploy

- Use relative embed URLs so local verification loads the local implementation.
- Register catalog metadata, task-folder placement, mode limits, and declared capabilities.
- Update intentional routing and catalog allowlists together.
- Add focused integration checks to repository CI.
- Verify inventory and mirror provenance through the existing repository gates.
- Serve required isolation headers locally and in production.
- Verify existing infrastructure and authenticated deployment identity before provisioning replacements.
- Stage only committed release files; inspect asset exclusions before uploading.
- Exclude private plans, secrets, dependency caches, source tooling, and unrelated configurations.
- Record deployed commit, provider version, public URL, headers, and live artifact digest.

If preview automation is denied, record the exact origin and enforcement result.
Do not infer tool permission from a running server or a settings screenshot.
Use live verification only when the user authorizes deployment and that destination.

## 7. Complete the acceptance batch

Finish implementation before running the agreed verification batch.
Fix failures before repeating relevant checks.
Record results per requirement; never substitute CI for runtime evidence.

| Gate | Required evidence | Result / evidence pointer |
| --- | --- | --- |
| Upstream fidelity | Required upstream flow inside a NakliOS window | `<pending>` |
| Packaged artifact | Entrypoint executes; shipped hashes match | `<pending>` |
| Inference, if used | Completed response; tool turn if required; cancellation | `<pending / justified N/A>` |
| Browser | Mutation restored after reload; required session/content types | `<pending>` |
| Folder | Mutation restored after host close and reopen | `<pending>` |
| Crate | Unlocked backend write acknowledged; restored after reopen | `<pending>` |
| Backend switching | Distinct marker libraries; no copy; stale operations rejected | `<pending>` |
| Durability | Immediate close, tab hide/close, failed save, disconnect, conflict | `<pending>` |
| UI | Narrow host window, theme changes, reduced motion, usable dialogs | `<pending>` |
| Repository checks | Relevant commands and CI run for deployed commit | `<pending>` |
| Delivery | Live headers, routes, hashes, private-file exclusions | `<pending>` |
| Size | Image and critical asset bytes against declared budget | `<pending>` |
| Cold readiness | Defined start/end milestones and repeatable cold measurement | `<pending>` |

Measure warm and cold startup separately.
Record browser version, machine, network, backend, library size, cache settings, and each measured milestone.
For Workers, establish child-cache behavior; disabling page cache alone may provide incomplete evidence.
Use multiple observations before claiming an optimization improved performance.
A smaller artifact does not prove faster readiness.
Ask before a paid test; reuse an existing session when automatic title generation could add requests.
Restore shared settings after verification.

## 8. Record the result

```text
Implemented: <behavior and shipped revision>
Verified: <executed checks and direct observations>
Unverified: <missing acceptance evidence>
Contradicted: <failed budgets or runtime requirements>
Limitations: <actual unsupported behavior>
Next action: <owner and evidence needed>
Lessons: <failure, cause, correction, regression protection>
```

Keep the original acceptance requirements until they pass or the user explicitly changes them.
Link current evidence; label historical measurements with their revision.
