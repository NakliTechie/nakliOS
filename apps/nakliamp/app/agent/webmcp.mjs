// webmcp.mjs — register NakliAmp's commands as WebMCP tools when the browser offers it (N5).
//
// WebMCP is a W3C Web Machine Learning community group proposal
// (github.com/webmachinelearning/webmcp). Its spec, checked 2026-11-16, defines
// `document.modelContext.registerTool(tool, { signal })`, where `tool` is
// `{ name, title, description, inputSchema, execute(input, { signal }), annotations }`
// and aborting the signal unregisters it. Earlier drafts and polyfills put the object on
// `navigator.modelContext`, so both are checked. Tool names may hold letters, digits,
// `_`, `-` and `.`, so NakliAmp's command names are used as they are.
//
// Every read and reversible command becomes a tool whose `execute` calls the bound
// runner, `run(name, input)`, so input validation and refusals are the same as for the
// keyboard and the NakliOS rail. Destructive commands are registered only when the
// browser offers a user-confirmation hook (`requestUserInteraction`, from earlier
// drafts); the current spec has only the `consequentialHint` annotation, which a browser
// may ignore, so today they are not registered at all. Even when registered, the runner
// still asks the person through its own confirm dialog. With no WebMCP, this is a no-op.

import { COMMANDS } from '../commands/commands.mjs';

const NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** The page's model context, or null when the browser has no WebMCP. */
export function modelContextOf(env = globalThis) {
  for (const mc of [env?.document?.modelContext, env?.navigator?.modelContext]) {
    if (mc && typeof mc.registerTool === 'function') return mc;
  }
  return null;
}

/** True when the model context can ask the person before a tool runs. */
export const hasConfirmationHook = mc => typeof mc?.requestUserInteraction === 'function';

function toolResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value ?? null) }] };
}

/** The WebMCP tool for one command. */
export function toolFor(command, run) {
  return {
    name: command.name,
    title: command.label,
    description: command.description,
    inputSchema: command.input,
    annotations: {
      readOnlyHint: command.scope === 'read',
      consequentialHint: command.scope === 'destructive',
      untrustedContentHint: command.scope === 'read', // tag text comes from files the page did not write
    },
    async execute(input, options = {}) {
      try {
        const result = await run(command.name, input ?? {}, { context: { from: 'webmcp', signal: options?.signal ?? null } });
        return toolResult(result);
      } catch (error) {
        return { content: [{ type: 'text', text: String(error?.message || error) }], isError: true };
      }
    },
  };
}

/** Why a command is not offered over WebMCP, or null when it can be. */
function refusalFor(command, confirmable) {
  if (!NAME.test(command.name)) return 'name not allowed by WebMCP';
  if (command.scope === 'destructive' && !confirmable) return 'destructive, and this browser offers no confirmation hook';
  return null;
}

/** Drafts before the signal option used unregisterTool(name). */
function unregisterByName(mc, names) {
  if (typeof mc.unregisterTool !== 'function') return;
  for (const name of names) { try { mc.unregisterTool(name); } catch { /* already gone */ } }
}

/**
 * Register the commands. Returns
 * `{ available, registered: [names], skipped: [{ name, reason }], unregister() }`.
 */
export async function registerWebMcpTools({ run, commands = COMMANDS, env = globalThis } = {}) {
  const mc = modelContextOf(env);
  const out = { available: !!mc, registered: [], skipped: [], unregister: () => {} };
  if (!mc) return out;
  if (typeof run !== 'function') throw new TypeError('registerWebMcpTools needs the bound command runner');

  const controller = new AbortController();
  const confirmable = hasConfirmationHook(mc);
  for (const command of commands) {
    const refusal = refusalFor(command, confirmable);
    if (refusal) { out.skipped.push({ name: command.name, reason: refusal }); continue; }
    try {
      await mc.registerTool(toolFor(command, run), { signal: controller.signal });
      out.registered.push(command.name);
    } catch (error) {
      out.skipped.push({ name: command.name, reason: String(error?.message || error) });
    }
  }
  out.unregister = () => {
    controller.abort();
    unregisterByName(mc, out.registered);
  };
  return out;
}
