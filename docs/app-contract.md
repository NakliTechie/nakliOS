# NakliOS app contract

This is the stable integration boundary between NakliOS and a cooperative app.
Apps remain ordinary browser applications. When hosted in a NakliOS window,
`sdk/naklios.js` adds lifecycle, theme, app-scoped filesystem services, and
optional shared on-device inference.
The same source may continue to run standalone.

## Product spelling

The product name is **NakliOS**. The JavaScript global and message prefix are
lowercase `naklios`.

## Loading the SDK

**Every public member of `sdk/naklios.js` has a line in `docs/sdk-api-audit.md`** (kind, status, and — for
an `experimental_` member — the criteria that stabilize it); `scripts/test-sdk-audit.mjs` reads both and
goes red when they disagree. A new member ships as `experimental_<name>` with a ledger line; it is
stabilized by the audit, one rename across the SDK, the host and every vendored copy, and the row
flipping to `stable` — never by drift. (Rule from 2026-09-12; the SDK's own banner will carry it at
its next byte change.)

Bundled system apps use the checked-in SDK:

```html
<script src="../../sdk/naklios.js"></script>
```

Standalone applications can vendor the same file or load the published copy.
The SDK is a no-op outside an iframe; `naklios.capabilities.hosted` identifies
the hosted case.

## Vendoring the SDK (keeping the inlined copy fresh)

Cross-origin and single-file apps can't `<script src>` the canonical SDK, so they
inline it. An inlined copy silently rots when the canonical hardens — a v1 copy
posts to `'*'` and skips inbound-origin checks. The fix is a machine-managed splice,
never a hand-edit:

1. **Mark the block.** The vendored SDK lives between two JS-comment markers inside
   its `<script>`, so it works whether the SDK is its own `<script>` or shares one
   with app code:

   ```js
   /* naklios-sdk:begin ver=2 sha256=… — DO NOT EDIT until :end; run `node scripts/vendor-naklios-sdk.mjs` */
   (function () { /* …the SDK… */ })();
   /* naklios-sdk:end */
   ```

2. **Vendor the tool.** Copy `scripts/vendor-naklios-sdk.mjs` (from the nakliOS repo)
   into the app. First time, run `node scripts/vendor-naklios-sdk.mjs --adopt` to
   place the markers around the existing inlined SDK; thereafter a plain run
   re-splices the canonical between them and stamps `ver`/`sha256`. `--check` fails
   (exit 1) on drift.

3. **Automate it (app-side re-splice).** Copy `docs/vendor-sdk.workflow.yml` to
   `.github/workflows/vendor-sdk.yml`. It re-splices from
   `https://naklios.dev/sdk/naklios.js` on a daily cron (or manual dispatch) and
   opens a PR when the canonical changed. The app **pulls**; naklios never pushes, so
   no cross-repo tokens — freshness lands within a day, not on the same push.

The nakliOS repo runs `scripts/check-vendored-sdk.mjs` as a fleet drift report across
every vendoring app. An app that keeps its **own** protocol-compatible SDK (not the
canonical file) shows as `BESPOKE` there until it's converted to vendor canonical.

Full record and rollout status: `plan/sdk-vendoring.md`.

## Detecting the host (`?naklios`)

An app is *hosted* when it is embedded in a NakliOS window
(`window.parent !== window`) **or** invoked with the `?naklios` URL flag. The host
appends `?naklios` to embed URLs as an explicit signal, and it is also a deliberate
opt-in for testing. Either way, read `naklios.capabilities.hosted`:

```js
if (naklios.capabilities.hosted) { /* route through NakliOS transports */ }
```

The transports themselves require a real host frame to talk to, so a bare
`?naklios` top-level tab (no NakliOS around it) still falls back: `capabilities.fs`
and `capabilities.ai` only become true after a real host handshake. Detect, attempt,
fall back — always safe. `naklios.capabilities.flagged` reports the `?naklios` flag
specifically (distinct from being embedded in some other iframe).

## The transport-adapter pattern

Do not scatter `naklios.*` calls through the app. Build **two thin adapters at
init**, chosen once by capability, and call those everywhere so the rest of the app
is transport-agnostic:

```js
// storage: the app's ONLY filesystem surface
const store = (naklios.capabilities.hosted && naklios.capabilities.fs)
  ? hostStore()     // → naklios.fs.{read,write,list,delete,subscribe,…}
  : localStore();   // → showDirectoryPicker()/OPFS/localStorage (standalone)

// inference: the app's ONLY AI surface
const ai = (naklios.capabilities.hosted && naklios.capabilities.ai)
  ? hostAi()        // → naklios.ai.chat.completions.create(…)  (agent:true for system apps)
  : ownAi();        // → the app's configured endpoint / bundled runtime
```

Both adapters expose one interface. Re-pick on `naklios.onCapabilitiesChange`.

## FSA inside an iframe

`showDirectoryPicker()` is **blocked in a cross-origin iframe** — no sandbox flag
unlocks it. A hosted app MUST NOT call it; instead its storage adapter uses
`naklios.fs.*`, where the **host** owns the File System Access / Folder / Crate
handle and serves file ops over postMessage. This works in any iframe and gives the
app Folder/Crate roaming for free. Standalone (a real top-level tab), the adapter
uses raw FSA as before.

