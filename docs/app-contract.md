# NakliOS app contract — the SDK document

This is the ONE document for `sdk/naklios.js` (Chirag, 2026-09-13): the filesystem surface, the AI
surface and the vendoring instructions live here, and the **Reference** section near the end names
every public member, rendered from the audit ledger and checked in the gate. `docs/app-loading.md` is
about mirroring an APP into naklios.dev, not the SDK; `docs/sdk-api-audit.md` is the member ledger
(status and stabilization criteria), not the manual; the SDK banner points here.

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
every vendoring app.

**Rule: one SDK, the canonical one.** An app reaches the host only through
`sdk/naklios.js`, unedited. You can load it with `<script src>`, ship it as a file the
mirror refreshes, or inline it between the markers above. An app does not define its own
`window.naklios`, does not patch a copy, and does not post `naklios:*` messages by hand. A
private copy misses every later host change. Draft and Reckon kept their own copies and
missed the 2026-11-10 change that keeps a file call alive while the host shows a storage
prompt. If an app needs something the SDK lacks, add it to `sdk/naklios.js`, so every app
gets it. The gate enforces the rule for mirrored apps: `scripts/test-sdk-canonical-only.mjs`
fails when a mirrored file defines `window.naklios` or posts a `naklios:*` message outside
the canonical code. The only exceptions are listed apps still waiting to be converted, and
the test fails once a listed app is clean, so the list only shrinks.

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
  version: 2,
  fs: true,
  fsBackends: [
    { id: "fsa", label: "Folder", name: "NakliOS" },
    { id: "crate", label: "Crate", name: "personal" }
  ],
  fsBackend: "crate",
  ai: true,
  aiModel: "LiquidAI/LFM3-1.7B-ONNX",
  aiModelLabel: "LFM3 1.7B",
  aiProvider: "transformers-webgpu",
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

System-app agent requests preserve system, developer, user, assistant, and tool message roles.
Developer context retains its instruction role when sent to an OpenAI-compatible
endpoint; an Anthropic-compatible endpoint receives it in the system prompt.
Agent requests that carry `tools` run on LFM3 1.7B in the browser or on either
kind of endpoint, and tool calls come back in the same OpenAI shape from all three.

NakliOS owns one shared inference broker. The user may select a vendored
LocalMind browser model, a configured OpenAI-compatible endpoint, or a configured
Anthropic-compatible endpoint. Apps receive
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
    // permission (waiting on the person's "Allow AI?" answer) | queued | loading | generating
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

- `read(path)` and `readBinary(path, { maxBytes?, offset? })`
- `stat(path)` returns `{ type, size, mtimeMs }` or `null`. A `maxBytes`-only binary read
  rejects an oversized Folder snapshot before returning bytes.
  Adding `offset` reads up to `maxBytes` bytes from that byte position using native File slices.
  Offset requires a non-negative safe integer and an explicit cap no larger than 16 MiB.
  Reads at or past EOF return an empty byte array; zero caps return no bytes.
  Paths and backend affinity keep the same app/system permission boundaries.
  Crate currently has no bounded object reader and refuses capped or offset reads.
  Check `naklios.fs.supportsBoundedReads` before relying on bounded Folder or Crate reads; older hosts do not advertise them.
  Crate bounds authenticated plaintext size before GET. Compressed objects, excessive chunk counts, and non-BYOB response streams refuse explicitly.
  Crate does not advertise byte ranges or atomic expected-content writes. Folder proposals require Editor review; automatic apply/revert stays unavailable where atomic protection is required.
  `naklios.capabilities.fsRangeReads` explicitly advertises offset support for the active Folder backend.
  The SDK refuses offset requests unless this flag is true, including against older hosts.
  This SDK option does not change Rig shell archive or search limits.
