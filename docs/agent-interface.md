# Desktop and workspace agent interfaces

The desktop, Anvil, and Forge provide a developer agent interface.
Open **Developer agent tools** and enable it explicitly for the current tab.
The setting starts disabled and uses session storage.
Same-origin frames receive setting changes without retaining an old workspace face.

When enabled, `window.rig` provides `tools`, `search`, `describe`, `invoke`, `pending`, `reject`, and `grant`.
The surface provides no approval method.
Destructive operations return a proposal without executing it.
Review requests through the developer panel, then choose Accept or Reject.
Untrusted events, disabled controls, and controls retaining a previous workspace cannot approve requests.

The desktop also provides read-only discovery through `window.nakliOS.manifest()` and `window.nakliOS.tools()`.
`sys/host/agent.mjs` defines command metadata and handlers together.
Missing handlers and undeclared action callbacks fail registration.
Metadata returned through discovery is copied, so changing it cannot modify grant checks.
The previous raw state and filesystem debug object is no longer the supported machine interface.
Content-free launch diagnostics retain their existing read-only aliases.

Desktop commands cover apps, folders, windows, themes, mode, pins, sticky notes, diagnostics, and the connected filesystem.
Credential configuration, storage connection, app installation, review decisions, and model selection remain person-only operations.
Their declared commands refuse agent invocation.
Desktop filesystem writes and preference changes require staged approval.
App workspace commands retain their existing task grants.

This interface governs supported tool calls.
It does not isolate arbitrary JavaScript already running with the desktop's origin privileges.

## Network and SDK authority

Credential-bearing network access requires a same-origin system app.
Catalog membership alone grants no such access.
The host checks this before capability discovery and before the network request.
Missing or changed iframe origins refuse messages.

The SDK accepts messages only from its actual parent at an independently approved host origin.
Approved production hosts are `https://naklios.dev` and this project's Workers deployment hosts.
Loopback HTTP hosts support local development.
Referrers and parent-supplied query parameters grant no authority.
Before approval, only content-free ready and capability-request messages can leave the app.
Other startup messages wait in a bounded queue until the parent is verified; RPC overflow reports an error instead of silently losing writes.
Standalone pages cannot acquire filesystem or AI capabilities through injected messages.

## Campaign checks

The campaign harness enforces role grants on role actions and workspace reads.
It records attempted access in History, including denied instrument access.
A live safety badge requires an observed enforcement record.

The checker authors bounded command cases with exact expected output before the builder starts.
The harness seals those cases and records their hash.
Raw cases remain private to the harness; the builder receives directives and candidate metadata.
The checker runs each case against an isolated workspace overlay.
Writes remain in that overlay, and commands have a timeout.
Unsupported commands fail or pause; they do not count as passing cases.
The harness computes weighted pass rates from actual exit codes and exact stdout/stderr comparisons.
Model-emitted pass rates do not contribute to the score.
Demo runs remain explicitly labelled as demonstrations.

## Verification scope

`scripts/test-launch-blockers.mjs` executes the SDK, actual host message callback, command registry, grants, operator controls, and campaign checker.
It covers positive paths and refusals, including parent forgery, network denial, self-approval, metadata mutation, instrument access, and fabricated scores.
Mode and model-routing checks execute the host functions rather than relying only on source-text patterns.
Existing source wiring and artifact-provenance checks remain supplemental.
Their counts do not establish application behavior or comprehensive browser coverage.

## Mirrored SDK copies

The mirror manifest declares `managedSdk: "inline"` or `managedSdk: "file"` for hosted SDK copies.
The mirror pipeline replaces only that declared SDK seam with the canonical host SDK.
It records the original upstream source hash, canonical SDK hash, and resulting artifact hash separately.
Upstream app logic and source commit pins remain unchanged.
`node scripts/sync-mirrors.mjs --refresh-sdk` reapplies this transformation at existing pins without network access.
Regular mirror synchronization applies the same transformation to fetched source.
Mirror validation rejects stale or altered SDK copies.
Independently hosted upstream applications still need their own SDK release; this transformation covers NakliOS-hosted mirrors.
