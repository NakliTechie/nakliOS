# Anvil JavaScript scripts

Scripts stay off by default. Enable them for a task through Policy.
Selected-file edits exclude scripts. Plan and Ask modes exclude scripts.
The model keeps its ordinary tool definitions when scripts are enabled.

Each call executes one JavaScript async function body in a disposable Worker and QuickJS guest.
The guest exposes tools, text, store, and load. It receives no network, filesystem, timer, model endpoint, or module imports.
The current tools are granted read, write, edit, patch, and shell operations.
Nested calls use the same authority, rules, protected paths, approvals, hooks, capture, and durable prefixes as direct calls.
The bridge serializes actual execution. Scripts can have four pending promises.
Await calls whose outcomes matter. Completed writes remain real after script failure.

Limits:

- Script32KiB UTF-8; guest heap32MiB; native stack512KiB; deadline10seconds.
- Nested calls32; pending calls4; arguments32KiB per call.
- Full result256KiB per call; aggregate results1MiB.
- Guest output64KiB before the existing model-visible output cap.
- JSON store32keys;16KiB per value;64KiB total; depth32;8192nodes.

Large nested reads refuse before whole-object allocation when their backend honors bounded reads.
They do not promise ranged access to larger objects.
Scripts can filter their bounded full tool results before returning output to the model.

Successful scripts propose store snapshots on the run chain.
A matching successful outer result commits a proposal.
Task state retains only a record path and verified prefix reference.
Resume verifies chain and payload hashes before reconstructing values.
Forks retain their chosen prefix. Later transactions cannot change that prefix's values.
Unavailable or corrupted records refuse execution instead of silently resetting store state.
Store replay currently uses the private browser record. Cross-device store transport is not claimed.

Stop and deadlines terminate the Worker and cancel each pending call.
Backends can finish an already submitted external mutation despite cancellation.
The outer record retains pending IDs. A linked private audit records late settlement.
The system never claims rollback or automatically replays an uncertain external effect.
Replay serves recorded nested replies without an application executor or inference.

Default enablement requires A08 paired measurements across at least two models.
A07 implementation remains subject to its full batch acceptance.