- `write(path, stringOrBytes)`
- `append(path, line)`
- `list(prefix)`
- `exists(path)`
- `delete(path)`
- `useBackend("fsa" | "crate")`
- `subscribe(path, callback)`
- `autosave({ save, delay, onError, guard })` — see [Durability](#durability)

`useBackend()` always goes through host confirmation. It changes the app's
view; it does not copy or delete data.

Every filesystem request carries the backend visible when it was issued.
NakliOS rejects the request if the app is rebound before the operation is
processed. Apps should surface the error and retry only after re-reading
capabilities.

## Durability

What an app may assume, and what it may not (DUR, 2026-09-24).

- **`write()` resolving means the file is committed.** The host replies after the
  backend's write finishes — for a picked folder, after the writable stream's
  `close()`; for Crate, after Crate acknowledges. Before it resolves, assume nothing.
- **Ops on one path apply in the order you issued them.** The host queues each app
  path, so a newer write never lands before an older one it overtook.
- **The browser's own storage is persistent.** The host calls
  `navigator.storage.persist()` at start, so browser-local data is not evicted
  under storage pressure while the grant holds.
- **`beforeunload` cannot save.** It cannot await, so a write started there is lost
  when the tab closes. Do not rely on it, and do not hand-roll a flush there.
- **Autosave is the SDK's job.** Declare changes; the SDK chooses when to save:

```js
const saver = naklios.fs.autosave({
  save: () => naklios.fs.write('state.json', JSON.stringify(state)), // or any async save
  delay: 1000,                // at most this long after the first unsaved change
  onError: (e) => showSaveError(e),
});
// on every edit:
saver.markDirty();
// before an operation that needs the state on disk:
await saver.flush();
saver.dirty;                  // true while a change is not yet durable
```

The SDK saves at most `delay` ms after the first unsaved change. It saves
**immediately** when the page hides (`visibilitychange` → hidden, `pagehide`), which
fires early enough for the message to reach the host. It also saves when NakliOS
closes the window: the host's `beforeclose` waits for the save as well as your
`beforeClose` callback. A failed save stays dirty, calls `onError`, and the next
flush retries.

While any saver is dirty, the SDK reports it to the host (`naklios:fs:dirty`), and
the host holds a tab close with the browser's own leave-page prompt. Standalone,
the SDK arms that prompt itself. The guard is armed only while something is
unsaved, so it never nags. This is the one exception to the no-native-dialogs rule:
the browser's own prompt is the only thing that can interpose on a close.

Pass `guard: false` for a background save that is not the user's only copy (a
remote sync push after a local save, say): it keeps the timing, and it never holds a
close or reports dirty.

`save` is yours. It may write through `naklios.fs`, IndexedDB, or a picked folder,
so the timing half also runs standalone; only the dirty report needs a host.

## Network egress

`naklios.net.fetch({ url, method, headers, body })` sends a request the browser's
same-origin policy would block through the user's own egress backend (their Worker,
or the local bridge). It is a system-app capability, and `capabilities.net` says
whether a backend is configured.

- **Grant-gated.** An app holds one Grant per host (`principal app:<id>`,
  `tools [net.fetch]`, `scope net:<host>`). The first request to a host asks the
  owner once. A decline is remembered and refuses at once, without touching the
  backend, until the owner revokes it in Settings → AI → Reset network decisions.
  Revoking also adds every issued grant to a revocation list.
- **History-logged.** Every attempt, refused ones included, appends one hash-chained
  History event (door `net`) to the host's origin storage. The event records the
  host, method, status and byte count, and the grant id. It never records the URL
  path, a body or a token.
- **The boundary.** System apps are same-origin with the host. A Grant is the owner's
  consent and the audit trail. It is not a cryptographic wall against a hostile
  system app.

A refused request rejects with the reason in the message: not allowed, or did not
verify.

## TeX