## Lifecycle

Call these after installing the app's listeners:

```js
naklios.theme.onChange(applyTheme);
naklios.onCapabilitiesChange(renderStorage);
naklios.ready();
naklios.theme.request();
naklios.requestCapabilities();
```

The lifecycle surface is:

- `naklios.ready()` — the app is interactive; NakliOS may remove its loading
  cover.
- `naklios.title(text)` — update the host window title.
- `naklios.close()` — request that NakliOS close the app window.
- `naklios.beforeClose(callback)` — register cleanup or pending-save work.
  The callback may return a Promise. Current hosts wait for it, with a bounded
  five-second fallback, before removing the iframe.

An app should still autosave during ordinary editing. `beforeClose` is the
last small durability barrier, not the primary persistence mechanism.

## Theme

`naklios.theme.onChange(callback)` receives:

```js
{
  id: "paper",
  mood: "warm",
  colors: {
    BODY: "#faf2e2",
    PANEL: "#fdf8ec",
    INK: "#2c1810",
    BRAND: "#c8512a",
    ACT: "#2a4a8a",
    OK: "#5a7a30",
    ROW: "#f0e2c8"
  }
}
```

Map these tokens into app-owned CSS variables. Do not assume every theme is
dark or that `BRAND` has sufficient contrast as body text.

## Capabilities

`naklios.capabilities` is mutated in place:

```js
{
  hosted: true,
  version: 1,
  fs: true,
  fsBackends: [
    { id: "fsa", label: "Folder", name: "NakliOS" },
    { id: "crate", label: "Crate", name: "personal" }
  ],
  fsBackend: "crate",
  ai: true,
  aiModel: "LiquidAI/LFM2.5-230M-GGUF",
  aiModelLabel: "LFM2.5 230M",
  aiProvider: "custom-webgpu",
  aiLocal: true,
  aiState: "ready",
  aiImages: true,
  aiImageModel: "prism-ml/bonsai-image-ternary-4B-mlx-2bit",
  aiImageModelLabel: "Bonsai Image · FLUX.2-Klein 4B",
  aiImageProvider: "custom-webgpu-image",
  aiImageLocal: true,
  aiImageState: "idle"
}
```

Use `naklios.onCapabilitiesChange(callback)` rather than reading it only once.
Folder permissions can expire and a Crate can be locked while the app is open.
AI also changes from `idle` to `loading`, `ready`, or `error`. The selected
model/provider may change while the app is open.

## AI

NakliOS owns one shared inference broker. The user may select a vendored
LocalMind browser model or a configured OpenAI-compatible endpoint. Apps receive
a streamed text completion API, not the worker, model memory, endpoint URL or
key, another app's queue, histories, tools, filesystem, or credentials.

```js
const stream = await naklios.ai.chat.completions.create({
  messages: [
    { role: "system", content: "Answer clearly and briefly." },
    { role: "user", content: "Explain this passage." }
  ],
  max_tokens: 384,
  stream: true,
  onStatus(status, progress) {
    // queued | loading | generating
  }
});

for await (const chunk of stream) {
  output.append(chunk.choices[0].delta.content || "");
}
```

Omit `stream:true` for an OpenAI-shaped final response. An `AbortSignal` may be
passed as `signal`, or call `stream.cancel()`. The host serializes generation
and applies per-app queue limits. Consent is scoped to the selected destination:
browser-local, a particular local endpoint, or a particular external endpoint.
Switching destinations may therefore prompt for a new decision on first use.
Built-in models download and cache their own advertised weight size.

Check `naklios.capabilities.ai` before exposing an AI action. The app must remain
useful when it is false. Third-party apps must also declare `inference` in their
manifest. Prompts are request-scoped; an app that wants chat history must own
and display that history itself. Use `aiModel`, `aiModelLabel`, `aiProvider`,
and `aiLocal` only for honest status copy; model choice remains a host setting.

Image generation is a separate capability and consent decision:

```js
const result = await naklios.ai.images.generate({
  prompt: "A hand-cut paper collage of a monsoon city",
  size: "1024x1024",
  quality: "medium",
  seed: 42, // honored by deterministic local runtimes; providers may ignore it
  steps: 4, // local runtime tuning; providers may ignore it
  signal: abortController.signal,
  onStatus(status, progress) {
    // queued | loading | generating
  }
});

const image = result.data[0];
preview.src = image.b64_json
  ? `data:${image.mime_type};base64,${image.b64_json}`
  : image.url;
```

Check `naklios.capabilities.aiImages` before showing the action. The built-in
Bonsai FLUX.2-Klein worker returns one PNG and supports `512x512`, `768x768`,
`1024x1024`, `1024x768`, and `768x1024`. Endpoint capabilities vary; NakliOS
uses the OpenAI-compatible `POST /images/generations` shape. Apps receive only
the generated image—not the provider URL, API key, or worker. Use the
`aiImage*` capability fields for honest boundary copy. Image model selection
remains a host setting.

