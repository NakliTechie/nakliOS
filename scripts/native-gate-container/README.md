# Isolated native gate runtime

The optional owner-launched adapter keeps Anvil's existing paired `native-gate` command.
The owner supplies `--container-config <json>` to `native-gate-server.mjs`.
Agent requests cannot select images, mounts, network policy, or browser arguments.

Configuration contains `image` (local immutable sha256 image ID), `assets` (absolute directory),
`seccomp` (absolute policy file), `seccompSha256`, and optional absolute `docker` executable.
Prepare these before starting the server. The adapter never downloads assets or provisions services.

Build the image from the inspected pinned local base using `BASE_RUNTIME`.
Record the base image ID before building; pin the resulting image ID in the owner configuration.
The guest entry installs its synthetic runtime certificate only in disposable `/tmp/home/.pki/nssdb`.
It serves manifest-listed Pyodide 0.26.4 files on guest loopback for `cdn.jsdelivr.net`.
Do not import this certificate into the host keychain or a user's browser profile.

The asset directory contains `assets-manifest.json`, pinned module/wasm/stdlib/SQLite bytes,
and `runtime-cert.pem` plus its synthetic `runtime-key.pem`.
Each manifest item has `bytes` and `sha256`, including both synthetic certificate files. The existing Pyodide entry digest remains mandatory.
Use a short-lived certificate; regenerate the disposable preparation when it expires.
The image needs NSS tools and the original Node24/Git/Python/Chromium runtimes.

Execution uses network:none, a read-only root and source/asset mounts, UID65532,
zero capabilities, no-new-privileges, and the pinned syscall policy.
CPU, memory, PID, tmpfs, and output/time bounds remain explicit.
Chrome receives the original frozen test arguments; no certificate-ignore or no-sandbox flag is added.
The adapter creates an owned container before starting it.
It checks the actual created PID, IPC, UTS, cgroup, and network namespace settings.
Stop confirms that owned container is inactive before acknowledging cancellation.
Container cleanup applies only to randomly named containers created by this adapter.

Portable rejection tests do not establish real containment or full Anvil acceptance.
Those claims require the unchanged browser suites, real isolation/cancellation evidence,
and the actual model/shell run with frozen source hashes and remote-independent receipts.

Docker's private PID and UTS modes use empty mode strings; private IPC/cgroup modes use `private`.
The adapter supplies those modes explicitly and refuses different inspect results before start.
Reference: https://docs.docker.com/reference/cli/docker/container/run/