`naklios.experimental_tex` compiles a LaTeX project in the app's own storage. The engine is
`texlyre-busytex` (TeX Live 2026, AGPL-3.0-or-later), which runs in a Worker owned by the host. The app
talks to it by messages, so the AGPL stays on that component. Its files and source are in
[`NakliTechie/naklios-tex`](https://github.com/NakliTechie/naklios-tex). The browser downloads the large files from
[Hugging Face](https://huggingface.co/datasets/naklitechie/naklios-tex) through a redirect at `naklios.dev/tex/`, and that
route serves the scripts on the page's own origin. `capabilities.experimental_tex` says whether the app may call it.

```js
const job = naklios.experimental_tex.compile({
  folder: 'paper', main: 'main.tex', engine: 'pdflatex',   // or 'xelatex', 'lualatex'
  onChunk: chunk => { /* { kind:'progress', stage } · { kind:'diagnostic', ... } · { kind:'log', text } */ },
});
const { ok, pdf, log, synctex, diagnostics } = await job;  // pdf, log and synctex are paths
naklios.experimental_tex.cancel(job.id);                   // the compile rejects with ECANCELED
```

- **Folder grant.** The host reads the project through the app's own `apps/<id>/` scope, so no file bytes cross the
  rail and a caller can compile only its own storage. Without a connected Folder or Crate the call fails. Third-party
  apps also declare the `tex` permission.
- **First use.** The first compile asks the person once and downloads about 390 MB, shared by every app and kept in this
  browser. That took under two minutes on one connection, and 15 on a slow day, so show the `download` progress chunks. Biber adds about 30 MB on first use. Later compiles need the engine loaded, which took about 7 s in the spike.
- **Outputs.** `<folder>/.tex-build/<name>.pdf`, `.log` and `.synctex.gz`, plus `.aux`, and `.bbl` and `.blg` when a bibliography ran; the reply names each path that was written. A build is kept after the app closes. Files and
  folders whose names start with a dot are not sent to TeX. SyncTeX paths are relative to `folder`.
- **A TeX error is an answer.** `ok` is false and `diagnostics` lists `{ severity, kind, file, line, message }`. The call
  rejects only for refusals, a cancel or an engine failure. A package outside the packs (`algorithm2e` is one) gives
  `kind:'missing-file'`; add the file to the project folder.
- **Queue.** One compile runs at a time across all apps. A new compile of the same project replaces the old one. Log text
  arrives when the run ends, because the engine does not stream it. A single run stops after 180 s.
- **History.** Every compile appends one hash-chained event (door `tex`) with the project path, engine and outcome, never
  file contents. Shell escape is always off.

## Web

`naklios.experimental_web` searches the web and reads pages for agent apps. A browser Worker has no DNS and meets CORS
on most sites, so the host reads for it. System apps only; `capabilities.experimental_web` says whether the app may call it.

```js
const { provider, results } = await naklios.experimental_web.search('wasm tex engine', { maxResults: 5 });
const page = await naklios.experimental_web.fetch(results[0].url);  // { url, status, kind, content, truncated, via }
```

- **Search.** The host uses the provider the person set in the assistant panel (Brave, Tavily or SearXNG); else DeepSeek's
  native web search when a DeepSeek key is saved in Settings → AI; else Wikipedia, which needs no key or account. Keys stay
  in the host. `provider` in the answer says which ran.
- **Reading.** GET only. The page directly with redirects refused, else the person's own web relay (`naklios.net`'s
  backend, without the Git token), else Jina Reader (`r.jina.ai`), which sees the address. Local-network addresses are
  refused. `kind` follows the `Content-Type`; the body stops at 2 MB and the content at 200,000 characters.
- **Consent and History.** Each host, the search provider and the reader included, asks the person once per app, through
  a `web.read` Grant kept apart from `naklios.net`'s `net.fetch` Grant. Every request appends one History event (door
  `net`) with the host, status and size, or an error category; never the page address, the contents or error text.
- **Limit.** Stopping the calling tool does not yet stop a request the host has started; each provider call times out
  after 10 to 20 s.

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

## Common rail — protocol v3 (proposed)

