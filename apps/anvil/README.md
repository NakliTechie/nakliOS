# Anvil

A browser-native **coding-agent desktop** — a chat-first client for the naklios
agent. Three panes:

- **Left** — projects → tasks (each task is an agent conversation over a workspace).
- **Center** — the chat: your prompts, the agent's replies, and a live, collapsible
  trace of every tool call it makes.
- **Right** — a **preview** pane that opens only when a task has something to show
  (rendered HTML, a diff, command/file output) and collapses when it doesn't.

Not an IDE. The agent reads and writes your files; you drive it in conversation
and review what it produced.

No server, no build, no data leaving the device. A naklios app at `apps/anvil/`,
the GUI sibling of **Forge** (the terminal). Both run the same agent core —
`sys/ai` (`runAgentLoop` + `codingToolset`) over `sys/rig` (fileops/git/agent).

## The agent is live inside NakliOS
The chat calls the host agent-tier inference (`window.naklios.ai`, `agent: true`) —
the exact transport Forge uses. Run Anvil inside NakliOS (naklios.dev) with a
model set in Settings → AI and it drives real tool-using runs. Opened standalone
(bare file server) it renders fully but reports honestly that it needs the host.

## Workspace
In-memory scratch by default; **Open folder** points the agent at a real local
folder (File System Access), remembered across reloads (IndexedDB). Same substrate
as Forge.

## Run (local)

    cd ~/Code/naklios-universe/naklios && python3 -m http.server 8080
    open http://localhost:8080/apps/anvil/

## Status
Working: three-pane shell, projects/tasks (localStorage), chat transcript + tool
trace, collapsible preview (HTML/diff/text), live agent transport, folder open.
Next: diff-review accept/reject of staged edits, per-project workspace binding,
richer preview (running app / git status), Crate-backed task persistence.
