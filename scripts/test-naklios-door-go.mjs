#!/usr/bin/env node
// The outside door's Go relay (tools/naklios-door): `go vet` and `go test`, run from the Node gate because the
// workflow admits only Node commands (scripts/native-gate-server.mjs). Go is preinstalled on ubuntu-latest; a
// machine without Go fails here, loudly, rather than skipping the relay's origin and Host-header tests.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('../tools/naklios-door/', import.meta.url));
for (const args of [['vet', './...'], ['test', './...']]) {
  const run = spawnSync('go', args, { cwd, stdio: 'inherit' });
  if (run.error) { console.error(`naklios-door: go is required (${run.error.message})`); process.exit(1); }
  if (run.status !== 0) process.exit(run.status ?? 1);
}
console.log('naklios-door relay: go vet and go test pass');