**Status: proposed 2026-11-03; steps 1 and 2 built 2026-11-03; step 3 built 2026-11-05 (Reckon, Draft, Sheaf and KanZen declare commands; Anvil calls them through `experimental_commands.search` and `.call`, which only system apps may use; the voice assistant reaches every app beyond its tuned tools through two fixed tools, so its tool list does not grow with the catalog; the desktop's sticky-note commands are `stickies.*`; a destructive command asks the person every time, in a dialog that shows what it would do; a handler's second argument is `{ caller, signal }`, and `signal` aborts when the caller stops waiting; a result over 256 KB is refused; step 3b built 2026-11-05: `commands.json` may declare `widgets` `{ id, title, display }` with display `list`, `agenda` or `value`, the app publishes through `experimental_widgets.update`, and the desktop draws text-only cards that open the app on a tap and keep the last snapshot in this browser, except snapshots marked `persist: false`, which go when Crate locks; step 4 built 2026-11-05: `accepts` in `commands.json`, `files.experimental_targets` and `files.experimental_sendTo`, see `docs/file-handoff-v1.md`; step 5 built 2026-11-05: an installed app with the `tools` permission, which needs `inference`, may send `tools` at the normal token caps, and `ai.experimental_embeddings`, `ai.experimental_transcribe` and `ai.experimental_speak` run on this device after one Allow per app per visit; speech needs the assistant's model, whose download stays the person's click; step 6 built 2026-11-05: `commands.json` carries `parity`, which maps every control in Notes and Calendar to its command, to `view`, or to `person: <reason>`, and `scripts/check-command-parity.mjs` fails CI on a control with no entry; mirrored apps are held to manifest and handler checks only, because their controls are drawn at run time).** Built: `naklios.experimental_commands.register`; the desktop catalog (`sys/host/catalog.mjs`), reachable through the developer agent door; app manifests (`apps/<id>/commands.json`) that list an app's commands while it is closed, where a call opens the app minimized and waits for it to register; Notes and Calendar commands; and the voice assistant calling them on its own face (`app:read`, `app:write`), asking once per app per visit before a change. Everything else in this section is not built yet. It is the plan for SDK v3, recorded here so
the contract stays one document. Members it names ship as `experimental_<name>` with a ledger line, per the rule in
[`sdk-api-audit.md`](sdk-api-audit.md), and move into the Reference when they exist. Plan and build order:
`plan/2026-11-03-common-rail-spec-plan.md`.

The common rail is the one channel between the host and an app. Files, AI, commands and widgets all ride it; no
service opens a channel of its own. Events (below) are not built; they join the rail only if a feature needs them. Every caller of an app (the person's UI, the voice assistant, Anvil, an outside
agent, a test) reaches it through the host, and the host applies one set of checks: the caller's Grant, the History
ledger, and Staging for destructive changes.

### Rail

The rail is today's message format, written down and versioned:

- **Request:** `{ type: "naklios:<service>:<op>", requestId, ...args }` from app to host, or host to app.
- **Reply:** `{ type: "naklios:<service>:reply", requestId, result }` or `{ ..., error }`.
- **Event:** `{ type: "naklios:<service>:event", requestId | subscriptionId, ... }` for streams and subscriptions.
- **Cancel:** `{ type: "naklios:<service>:cancel", requestId }`.
- **Origins:** the SDK accepts messages only from its approved parent (see `docs/agent-interface.md`); the host
  accepts messages only from the window it opened at the origin it expects.
- **Deadlines:** every request has one. The SDK's default stays 30 s; the host also times out an app handler that
  never answers and reports it to the caller as an error, not a hang.
- **Handshake:** `naklios:ready` carries `features` today. In v3 it also carries `protocol: 3` and the services and
  versions the app speaks, for example `{ fs: 1, files: 2, ai: 1, commands: 1 }`. The host answers through
  `naklios:capabilities` with what it grants. `naklios.version` becomes 3 and both sides compare it; a v2 app keeps
  working unchanged.

### Files

`naklios.fs` is unchanged. `naklios.files` handoff v2 adds:

- typed and binary files, and several files in one handoff;
- an app manifest field `accepts`: MIME types plus actions (`open`, `import`, `attach`), so the host builds
  "Open with" and "Send to" from what apps declare instead of naming Editor;
- every write through a handoff token records an actor (person, app, agent) and, where the backend supports it,
  the content it expects to replace, so a stale write comes back as a proposal instead of overwriting.

### AI

`naklios.ai.chat.completions` and `naklios.ai.images.generate` are unchanged. v3 adds, each behind its own consent:

- `tools` for any app the person grants, not only system apps;
- `embeddings` for an app's own search;
- `transcribe` and `speak`, from the host's voice stack.

Model choice, endpoints and keys stay host settings; apps receive results only.

### Commands

`naklios.experimental_commands.register(list)` declares what an app can do. Each command has:

| field | meaning |
|---|---|
| `name` | `<app>.<verb>` or `<app>.<noun>.<verb>`, for example `notes.list.add` |
| `description` | one sentence a person and a model can both read |
| `input` | JSON Schema for the arguments a caller passes |
| `scope` | `read`, `write`, or `destructive` |
| `handler` | `async (args, context) → result`, run inside the app |

