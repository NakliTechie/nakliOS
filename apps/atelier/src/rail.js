// The NakliOS common rail (protocol v3): Atelier's manifest tools as host commands (spec 002 §9.5).
// The rail name is the manifest handler id (`<noun>.<verb>`; the host prefixes `atelier.`), the scope
// follows the effect, and person-only tools never become commands (the app contract forbids it).

const SCOPE = { read: 'read', mutate: 'write', irreversible: 'destructive' };

// Pure: manifest → commands.json `commands` entries (no handlers).
export function railCommands(manifest) {
  return manifest.tools
    .filter((t) => !t.personOnly)
    .map((t) => ({ name: t.handler, description: t.description, scope: SCOPE[t.effect], input: t.inputSchema, tool: t.name }));
}

// Registers every rail command that has a handler on the bus; each calls the same bus as every other door.
// Commands without a handler are left off rather than registered as stubs. Standalone, the SDK keeps the
// handlers and sends nothing.
export async function registerRail(naklios, bus) {
  const rail = naklios?.experimental_commands;
  if (!rail) return { registered: [], skipped: 'no rail in this SDK' };
  const list = railCommands(bus.manifest)
    .filter((c) => bus.has(c.name))
    .map(({ tool, ...c }) => ({
      ...c,
      handler: (args, context) => bus.dispatch(tool, args ?? {}, { door: 'rail', caller: context?.caller }),
    }));
  const reply = await rail.register(list);
  return { registered: list.map((c) => c.name), reply };
}
