# Unix substrate handoff to kothri

The source pin is [`c3553134571d1d601bfdbf857f6b3df138a6bf4f`](https://github.com/NakliTechie/nakliOS/tree/c3553134571d1d601bfdbf857f6b3df138a6bf4f).
It includes Unix batches B01–B12 and Anvil's shell-tool integration.
The [manifest](kothri-unix-imports.json) names every static dependency of five public entrypoints.
Copy those module paths unchanged beneath `vendor/naklios/`, alongside all listed license and provenance files.
Every inventory row carries its immutable source byte count and SHA-256 digest.
The manifest excludes optional-only adapters and runtime downloads.
The source pin includes the Worker network-denial correction for Pyodide 0.26.4 type-cache invalidation.
The static core and supporting file bytes remain identical to the previous B12 pin.

This handoff supplies the reusable substrate.
Kothri's packaging, Worker message protocol, ACP adapter and public `openKothri()` API remain future work.
The pin does not claim POSIX or full GNU compatibility.
The [command contract](../sys/rig/cli/cmds/README.md) documents implemented flags, limits and explicit refusals.

## Generate and verify the inventory

Use Node 24 with the source commit available locally.
CI fetches history because a shallow checkout of a later documentation commit cannot resolve the pin.

```sh
node --experimental-vm-modules scripts/generate-unix-imports.mjs c3553134571d1d601bfdbf857f6b3df138a6bf4f
node --experimental-vm-modules scripts/test-unix-portability.mjs c3553134571d1d601bfdbf857f6b3df138a6bf4f
```

The generator parses immutable Git blobs without evaluating application code.
The independent verifier recomputes the dependency graph, file hashes and license inventory.
It extracts the checked files outside the application checkout.
A fresh Node process removes browser and network globals before importing every promised module.
It checks loops, substitution, binary streams, gzip interoperability, tar extraction, YAML/JSON, grants, staging and real Git commits.
It also checks refusal when optional Python, SQLite and JavaScript execution adapters are absent.
The verifier does not import the generator or infer its expected pin from the manifest.

For a future update, select a reviewed immutable source commit.
Regenerate the manifest, update the literal verifier argument in CI, and review the resulting hashes and dependency changes.
Preserve vendor license and provenance files during every copy.

## Embed the core

The five entrypoints expose fileops, the registry, the agent face, the shell and local Git.
This example uses in-memory storage under an `allowed` grant:

```js
import { createFileops, MemoryBackend } from './vendor/naklios/sys/rig/fileops/index.mjs';
import { buildRigRegistry } from './vendor/naklios/sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from './vendor/naklios/sys/rig/agent/index.mjs';
import { createShell } from './vendor/naklios/sys/rig/cli/shell.mjs';

const fs = createFileops({ backend: new MemoryBackend() });
const logFs = createFileops({ backend: new MemoryBackend() });
const registry = buildRigRegistry({ fs });
const grant = createGrant({ prefixes: ['allowed'], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: logFs }), actor: 'kothri-agent' });
await fs.mkdir('allowed'); // Owner setup, outside the agent interface.
let controller = new AbortController();
const shell = createShell({ registry, face, cwd: 'allowed', signal: () => controller.signal });
const result = await shell.feed('for n in one two; do printf "%s\\n" "$(echo $n)"; done');
// result.stdout and result.stderr retain strings or bytes; result.output is display text.
const exitCode = shell.lastCode;
// When result.awaitingConfirm is true, obtain the owner's decision, then feed('y') or feed('n').
// Stop: controller.abort(); await the active feed; inspect face.pendingProposals().
// A subsequent independent invocation needs a fresh controller.
controller = new AbortController();
```

Keep owner fileops and registry references outside model-authored code.
Agent requests use the governed face; exposing the owner edge would bypass the grant.
Destructive proposals require an embedding approval policy before acceptance.
Do not treat a staged response as a committed write.
Wait for cancellation settlement before starting another invocation.
Preserve byte arrays in pipes and file transfers; render only at the display boundary.
Git's bundled isomorphic-git code supports local repositories.
For shell Git integration, create the Git core at logical `dir: '/'` over the workspace fileops instance.
Supply that core to `buildRigRegistry({fs, git})`, with the shell starting at logical `cwd: ''`.
Use a grant covering that logical workspace, including `git:read` and `git:write`.
A separately rooted storage adapter can isolate the workspace from other projects.
Do not combine a Git subdirectory root with a second shell path prefix; their path coordinates differ.
The prefix-limited example above deliberately supplies only filesystem registry commands.
Remote operations require an explicitly supplied governed transport; this manifest promises no network transport.

## Optional runtime requirements

The manifest's `optionalRuntime` section separates host requirements from the static core closure.
Its adapter entrypoints are references, not a complete optional-runtime copy inventory.
Resolve the selected adapter's own imports and assets at the same pin before integrating it.

| Capability | Required host support |
| --- | --- |
| Core shell, data and archives | JavaScript ES modules, encoders, typed arrays, Web Crypto, timers, byte streams, CompressionStream and DecompressionStream |
| Persistent storage | OPFS on a secure origin, or an owner-selected File System Access directory handle |
| Python and SQLite | Injected Kiln facade, authorized Pyodide 0.26.4 downloads, dedicated private SQL interpreter |
| Worker interruption | Module Worker, cross-origin isolation and SharedArrayBuffer |
| Main-thread Python | Explicit host invocation policy; synchronous general Python cannot be interrupted |
| JavaScript gates | Injected module-URL factory and disposable Worker launcher; this evaluator supplies limited test/assert shims |

The static core includes vendored js-yaml and isomorphic-git.
Gzip uses platform compression streams; archives add no separately downloaded command binaries.
Pyodide assets remain external at the pinned CDN version.
The Worker verifies the entry-module digest; additional assets retain the documented CDN and lockfile trust boundary.
Runtime network stubs cannot block JavaScript's dynamic `import()` syntax.
An embedding CSP remains necessary for egress containment.
See [Kiln's contract](../sys/kiln/README.md) before enabling optional execution.

## Evidence scope

The maintained Node verifier covers the extracted static closure and representative governed behavior.
The required browser SQLite job separately exercises actual pinned Pyodide.
Deployed Forge and model-driven hosted Anvil replay evidence lives in the private `plan/` run records.
Those runs must establish deployed source hashes, actual tool outputs, persisted bytes, Stop settlement and independent recovery.
Neither the manifest nor a Node result substitutes for deployed application evidence.