The host keeps one catalog: the desktop's own commands (`sys/host/agent.mjs`) and every running app's. A caller lists
and invokes through the host, never the app directly. The host checks the caller's Grant for that command and scope,
records the call and its outcome in History, and sends a `destructive` command through `naklios.review` for the
person to accept. The app's handler runs only after those checks. Person-only operations (credentials, storage
connection, model choice, review decisions) are never commands.

The app's own buttons call the same commands, so a command is the one path to a change whether a person, the
assistant, Anvil or a test asks for it (doctrine rule 6, "two doors, one core"). Reckon's, Sheaf's and Draft's
in-page agent faces become thin adapters over `register`.

### Assistant

The voice assistant has no service of its own. It is a caller of the command catalog, like Anvil and an outside
agent. An app the assistant can reach is an app that registered commands; the assistant does not read or write any
app's files directly.

### Events (not built)

`naklios.experimental_events` comes last, only when a named feature needs it. Events are host-mediated, numbered, and
grouped by topic; each subscriber keeps its own read position, and a `once` key stops the same work running twice.
A subscriber needs a Grant for the topic.

### Grants on the rail

| Caller | May list | May invoke `read` | May invoke `write` | May invoke `destructive` |
|---|---|---|---|---|
| The app's own UI | its own commands | yes | yes | through review |
| Voice assistant, Anvil | every registered command | yes | after the person allows it once per app per session | through review |
| Outside agent (`window.nakliOS.tools()`) | when the person turns the door on for the tab | yes | after the person allows it | through review |
| Another app | only commands it holds a Grant for | with a Grant | with a Grant | through review |

Cross-origin catalog apps may register commands; the same checks apply, because the rail already carries their `fs`
and `ai` calls.

### Prior art

Compos (`svs/compos`, GPL-3.0; ideas only, no code): a command is a name, a description and a function that a key,
`M-x`, an agent and a test all run by name; events live in one durable numbered log with per-consumer positions and
`once` keys; every change carries an actor and an intent, and stale concurrent work is kept as a proposal; and the
unit of an agent's authority is its operational context (resources, identities, lifetimes), not a tool list.

## Reference — every public member

This is the one SDK document: the sections above are the guide (loading, vendoring, the host, the
transport, filesystem, AI, subscriptions, handoff, persistence); this section is the reference. It is
rendered from the member ledger and checked in the gate, so a member cannot exist without a line here.

<!-- sdk-reference:begin — rendered by `node scripts/sdk-reference.mjs --write` from docs/sdk-api-audit.md; do not edit by hand -->

114 public members. Kinds: getter · function · namespace · field. Status and stabilization criteria live in the ledger (`docs/sdk-api-audit.md`); an `experimental_` member is named here like any other and marked so.

### `version`

| member | kind | what it is |
|---|---|---|
| `version` | field | The SDK's own protocol version constant (2); nothing compares it today — `ready()` sends feature flags, not this. |

### `capabilities` (namespace)

