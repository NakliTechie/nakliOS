# SDK API audit — `sdk/naklios.js`

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
app consumer yet and say so in their note. No member carries the `experimental_` prefix yet; the
first that does is the first to walk the checklist below.

| member | kind | status | criteria (experimental only) | note |
|---|---|---|---|---|
| `version` | field | stable | — | The SDK's own protocol version constant (2); nothing compares it today — `ready()` sends feature flags, not this. |
| `capabilities` | namespace | stable | — | What the host has granted; mutated in place — read fields directly, or subscribe. |
| `capabilities.hosted` | field | stable | — | Set at construction: embedded in a frame, or `?naklios` present. Never rewritten by the host's messages. |
| `capabilities.flagged` | field | stable | — | `?naklios` was present — a hint, never a transport switch. |
| `capabilities.version` | field | stable | — | A constant 2 in the SDK, never set from a host message. |
| `capabilities.fs` | field | stable | — | App-scoped filesystem available (Folder or Crate connected). |
| `capabilities.fsBackends` | field | stable | — | Backends the host offers (`opfs` · `folder` · `crate`). |
| `capabilities.fsBackend` | field | stable | — | The backend in use. |
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
| `capabilities.aiSearchState` | field | stable | — | State of the search rung. |
| `capabilities.aiSearch` | field | stable | — | Web search through the host granted. |
| `capabilities.net` | field | stable | — | Sovereign egress (`naklios.net.fetch`) granted. |
| `capabilities.netBackend` | field | stable | — | `nakli-egress` · `nakli-local-bridge` · null. |
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
| `fs` | namespace | stable | — | App-scoped filesystem (paths under `apps/<id>/`). |
| `fs.read` | function | stable | — | Read text. |
| `fs.readBinary` | function | stable | — | Read bytes. |
| `fs.write` | function | stable | — | Write text or bytes. |
| `fs.append` | function | stable | — | Append. |
| `fs.list` | function | stable | — | List entries. |
| `fs.delete` | function | stable | — | Delete a path. |
| `fs.exists` | function | stable | — | Existence check. |
| `fs.subscribe` | function | stable | — | Change subscription over a prefix; async — resolves to a stop function. |
| `fs.useBackend` | function | stable | — | Ask the host to switch the app's backend. |
| `sys` | namespace | stable | — | System-app surfaces. |
| `sys.fs` | namespace | stable | — | Whole-store filesystem (system apps only). |
| `sys.fs.read` | function | stable | — | Read text. |
| `sys.fs.readBinary` | function | stable | — | Read bytes. |
| `sys.fs.write` | function | stable | — | Write. |
| `sys.fs.append` | function | stable | — | Append. |
| `sys.fs.list` | function | stable | — | List. |
| `sys.fs.delete` | function | stable | — | Delete. |
| `sys.fs.exists` | function | stable | — | Existence check. |
| `files` | namespace | stable | — | Exact-file handoff (`docs/file-handoff-v1.md`). |
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
| `ai.search` | function | stable | — | Web search through the host. |
| `ai.searchStatus` | function | stable | — | State of the search rung. No app consumer yet (`scripts/test-net-seam.mjs` only). |
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
