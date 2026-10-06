# Optional local native gate

Anvil keeps its browser workspace runner as the default. A native gate is an
optional owner-authorized adapter for a disposable checkout on macOS. It is
not required for ordinary Anvil use.

Launch the service with Node 24 against an owner-prepared disposable checkout:

```sh
node scripts/native-gate-server.mjs \
  --checkout /absolute/path/to/disposable-checkout \
  --mutable sys/ai/context-budget.mjs \
  --criterion .anvil/gate/cap-handoff.mjs \
  --origin http://127.0.0.1:8948
```

The service prints a connection-file path. In Anvil, open that same workspace,
choose **Advanced → Native gate connection**, and select the connection file.
The file contains an ephemeral bearer credential. Keep it out of transcripts,
repositories, screenshots, and shared messages. The connection stays in memory.

The paired task can read the workspace. Its Rig grant permits writes only to
the selected production file. The existing skills, criterion, and derived
search-index fences still apply. A project or workspace switch awaits native cancellation before changing
the mount. An unconfirmed cancellation retains the binding and refuses the switch. Child agent overlays receive no native command. Paired grants deny Git writes,
clone, fetch, and push. Pairing revokes the old browser grant and closes its
Python Worker. Python remains unavailable while the native connection is paired.
Disconnect rebuilds the browser runtime.
An unconfirmed Python Worker closure retains the old runtime reference.
Task runs and workspace changes remain blocked. Retry **Native gate connection**
to acknowledge closure before restoring the browser mount.
The transition lock covers workspace selection and runtime restoration.
A failed restoration retains the captured mount for an explicit retry.
Send retains composer text while that lock is active.
Review submission rechecks workspace identity and composer text after validation.
Campaign preparation and execution prevent workspace or connection changes.

The actual Anvil shell exposes `native-gate full` and `native-gate criterion`.
Both commands go through Rig's registry, `native:gate` grant, and operation log.
`full` preserves every Node `run:` command from the frozen workflow, including
flags, arguments, order, and repeated entries. Unsupported workflow syntax
refuses session creation. `criterion` runs the separately frozen criterion.
Command text has a combined 64-KiB bound before execution.
Pairing refuses symlinks in the marker directory's ancestry.
The restricted workflow parser permits the pinned checkout and Node setup actions.
It rejects other actions, conditional execution, custom environments, shells,
working directories, matrices, containers, services, and dependency ordering.
The owner checkout supplies checkout preparation. The launch runtime supplies Node setup.
Neither route accepts arbitrary commands, paths, environment values, or code
uploads. Pairing binds the connection to an owner-written workspace marker.

The service freezes tracked source, nonignored untracked source, the workflow,
and the criterion. Ignored workspace records remain outside the execution view. It retains
an independent Git history copy for historical assertions. Before execution it
refuses changed fixed source. It copies the candidate into a private execution
view. `sandbox-exec` denies by default; its policy permits that view and required
system runtime files.
The bridge pins Node, installed developer Git, and the owner's launch-time
Python independently. Python must reside within the permitted system runtime
roots. Private receipts identify those executable paths. Its execution view
remains read-only; writes use the view's private temporary directory.
Network access permits loopback services only. There is
no writeback, commit, push, or promotion API. Review a candidate separately.

Each session expires after one hour and permits at most six jobs. Command
loop execution has a ten-minute wall bound. A command has a two-minute bound. Captured output has an
eight-MiB job bound; the client bounds response allocation separately. Private
receipts retain the fixed hashes, candidate hash, command results, and limits.
The service publishes a positive result only after its receipt write completes.
A receipt write failure returns a failed result without a receipt path.
Failed startup removes its matching pairing marker before relaunch.
Frozen-source reads and captured output have byte bounds. Git history cloning
and private copying have no explicit byte cap. Setup and receipt I/O do not
have a hard wall deadline. Cancellation acknowledgement waits for
those operations. The client can report cancellation unconfirmed during slow I/O.

Stop requests process-group termination and awaits the server acknowledgement.
An observation timeout does not establish termination. The client requests
cancellation after an observation failure. Cancellation discards the result.
An acknowledged Stop also discards an already completed job's verdict.
It never applies execution-view writes to the mounted checkout. Deliberately
detached descendants escaping their process group are not claimed terminated.
This first adapter does not claim a general hostile-process sandbox contract.
Use only owner-managed disposable checkouts with stable directory ancestry.

The current macOS adapter does not complete the repository's Chrome-backed
SQLite and Worker checks. The recorded Anvil replay passes 227 of 229 frozen
commands before Chrome startup fails. Keep that full gate incomplete.
Do not skip those commands or treat a separate browser criterion as its pass.

Disconnect through Advanced after the run. Close the local service with Ctrl+C.
The service leaves its private receipts for review. Other operating systems
require their own execution adapter; this service refuses them.

The portable protocol/grant tests run in CI. macOS additionally exercises the
actual positive native gate, synthetic outside-read/write denial, source-pin
refusal, and Stop. Those platform-specific observations do not establish Linux
native execution support.