| member | kind | what it is |
|---|---|---|
| `capabilities` | namespace | What the host has granted; mutated in place — read fields directly, or subscribe. |
| `capabilities.hosted` | field | Set at construction: embedded in a frame, or `?naklios` present. Never rewritten by the host's messages. |
| `capabilities.flagged` | field | `?naklios` was present — a hint, never a transport switch. |
| `capabilities.version` | field | A constant 2 in the SDK, never set from a host message. |
| `capabilities.fs` | field | App-scoped filesystem available (Folder or Crate connected). |
| `capabilities.fsBackends` | field | The backends the host offers, as descriptors `[{ id, label, name }]` — ids `fsa` (a picked folder) and `crate`; the browser's own OPFS is not on this list. |
| `capabilities.fsBackend` | field | The backend in use. |
| `capabilities.fsBoundedReads` | field | True when the active host storage backend supports a byte-limited read. |
| `capabilities.fsRangeReads` | field | True when the active host Folder backend supports explicit bounded byte ranges. |
| `capabilities.system` | field | The app is a system app (same-origin, `kind: system`). |
| `capabilities.sysFs` | field | Whole-store filesystem granted (system apps only). |
| `capabilities.ai` | field | Shared host inference granted. |
| `capabilities.aiModel` | field | Configured chat model id, or null. |
| `capabilities.aiModelLabel` | field | Human label for it. |
| `capabilities.aiProvider` | field | Provider of the chat model. |
| `capabilities.aiLocal` | field | The chat model runs on-device. |
| `capabilities.aiState` | field | `idle` (standalone default) · `loading` · `ready` · `error`, as the host sets it. |
| `capabilities.aiImages` | field | Image generation granted. |
| `capabilities.aiImageModel` | field | Configured image model id, or null. |
| `capabilities.aiImageModelLabel` | field | Human label for it. |
| `capabilities.aiImageProvider` | field | Provider of the image model. |
| `capabilities.aiImageLocal` | field | The image model runs on-device. |
| `capabilities.aiImageState` | field | State of the image runtime. |
| `capabilities.aiSearchState` | field | State of the local semantic-search rung (`idle` · `loading` · `ready` · `error`). |
| `capabilities.aiSearch` | field | Semantic (local, embedding) search over the app's own namespace granted — not web search. |
| `capabilities.experimental_tex` | field · **experimental** | The app may compile LaTeX projects in its own storage. |
| `capabilities.experimental_web` | field · **experimental** | The app may search the web and read pages through the host. |
| `capabilities.net` | field | Sovereign egress (`naklios.net.fetch`) granted. |
| `capabilities.netBackend` | field | Which egress backend the host is configured with: `worker` (the default) · `bridge`; null when none. Never a package name. |
| `capabilities.review` | field | The host can stage native diffs from this app and return source-bound review decisions. Enabled for Reckon, Draft, and KanZen. |

### `ready`

| member | kind | what it is |
|---|---|---|
| `ready` | function | Signal "loaded"; carries the feature flags this SDK build supports. |

### `title`

| member | kind | what it is |
|---|---|---|
| `title` | function | Set the host window title. |

### `close`

| member | kind | what it is |
|---|---|---|
| `close` | function | Ask the host to close this window. |

### `openSettings`

| member | kind | what it is |
|---|---|---|
| `openSettings` | function | Open the host Settings at a section (`ai`, `storage`, …). |

### `beforeClose`

| member | kind | what it is |
|---|---|---|
| `beforeClose` | function | Register a callback the host awaits before closing (ack protocol). |

### `theme` (namespace)

| member | kind | what it is |
|---|---|---|
| `theme` | namespace | Host theme. |
| `theme.current` | getter | The last theme the host sent. |
| `theme.onChange` | function | Subscribe; called at once when a theme has already arrived; returns an unsubscribe. |
| `theme.request` | function | Ask the host to re-send the theme. |

### `onCapabilitiesChange`

| member | kind | what it is |
|---|---|---|
| `onCapabilitiesChange` | function | Subscribe to capability changes; replays the current set at registration. |

### `requestCapabilities`

| member | kind | what it is |
|---|---|---|
| `requestCapabilities` | function | Ask the host to re-broadcast capabilities. |

### `review` (namespace)

| member | kind | what it is |
|---|---|---|
| `review` | namespace | Host-owned staging queue and person review bridge. The P0 app contract names this stable namespace directly. |
| `review.stage` | function | Send a native diff without applying it. Returns a proposal ID; standalone returns a fallback marker. |
| `review.onDecision` | function | Register one app decision handler. The SDK acknowledges a successful commit once and re-acknowledges replays without reapplying. |

### `fs` (namespace)

| member | kind | what it is |
|---|---|---|
| `fs` | namespace | App-scoped filesystem (paths under `apps/<id>/`). |
| `fs.read` | function | Read text. |
| `fs.readBinary` | function | Read bytes; Folder offsets require an explicit bounded cap. |
| `fs.supportsBoundedReads` | getter | True when the host advertises bounded reads for the active backend. |
| `fs.stat` | function | Read path type and size without loading file bytes. |
| `fs.write` | function | Write text or bytes. |
| `fs.append` | function | Append. |
| `fs.list` | function | List entries. |
| `fs.delete` | function | Delete a path. |
| `fs.exists` | function | Existence check. |
| `fs.subscribe` | function | Change subscription over a prefix; async — resolves to a stop function. |
| `fs.useBackend` | function | Ask the host to switch the app's backend. |
| `fs.autosave` | function | SDK-owned save timing: throttled, immediate on hide / pagehide / the host's beforeclose, a close guard only while unsaved (DUR, 2026-09-24). Returns `{ markDirty, flush, dirty, dispose }`; `{ guard:false }` for a background save. Stabilized 2026-09-24 from `experimental_autosave` (FLEET F1): used by KanZen and NakliPoster through the vendored copy, contract section Durability, host lanes test-sdk-autosave + test-host-durability, live on naklios.dev. |

