import { createU2Context } from './u2-common.mjs';
import { resolveVirtualPath } from './path-resolution.mjs';

// Resolve through governed metadata, then reject newly introduced aliases at
// the content boundary. Manifest targets use the same transport as operands.
export function createCanonicalContext({ command, io, stdin, signal, limits }) {
  let context;
  const transport = { ...io, async readBytes(path, options) {
    const resolved = await resolveVirtualPath(io, path, { context, mode: 'existing', followFinal: true });
    return io.readBytes('/' + resolved.path, { ...options, rejectSymlinks: true });
  } };
  context = createU2Context({ command, io: transport, stdin, signal, limits });
  return context;
}
