// Rig command registry (C1) — public entry.
//
//   import { buildRigRegistry } from '/sys/rig/registry/index.mjs';
//   const fs = createFileops({ backend, root });
//   const registry = buildRigRegistry({ fs });
//   registry.searchCommands('read');          // metadata only
//   await registry.invokeCommand('fs.read', { path: 'a.txt', encoding: 'utf-8' });
//
// The registry is THE single capability shape; palette, faux CLI, window.rig,
// and Kiln bindings all consume it.
import { createRegistry, KNOWN_SCOPES } from './registry.mjs';
import { buildFileopsCommands } from './fileops-commands.mjs';
import { buildGitCommands } from './git-commands.mjs';
import { buildNativeCommands } from './native-commands.mjs';

export { createRegistry, KNOWN_SCOPES } from './registry.mjs';
export { buildFileopsCommands } from './fileops-commands.mjs';
export { buildGitCommands } from './git-commands.mjs';

/**
 * Build the Rig registry over a fileops instance, plus git commands when a
 * git core is supplied. Both surfaces share the one registry.
 * @param {object} opts
 * @param {object} opts.fs     a createFileops(...) instance
 * @param {object} [opts.git]  a createGitCore(...) instance
 */
export function buildRigRegistry({ fs, git, nativeGate }) {
  if (!fs) throw new Error('buildRigRegistry requires a fileops instance (fs)');
  return createRegistry([
    ...buildFileopsCommands(fs),
    ...(git ? buildGitCommands(git) : []),
    ...(nativeGate ? buildNativeCommands(nativeGate) : []),
  ]);
}
