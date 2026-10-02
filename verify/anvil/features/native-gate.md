# Owner-authorized native gate

### button:native-gate-btn
- **Goal:** connect a disposable Folder workspace to its bounded native gate.
- **Source:** Advanced → `#native-gate-btn`; `sys/rig/native-gate/client.mjs`; `scripts/native-gate-server.mjs`.
- **Prerequisites:** launch from the service's approved origin; mount its disposable checkout; create the owner connection file as described in `docs/native-gate.md`.
- **Reach and drive:** open Advanced; select Native gate connection; upload the connection file through the file picker. Run `native-gate criterion`, then `native-gate full` through Anvil's normal shell tool. Start a slow approved run; press Stop. Disconnect through the same button. Reconnect, then switch projects or workspaces.
- **Observable success:** pairing checks the checkout binding before exposing `native.gate`. Native results preserve exit codes. Full runs preserve every frozen workflow command and argument. Stop awaits cancellation. Disconnect or a workspace switch removes native authority. The connected grant permits edits only to the owner's exact mutable production path.
- **Refusals:** another workspace's binding, expired descriptors, remote endpoints, unsupported modes, extra shell operands, selected-range edits, and changed frozen sources refuse. Unpaired workspaces expose no native command. Attempts to write sibling paths, ancestors, criteria, or workflow files refuse.
- **Gotchas:** the descriptor contains a bearer credential. Keep it outside the workspace. Do not save it in task text or transcripts. Pairing lasts for this page session. Receipts prove bounded execution and process-group cancellation; they do not establish general hostile-process containment.