## Filesystem

All paths are relative to `apps/<app-id>/` on the backend chosen for that app.
The host rejects traversal and stale-backend operations.

```js
await naklios.fs.write("library.json", JSON.stringify(library));
const library = JSON.parse(await naklios.fs.read("library.json"));
const files = await naklios.fs.list("notes");
const exists = await naklios.fs.exists("notes/one.md");
await naklios.fs.delete("notes/one.md");
```

Available methods:

- `read(path)` and `readBinary(path)`
- `write(path, stringOrBytes)`
- `append(path, line)`
- `list(prefix)`
- `exists(path)`
- `delete(path)`
- `useBackend("fsa" | "crate")`
- `subscribe(path, callback)`

`useBackend()` always goes through host confirmation. It changes the app's
view; it does not copy or delete data.

Every filesystem request carries the backend visible when it was issued.
NakliOS rejects the request if the app is rebound before the operation is
processed. Apps should surface the error and retry only after re-reading
capabilities.

## Storage locations are separate

Browser, Folder, and Crate are distinct libraries:

- **Browser** — app-owned IndexedDB or OPFS on this browser profile.
- **Folder** — the user-selected local NakliOS directory.
- **Crate** — the user's end-to-end-encrypted cloud filesystem.

Switching locations must never silently migrate, merge, overwrite, or delete
data. If an app offers import or copy, name the source and destination and
make it a separate explicit action.

An app that supports Browser storage owns that adapter itself. NakliOS provides
only Folder and Crate through `naklios.fs`.

## Change subscriptions

```js
const stop = await naklios.fs.subscribe("", event => {
  // event: { op, path, from?, to?, size?, backend, source? }
  // source === "remote" identifies a Crate change received elsewhere.
  refreshFromStorage(event);
});

// When changing location or tearing down:
stop();
```

Crate forwards its native `onChange` stream. Folder changes are detected by a
lightweight two-second metadata poll because the browser File System Access
API does not yet expose a widely supported change observer.

Subscriptions are app-scoped and backend-affine. They end when the window
closes or its backend changes. Apps should resubscribe after loading the new
location.

Do not overwrite a dirty editor automatically when a change arrives. Offer an
explicit reload/keep-mine/later decision. Clean views may refresh
automatically.

## Exact-file handoff

Cross-app editing uses the narrow [`naklios.files` handoff
contract](file-handoff-v1.md), never a broader `naklios.fs` namespace. A source
may ask the host to open one of its own app-relative files in an approved
handler. The target receives an opaque, window-lifetime token for that exact
backend path. Disconnecting or replacing the original backend invalidates the
grant.

Handoffs are explicit user actions and preserve file identity: v1 links the
approved file in place, does not silently import or copy it, and never exposes
Folder handles or Crate credentials.

## Persistence conventions

Prefer inspectable, recoverable formats:

- JSON for indexes and metadata.
- Markdown or plain text for authored content.
- JSONL for append-only event streams.
- Separate binary files rather than data URLs inside JSON.

Serialize writes that can touch the same logical record. Write content and
metadata before updating the index that advertises the record. Keep a recovery
path for an interrupted write.

Notes v1 is the reference implementation:

```text
apps/notes/
├── library.json
└── notes/
    ├── <note-id>.md
    └── <note-id>.json
```

Calendar v1 uses the same location lifecycle with a single inspectable index:

```text
apps/calendar/
└── calendar.json
```

Calendar stores recurring series as local wall times plus an IANA time zone so
weekly events stay at the intended hour across daylight-saving changes. ICS
import/export is an explicit user action; switching Browser, Folder, or Crate
opens a separate calendar and never copies events.

Editor v1 keeps its project files and session index together:

```text
apps/editor/
├── .editor-state.json
└── <user-created project files and folders>
```

Crash recoveries remain in a Browser-only IndexedDB store, keyed independently
by storage location and file identity. A recovery is removed only after that
file saves successfully or the user explicitly discards it.

## Security boundary

The app never receives Folder handles, Crate credentials, bucket configuration,
the encryption key, inference worker, or model memory. It receives only the
scoped RPC surfaces.

The host derives the app identity from the iframe window it created, not from
an app-supplied ID. Apps cannot escape `apps/<app-id>/` through filesystem
paths.

Cross-origin apps remain sandboxed. Same-origin mirrors are reserved for
bundled system apps or locked standalone-app artifacts that need that
capability; immutable mirror provenance is recorded in
`apps/manifest.lock.json`.

## Minimum acceptance gate

A stateful cooperative app should prove:

1. Standalone fallback remains usable, or the UI clearly says it requires
   NakliOS.
2. Folder and Crate contain separate data and switching copies nothing.
3. Autosave survives reload and an immediate window close.
4. A backend disconnect does not silently discard a dirty record.
5. Remote changes refresh a clean view and require an explicit decision for a
   dirty view.
6. Paths remain inside the app namespace.
7. Styled dialogs replace native `alert`, `confirm`, and `prompt`.
8. Theme changes and reduced-motion preferences remain usable.
9. AI actions remain optional, show progress, are cancellable, and never
   silently overwrite authored content.
