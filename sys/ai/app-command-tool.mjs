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
