// app-command-tool.mjs — Anvil's door onto the common rail (docs/app-contract.md): one fixed tool that finds and calls
// the commands other NakliOS apps declare. Schemas load through a search, so the tool list stays the same in every
// run and a large catalog never sits in the prompt. The host applies the grant, the consent and the op-log.

const RESULT_MAX_CHARS = 8000;

export function appCommandTool() {
  return { type: 'function', function: {
    name: 'app_command',
    description: 'Use another NakliOS app: read a Reckon sheet, add a KanZen card, list Calendar events. '
      + 'Call with `query` to find commands and their inputs, then with `name` and `input` to run one. '
      + 'The person is asked before a command changes an app.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'Words to find commands by, e.g. "calendar events". Empty lists every command.' },
      name: { type: 'string', description: 'The full command name from a search, e.g. "reckon.range.read".' },
      input: { type: 'object', description: 'The command\'s input, as its search result describes.' },
    } },
  } };
}

function render(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  const body = text === undefined ? '(no result)' : text;
  return body.length > RESULT_MAX_CHARS ? body.slice(0, RESULT_MAX_CHARS) + '\n… (truncated)' : body;
}

/** @param {{ query?: string, name?: string, input?: object }} args @param {{ search: Function, call: Function }} commands */
export async function runAppCommand(args, commands) {
  if (!commands || typeof commands.call !== 'function' || typeof commands.search !== 'function')
    return 'App commands need Anvil to run inside NakliOS.';
  const { query, name, input } = args || {};
  try {
    if (!name) {
      const found = await commands.search(String(query || ''));
      return found.length ? render(found) : 'No app command matches "' + String(query || '') + '".';
    }
    const out = await commands.call(String(name), input && typeof input === 'object' ? input : {});
    if (out?.staged) return 'Staged for the person to accept in the review queue; it has not happened yet.';
    if (!out?.ok) return 'Error: ' + (out?.message || out?.code || name + ' did not answer');
    return render(out.result);
  } catch (error) {
    return 'Error: ' + String(error?.message || error);
  }
}

// The same rail for codemode scripts (sys/ai/codemode-record.mjs, CODEMODE_RAIL_TOOL_NAMES). A script gets JSON, not
// rendered text, and its calls never open a dialog: `ask:false` makes the host return ECONSENT where it would ask,
// because a script ends within 10 s and an answer given after that must not run anything.
export const RAIL_SEARCH_MAX = 20; // the host's own cap for one search (index.html, searchAppCommands)
const brief = c => ({ name: c.name, description: c.description, scope: c.scope ?? null, destructive: !!c.destructive, app: c.app ?? null });

/** @param {'rail_search'|'rail_describe'|'rail_call'} tool @param {any} args @param {{ search: Function, call: Function }} commands
 *  @param {{ notAfter?: number, token?: string }} [options] notAfter: the script's end (epoch ms); token: the script's
 *  name, which the caller abandons when the script ends early. The host starts no call after either. */
export async function runRailScriptTool(tool, args, commands, { notAfter, token } = {}) {
  if (!commands || typeof commands.call !== 'function' || typeof commands.search !== 'function')
    return { ok: false, code: 'ENOHOST', message: 'app commands need Anvil to run inside NakliOS' };
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  try {
    if (tool === 'rail_search') {
      if (a.query !== undefined && typeof a.query !== 'string') return { ok: false, code: 'EINVAL', message: 'query must be a string' };
      const found = await commands.search(a.query || '');
      return { ok: true, results: (Array.isArray(found) ? found : []).slice(0, RAIL_SEARCH_MAX).map(brief) };
    }
    if (typeof a.name !== 'string' || !a.name) return { ok: false, code: 'EINVAL', message: 'name must be a command name from rail_search' };
    if (tool === 'rail_describe') {
      const found = await commands.search(a.name);
      const hit = (Array.isArray(found) ? found : []).find(c => c.name === a.name);
      return hit ? { ok: true, command: { ...brief(hit), input: hit.input ?? null } } : { ok: false, code: 'ENOENT', message: 'no app command named ' + a.name };
    }
    if (tool === 'rail_call') {
      if (a.input !== undefined && (typeof a.input !== 'object' || a.input === null || Array.isArray(a.input))) return { ok: false, code: 'EINVAL', message: 'input must be an object' };
      const options = { ask: false };
      if (Number.isFinite(notAfter)) options.notAfter = notAfter;
      if (typeof token === 'string' && token) options.token = token;
      const out = await commands.call(a.name, a.input || {}, options);
      // A host that predates `ask:false` may still stage; the script must not report a staged change as done.
      if (out?.staged) return { ok: false, code: 'ESTAGED', message: 'staged for the person to review; it has not happened' };
      if (!out || typeof out !== 'object') return { ok: false, code: 'EFAIL', message: a.name + ' did not answer' };
      return out;
    }
    return { ok: false, code: 'EINVAL', message: 'unknown rail tool ' + String(tool) };
  } catch (error) {
    return { ok: false, code: 'EFAIL', message: String(error?.message || error).slice(0, 2000) };
  }
}
