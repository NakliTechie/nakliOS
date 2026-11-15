# Anvil

A browser-native coding-agent desktop. You describe work in a conversation,
inspect the agent's tool calls, and review its changes.

- The left pane lists projects, tasks, and workspace files.
- The center pane holds the conversation and collapsible tool traces.
- The right pane shows generated HTML, files, documents, or change reviews.
  On smaller screens, the Chat, Preview, and Files controls switch surfaces.

Anvil shares its agent loop, file tools, Git operations, and browser shell with
[Forge](../forge/README.md). No application build is required.

## Start Anvil

Open [NakliOS](https://naklios.dev/), then open Anvil. Anvil calls tools on the
model chosen in Settings → AI: LFM3 1.7B running in the browser (the default,
nothing leaves the device), or an OpenAI-compatible or Anthropic-compatible
endpoint you configure. With an endpoint, prompts and selected context go to that
provider.
See [storage and AI settings](../../docs/desktop-reference.md).

For a local checkout, use Node 24 from the NakliOS repository root:

```sh
node scripts/serve-coi.mjs
```

Open `http://127.0.0.1:8947/` and launch Anvil from the desktop. The server
supplies the cross-origin isolation headers used by browser runtimes.
Opening `/apps/anvil/` directly shows the interface, but agent requests require
the NakliOS host connection.

## Workspaces and saved work

Each project uses a separate workspace unless you choose **Open folder**:

| Storage | Where workspace files live |
| --- | --- |
| Connected host Folder or Crate | Under the project's Anvil workspace in the storage you grant through NakliOS. Files can browse that storage. |
| Browser storage | In the Origin Private File System (OPFS), a browser-managed filesystem that survives reloads but remains private to the browser profile. |
| Memory fallback | In temporary scratch storage when persistent storage cannot be opened. The workspace label identifies it. |

**Open folder** uses the browser's File System Access API to mount a real folder.
The selected folder overrides the per-project workspaces across project switches.
Anvil remembers its handle; reconnecting can require another permission grant.

Projects, tasks, and follow-up queues use local browser state. Carried conversation
context uses IndexedDB, the browser's local database. When host storage is
connected, Anvil also attempts to save session state there. Host saves detect
newer state from another tab; they do not merge concurrent edits across devices.

Run records use separate storage. **⋯ → Anvil home folder** selects a disk folder
outside the agent's workspace. Records also attempt browser and connected host
copies. Each run reports its saved copies and storage errors. Browser-only
records remain subject to browser retention and eviction.

## Agent controls

| Control | Behavior |
| --- | --- |
| Code | Offers file changes and execution through the workspace's granted tools. |
| Plan | Offers read-only investigation tools and proposes a plan. Replies longer than 200 characters can also be saved as project memory. |
| Ask | Answers questions using the read-only toolset. |
| Must-pass | Sets a verification command. Anvil distinguishes a passing gate from the agent's own completion claim. |
| Send during a run | Queues a follow-up. Queue entries can be edited, reordered, removed, or retried. Stop, errors, and uncertain startup hold automatic dispatch. |
| Stop | Cancels the run and pending child work. An external operation already submitted to its backend can still finish. |

**⋯ → Policy** controls permission rules and approval modes separately from
Code, Plan, and Ask. Hooks in `.anvil/hooks.json` can guard tools or run follow-up
commands. Protected paths and file grants also constrain execution.
The [shell reference](../../sys/rig/cli/cmds/README.md) lists supported commands
and capability limits; this is a browser shell rather than unrestricted access
to your computer's processes.

Project memory, on-demand skills, and **Learn from this project** provide context
for later tasks. Agent-authored skills are staged for owner activation.
Delegated work uses copy-on-write workspace overlays, with child progress shown
in the conversation. Merging child changes remains subject to ownership and
workspace-change checks.

Run records retain tool activity, model responses, usage when supplied, and stop
or verification outcomes. Later runs can search saved history and use recovery
notes. Reloading marks interrupted work explicitly; closing the browser does
not keep the agent running.

## Review changes

Open a run's changed-files row to inspect its combined line diff. Add comments
at line anchors, review the drafts, then choose **Apply this run's comments** to
send them as a follow-up. Changed source versions require refreshing stale
comments.

**Revert** is available only when the before-version remains available and the
storage backend supports the required atomic expected-content operation.
It refuses or skips files that changed after the reviewed version. Incomplete
capture, binary content, and size limits are disclosed in the review.
This per-run review does not provide a full staged/unstaged Git interface.

Editor can also send a selected file range to a separate Anvil snapshot task.
The result returns to Editor for review. Browser storage supports conditional
Apply and Revert; Folder and Crate retain the limitations in the
[selected-range edit contract](../../docs/editor-anvil-range-edit.md).

## Imported conversations

Open **⋯ → Imported conversations** to select one Claude Code or Codex JSONL file.
Anvil reads that selected file and keeps a bounded local copy in a separate
browser archive. It redacts common credential patterns; unrecognized secrets may
remain in the copy. It never edits the source file or treats foreign entries as
verified Anvil run events. Search the copy by text, project, provider, or date.
Each result opens its copied source line and nearby entries. Imports have a
32 MiB file cap and a 20,000-entry file cap. The archive holds up to 50 sources,
50,000 entries, and an estimated 128 MiB. Browser storage limits can stop an
import earlier. A partial import shows its limit. **Forget a source** removes
only its local copy, leaving the selected file untouched. If a tab closes during
import, the source shows as interrupted until you forget that copy. Importing a
later version of the same file creates a separate copy; forget the older one
when it is no longer needed.

## Optional and experimental capabilities

- [JavaScript scripts](../../docs/anvil-codemode.md) let a model compose tool
  calls inside a disposable Worker. They are off by default and retain the
  normal permission, hook, capture, and recording checks.
- **Advanced → Proof build** opens an experimental campaign with separate
  criterion, implementation, and checking roles.
- [Native gate connection](../../docs/native-gate.md) pairs an owner-prepared
  disposable macOS checkout with restricted verification commands. It is not
  a general terminal or native CLI launcher. Its full browser-backed acceptance
  remains incomplete.
