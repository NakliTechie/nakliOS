# QuickJS WASI runtime

This pinned MIT package supports Anvil's opt-in JavaScript script tool.
The v3.6.2 directory contains the unmodified runtime modules, WASM, license, and package metadata.
The manifest retains npm's package integrity and each adopted file's SHA-256 and byte count.

The package does not grant guest network, filesystem, or application authority.
Anvil's Worker adapter supplies its narrow tool bridge and finite execution limits.
Extensions remain disabled. This copy includes their loader because the package entry imports it.

Source: https://registry.npmjs.org/quickjs-wasi/-/quickjs-wasi-3.6.2.tgz
License: v3.6.2/LICENSE

Status: A07 implementation in progress. No browser acceptance or default enablement is claimed.