### `sys` (namespace)

| member | kind | what it is |
|---|---|---|
| `sys` | namespace | System-app surfaces. |
| `sys.fs` | namespace | Whole-store filesystem (system apps only). |
| `sys.fs.read` | function | Read text. |
| `sys.fs.readBinary` | function | Read bytes; Folder offsets require an explicit bounded cap. |
| `sys.fs.stat` | function | Read path type and size without loading file bytes. |
| `sys.fs.write` | function | Write. |
| `sys.fs.append` | function | Append. |
| `sys.fs.list` | function | List. |
| `sys.fs.delete` | function | Delete. |
| `sys.fs.exists` | function | Existence check. |

### `experimental_tex` (namespace)

| member | kind | what it is |
|---|---|---|
| `experimental_tex` | namespace · **experimental** | The shared TeX service (`docs/app-contract.md`, "TeX"): one queue in the host, the engine in a Worker, outputs in `.tex-build/`. |
| `experimental_tex.engines` | function · **experimental** | The engines, the TeX Live version, the licence, the source link and the download size. |
| `experimental_tex.compile` | function · **experimental** | Compile `{ folder, main, engine, onChunk }` from the app's own storage. Answers `{ ok, exitCode, pdf, log, synctex, diagnostics }`, where the three file values are paths; the returned promise carries `id`. |
| `experimental_tex.cancel` | function · **experimental** | Stop a queued or running compile by the promise's `id`; the compile rejects with `ECANCELED`. |
| `experimental_tex.cache` | function · **experimental** | Which TeX packs are in this browser. |
| `experimental_tex.clearCache` | function · **experimental** | Asks the person, then deletes the TeX packs from this browser. |

### `experimental_web` (namespace)

| member | kind | what it is |
|---|---|---|
| `experimental_web` | namespace · **experimental** | Web search and page reading for agents whose Worker has no DNS and meets CORS (`docs/app-contract.md`, "Web"). System apps only. |
| `experimental_web.search` | function · **experimental** | Search with the person's provider from the assistant panel (Brave, Tavily or SearXNG), else DeepSeek when its key is saved, else Wikipedia. Answers `{ provider, results }`. |
| `experimental_web.fetch` | function · **experimental** | Read one http(s) page directly, through the person's web relay, or through Jina Reader. Answers `{ url, status, kind, content, truncated, via }`. |

### `experimental_commands` (namespace)

| member | kind | what it is |
|---|---|---|
| `experimental_commands` | namespace · **experimental** | The app's commands on the common rail (`docs/app-contract.md`, "Common rail"); the desktop lists them as `<app-id>.<name>` in `sys/host/catalog.mjs`, checks each caller's grant and stages `destructive` ones. |
| `experimental_commands.register` | function · **experimental** | Declare the app's commands `{ name, description, input, scope, handler }`; replaces the whole set. Standalone: keeps the handlers and sends nothing. |
| `experimental_commands.search` | function · **experimental** | System apps: find other apps' commands by words, with the input each one takes. Standalone: `[]`. |
| `experimental_commands.call` | function · **experimental** | System apps: call another app's command; the host applies the caller's grant and asks the person before a change. Standalone: rejects. |

### `experimental_widgets` (namespace)

| member | kind | what it is |
|---|---|---|
| `experimental_widgets` | namespace · **experimental** | Small snapshots the desktop draws from fixed templates. |
| `experimental_widgets.update` | function · **experimental** | Publish a declared widget's snapshot; `null` removes the card; `{ persist: false }` keeps it in memory only. Standalone: returns false. |

### `files` (namespace)

