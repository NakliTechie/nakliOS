# Editor selection edits in Anvil

Editor can send selected text or read-view line anchors to Anvil.
Diff deletions retain the next working-line anchor, including the position after the final line.
The host confirms the file before issuing an opaque token.
The token permits a bounded snapshot of exactly one file.
It grants no source write-back, sibling access, Folder handle, or Crate credential.

Anvil creates a separate snapshot task.
Its normal provider route, tool loop, run recorder, and workspace capture remain active.
The snapshot backend rejects other files, file removal, binary content, oversized writes, and expired sessions.
Shell and direct tools share the same path restriction.
Project-memory, delegation, Git, and runtime execution capabilities are unavailable in this task.
The source remains unchanged during the Anvil run.
Ended snapshot tasks cannot learn or prime a later mounted project.
Anvil retains four inactive snapshot projects plus the selected snapshot project.
Durable run records retain their existing storage policies.

Anvil returns a proposal only after its run stops normally.
The proposal retains the file, source project, backend, baseline version, line anchors, and Anvil run identity.
Editor displays the proposal through its existing line diff.
The user reviews it before choosing Apply.
Browser preflight captures the selected snapshot before host confirmation.
The host does not claim that Browser bytes stay current throughout confirmation.
Editor checks its tab identity when receiving the result.
The native database comparison at Apply provides the final source race check.
A Browser proposal persists in a separate IndexedDB object store.
It survives closing its tab, switching workspaces, and restarting Editor.
Editor validates retained data before restoring it against exact current bytes.
Restart requires another review before applying a previously reviewed proposal.
Stale retained proposals expose an explicit discard action instead of mutation controls.
Discard compares the stored lifecycle state and refuses an applied journal from another Editor tab.
An explicitly stale applied journal can be discarded after an atomic check proves the source differs from its applied snapshot.
That discard removes only review metadata and preserves the external source bytes.
It also permits a missing source key while preserving the source's absence.
Retention allows sixteen paths, with one bounded proposal per path.
A delivered proposal survives its ended session as review-only state.
It carries no remaining host write grant.
Another selection cannot replace an existing proposal.
The user discards a proposal explicitly.
An applied proposal requires Revert before discard.

Browser apply compares the complete original content within one IndexedDB readwrite transaction.
The same transaction writes the reviewed replacement.
It also writes the resulting proposal state, preserving revert evidence across interruption.
The transaction checks the retained proposal identity before replacing either record.
Failure to write either record rolls back both records.
Revert compares the applied content before restoring the original.
Changed bytes, another selected tab, unsaved edits, or changed storage context refuse the operation.
The version tag supports routing; exact content equality establishes mutation authority.
Transaction serialization follows the [IndexedDB scheduling contract](https://w3c.github.io/IndexedDB/#transaction-scheduling).

Folder proposals remain available for review.
Crate handoffs refuse until their upstream reader supports a true byte bound.
Their Apply and Revert controls remain disabled because their adapters lack the required atomic expected-content operation.
A browser writer lock does not protect native Folder content from external writers.
This limitation remains part of B07's unfinished acceptance requirements.
The current handoff also requires a file in Editor's own workspace.
Delegating an existing Files-to-Editor grant remains unsupported.

Cancel releases the request and stops its Anvil snapshot task.
A failed initial snapshot read releases its token.
Snapshot tasks refuse queued follow-ups; the user starts another selection from Editor.
Closing or reloading either app revokes the grant.
A late host confirmation refuses before issuing a grant.
Range grants wait for the Anvil document load before delivery.
Closing Editor aborts its in-flight source transaction before acknowledging closure.
Requests expire after fifteen minutes.
Reload does not restore pending write authority.
Retained proposals contain no host grant token.
The host retries unacknowledged proposals for at most twelve seconds.
Each retry retains the same delivery identity and source binding.
The SDK coalesces pending retries and acknowledges accepted duplicates without staging them again.
Editor acknowledges Browser receipt only after durable retention succeeds.
Retention compares current Browser source bytes in that same transaction.
Cancel aborts an outstanding receipt transaction and removes a matching late receipt before acknowledgement.
Failed late cleanup retains an actionable cleanup state and never acknowledges successful delivery.
The explicit cleanup retry removes only the matching retained proposal.
Database upgrades reject blocked connections rather than keeping close acknowledgement pending indefinitely.
Anvil reports delivery success only after the bound Editor acknowledgement.
Folder retries and acknowledgement re-read the bounded source before reporting delivery success.
These reads do not provide atomic Folder apply or exclusion of external writers.
Closing a source tab waits for an in-flight durable receipt before removing its context.
Closing or reloading an app cancels pending delivery rather than restoring grant authority.
The Anvil record remains evidence of the snapshot run, rather than proof of source application.

## Command and SDK surfaces

The [Editor command manifest](../apps/editor/commands.mjs) supplies palette entries.
Visible controls invoke those same command handlers.
Commands cover send, cancel, review, apply, revert, and discard.

The SDK marks the new methods experimental:

- `files.experimental_editInAnvil(request)` requests a host-confirmed snapshot handoff.
- `files.experimental_proposeEdit(token, after, run)` returns one source-bound proposal.
- `files.experimental_onEditProposal(callback)` receives a proposal or cancellation.

The callback returns `true`, or a promise resolving to `true`, after accepting the proposal.
Any other return value leaves delivery unacknowledged.
Folder proposals remain limited to in-memory review.

The existing `files.onOpen`, `files.read`, and `files.release` methods carry the snapshot grant.
`files.write` refuses snapshot tokens.
Only the bundled Editor can request the handoff.
Only its bound Anvil window can return the result.

Requests limit source and result text to 256 KiB.
Instructions limit UTF-8 text to 4,000 bytes.
Selections limit anchors to 1,000 lines and context to 16,000 bytes.
The shared diff's existing resource limits remain intact.
Oversized changes produce a refusal instead of partial source application.

## Acceptance boundary

Deterministic handler and browser checks must cover the contract's supported paths.
A successful real-provider handoff still requires available authorized model fuel.
Folder and Crate atomic apply remain unresolved.
This implementation does not close the full B07 batch on its own.

Cancellation after receipt retention first records a durable Browser cleanup state.
A failed journal deletion restores cleanup after reload, with review and apply unavailable.
The owner can retry cleanup without changing source bytes.
If cancellation-state persistence fails, the Editor attempts matching staged-journal deletion directly.
If both operations fail, durable cancellation is not established.
The Editor retains actionable cleanup context in the current session.
Atomic apply refuses a cancelled journal even when another tab retains its earlier review state.
