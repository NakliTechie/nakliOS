# Dish

Dish hosts DeepSeek Harness inside a NakliOS window.
Open Dish from desktop search or the app catalog.
Select an endpoint model through NakliOS Settings → AI before starting an agent task.
NakliOS requests destination consent before sending a prompt.
Dish never receives the endpoint credential.

## Storage

Dish restores its workspace and plaintext session logs before booting the harness.
It uses the app's selected Folder or Crate backend when NakliOS advertises filesystem access.
Otherwise, it uses this browser's IndexedDB.
A missing host handshake refuses startup instead of opening a different library.
Each snapshot preserves mutable `home/` and `workspace/` files, binary bytes, directories, and file permissions.
The host stores snapshots at `apps/dish/vfs.json` on the selected backend.
Autosave uses the canonical NakliOS SDK's timing, dirty guard, and close barrier.
VFS writes complete in memory; autosave commits the snapshot asynchronously.
A failed save remains dirty.
A backend change stops the Worker and requires a reload.
Libraries remain separate; changing the backend does not migrate data.

## Runtime limits

Plugins execute with full trust inside the Worker.
The VFS is a logical filesystem boundary, not a native process sandbox.
The upstream shell provides browser commands, pipelines, substitutions, and redirects.
It does not provide git, Node programs, native tools, shell loops, or job control.
Plugins are selected during packaging; installation inside the Worker is unavailable.
This profile removes DeepSeek account/model routes, wire extensions, package inventory calls, and telemetry exporters.
The shared inference adapter currently accepts text and tool calls.
It rejects unsupported image/file blocks explicitly.
NakliOS's broker requires an endpoint model when a request includes tools.
Closing the browser stops the Worker.

## Build and provenance

The upstream release is `dsh-v0.2.1-alpha.1` at commit `5badb15009ae1756c3afe0ae0cef1faafc290ccc`.
`upstream.lock.json` records every shipped file's size and SHA-256.
The packed image includes upstream dependency licenses.
`LICENSE-upstream` preserves DeepSeek Harness's MIT license.
Build inputs and integration patches live under `scripts/dish/`.
`source.lock.json` pins the source files used by the build pipeline.

Extract the release archive into a clean temporary directory.
Install its dependencies with `pnpm install --frozen-lockfile --ignore-scripts`.
Run `bash scripts/build-dish.sh /path/to/extracted-upstream` from NakliOS.
The script verifies source inputs before applying the integration.
It builds upstream host/client libraries, the Worker, and the web UI.
It packs the curated profile and writes artifact hashes.
Use a fresh extraction for each rebuild.

The tracked compatibility patch adapts upstream's product isolation instrumentation to Vite 8's Rolldown API.
It handles missing Rollup-only chunk fields and Rolldown's synthetic runtime module.
The tracked Worker patch restores mutable data before boot and forwards runtime mutations to NakliOS.
The provider plugin translates DSH messages and completion blocks through the shared agent broker.

## Verification

Run `node scripts/test-dish.mjs` for provider, storage, profile, and artifact checks.
Serve with `node scripts/serve-coi.mjs` for browser verification.
The standalone entrypoint has no inference provider outside the NakliOS host.
Browser acceptance must demonstrate a completed turn inside NakliOS, persistence after reload, and measured cold boot.
Code checks alone do not establish that acceptance.

Boot telemetry distinguishes the Worker handshake from the mounted client.
`window.__dish.workerBootMs` measures navigation to Worker handshake completion.
`window.__dish.bootMs` measures navigation through client mounting and two animation frames.
The host receives `ready` after this client milestone.
These fields provide measurement hooks; they are not recorded browser results.