| member | kind | what it is |
|---|---|---|
| `files.experimental_targets` | function · **experimental** | Which apps take a file, from their declared `accepts`. Standalone: `[]`. |
| `files.experimental_sendTo` | function · **experimental** | Send read-only copies of up to 10 files, 64 MB each and 128 MB in all, to an app that imports them, after the person allows it. Standalone: rejects. |
| `files` | namespace | Exact-file handoff (`docs/file-handoff-v1.md`). |
| `files.experimental_editInAnvil` | function · **experimental** | Ask the host to stage one selected-file edit in Anvil. |
| `files.experimental_proposeEdit` | function · **experimental** | Return a snapshot edit without writing its source. |
| `files.experimental_onEditProposal` | function · **experimental** | Receive the host-authenticated staged proposal. |
| `files.openWith` | function | Hand a file to another app. |
| `files.onOpen` | function | Receive a handed file. |
| `files.read` | function | Read a handed file. |
| `files.write` | function | Write it back. |
| `files.release` | function | Release the handle. |

### `ai` (namespace)

| member | kind | what it is |
|---|---|---|
| `ai.experimental_embeddings` | function · **experimental** | On-device embeddings for up to 64 texts of 2,000 characters; asks once per app per visit. Standalone: rejects. |
| `ai.experimental_transcribe` | function · **experimental** | Speech to text on the assistant's model: 16 kHz mono, at most 30 s. Standalone: rejects. |
| `ai.experimental_speak` | function · **experimental** | Text to speech on the assistant's model: at most 1,000 characters, answered as samples. Standalone: rejects. |
| `ai` | namespace | Shared host inference (OpenAI-shaped). |
| `ai.chat` | namespace | Chat. |
| `ai.chat.completions` | namespace | Completions. |
| `ai.chat.completions.create` | function | One completion; `stream:true` returns an async iterable. |
| `ai.images` | namespace | Images. |
| `ai.images.generate` | function | One image generation. |
| `ai.search` | function | Semantic search over the app's OWN files on the connected backend — a local embedding index, no network. Behind the "Enable semantic search?" consent. |
| `ai.searchStatus` | function | State of the local semantic-search rung. No app consumer yet (`scripts/test-net-seam.mjs` only). |
| `ai.cancelAll` | function | Cancel in-flight chat and image calls (searches are not cancelled). No app consumer yet (`scripts/test-net-seam.mjs` only). |

### `experimental_skills` (namespace)

| member | kind | what it is |
|---|---|---|
| `experimental_skills` | namespace · **experimental** | The user's one skills library, `skills/<name>/SKILL.md` on their Folder or Crate (`sys/ai/skill-library.mjs`; plan `plan/2026-10-29-shared-skills-plan.md`). System apps only. |
| `experimental_skills.list` | function · **experimental** | The skills an agent may use (Sentinel-clean, active or stale), as `{ name, description, status }` without bodies. Standalone: `[]`. |
| `experimental_skills.read` | function · **experimental** | One usable skill with its body, or `null`. |
| `experimental_skills.propose` | function · **experimental** | Write a skill as STAGED (never active); refused if Sentinel refuses it or the name exists. Binds only after a person activates it. |

### `net` (namespace)

| member | kind | what it is |
|---|---|---|
| `net` | namespace | Sovereign egress. |
| `net.available` | function | Whether a backend is configured. No app consumer yet (`scripts/test-net-seam.mjs` only). |
| `net.info` | function | Which backend, and whether it roams (`{ backend, roams }`). No app consumer yet (`scripts/test-net-seam.mjs` only). |
| `net.fetch` | function | A fetch routed through the user's own egress (Grant-gated, History-logged). |

<!-- sdk-reference:end -->

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
3. Autosave survives reload, an immediate window close, and a tab close: the app
   saves through `naklios.fs.autosave` (see Durability), and no
   `beforeunload` handler awaits a save.
4. A backend disconnect does not silently discard a dirty record.
5. Remote changes refresh a clean view and require an explicit decision for a
   dirty view.
6. Paths remain inside the app namespace.
7. Styled dialogs replace native `alert`, `confirm`, and `prompt`.
8. Theme changes and reduced-motion preferences remain usable.
9. AI actions remain optional, show progress, are cancellable, and never
   silently overwrite authored content.
