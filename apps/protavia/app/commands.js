// The agent face.
//
// Two doors, one core: every action the interface offers is declared once here, and both the
// buttons on the page and anything driving the page from outside go through the same entry. A
// control wired straight to its function would be a second door onto the same room, and the two
// would drift.
//
// Some acts are the person's and cannot be delegated. Those are declared `personOnly` with the
// reason, so the manifest says what an agent may not do instead of leaving it to be discovered by
// a call that silently does nothing. Opening a local file is the current example: the browser only
// gives a page a file after a real click on a file picker, which no script can produce.
//
// `window.protavia` publishes this. It is a read of the page's own state and the same commands the
// buttons run; it adds no capability the person does not already have on screen.

/**
 * @typedef {object} CommandSpec
 * @property {string} id
 * @property {string} summary       one sentence, in the second person
 * @property {Array<{name: string, type: string, required?: boolean, note?: string}>} params
 * @property {boolean} [personOnly] true = declared, never callable
 * @property {string} [why]         required when personOnly; what makes it the person's act
 */

/** @type {CommandSpec[]} */
export const COMMANDS = [
  {
    id: 'open-target',
    summary: 'Open a structure from the Protein Data Bank by its four-character entry ID.',
    params: [{ name: 'id', type: 'string', required: true, note: 'for example 1ubq' }],
  },
  {
    id: 'search',
    summary: 'Search the Protein Data Bank by name and list what comes back.',
    params: [{ name: 'text', type: 'string', required: true }],
  },
  {
    id: 'clear-target',
    summary: 'Close the current target and empty the viewer.',
    params: [],
  },
  {
    id: 'set-chain',
    summary: 'Choose which polymer chain a redesign will rewrite.',
    params: [{ name: 'chain', type: 'string', required: true, note: 'a chain ID from the summary' }],
  },
  {
    id: 'set-checkpoints',
    summary: 'Choose which ProteinMPNN checkpoints a redesign runs.',
    params: [{ name: 'ids', type: 'string[]', required: true, note: 'ids from list-checkpoints' }],
  },
  {
    id: 'list-checkpoints',
    summary: 'List the checkpoints this page can run and what each was trained differently on.',
    params: [],
  },
  {
    id: 'redesign',
    summary: 'Redesign the chosen chain with the chosen checkpoints and add the results to the table.',
    params: [
      { name: 'chain', type: 'string', note: 'defaults to the chain already chosen' },
      { name: 'checkpoints', type: 'string[]', note: 'defaults to the checkpoints already ticked' },
      { name: 'temperature', type: 'number', note: 'defaults to the value in the panel' },
      { name: 'count', type: 'number', note: 'sequences per checkpoint' },
      { name: 'seed', type: 'number' },
    ],
  },
  {
    id: 'rank',
    summary: 'Order the design table by one of its declared columns.',
    params: [
      { name: 'column', type: 'string', required: true, note: 'a column id from list-columns' },
      { name: 'descending', type: 'boolean' },
    ],
  },
  {
    id: 'filter',
    summary: 'Keep only the designs that are at least this good on one column.',
    params: [
      { name: 'column', type: 'string', required: true, note: 'a column id from list-columns' },
      { name: 'value', type: 'number|string', note: 'a threshold, or omit to drop this filter' },
    ],
  },
  {
    id: 'clear-filters',
    summary: 'Show every design again.',
    params: [],
  },
  {
    id: 'list-columns',
    summary: 'List the design table’s columns, and say which of them may order it.',
    params: [],
  },
  {
    id: 'designs',
    summary: 'Read the design table as it currently stands, in its current order.',
    params: [],
  },
  {
    id: 'target',
    summary: 'Read the summary of the structure now on screen.',
    params: [],
  },
  {
    id: 'host',
    summary: 'Read which machine a design run would happen on, and which engines it has.',
    params: [],
  },
  {
    id: 'load-run',
    summary: 'Read a compute run\u2019s accepted designs into the table beside the browser\u2019s own.',
    params: [{ name: 'runId', type: 'string', required: true, note: 'from the bridge' }],
  },
  {
    id: 'show-tour',
    summary: 'Open the guided tour of the page.',
    params: [],
  },
  {
    id: 'open-file',
    summary: 'Open a structure file from this machine.',
    params: [{ name: 'file', type: 'File' }],
    personOnly: true,
    why: 'A browser hands a page a local file only after a real click on a file picker or a real '
      + 'drag onto the page, so this is the person’s act and no script can stand in for it.',
  },
];

/**
 * Bind the manifest to its implementations.
 *
 * Every command declared above needs one, and nothing may be implemented that is not declared.
 * Both halves are checked here rather than in a separate linter, because a mismatch is a bug in
 * one of the two doors and should stop the page at load, where it is obvious.
 *
 * @param {Record<string, (args: object) => any>} implementations keyed by command id
 */
export function createRegistry(implementations) {
  const callable = COMMANDS.filter((c) => !c.personOnly);

  for (const spec of callable) {
    if (typeof implementations[spec.id] !== 'function') {
      throw new Error(`Command "${spec.id}" is declared but not implemented.`);
    }
  }
  for (const id of Object.keys(implementations)) {
    if (!COMMANDS.some((c) => c.id === id)) {
      throw new Error(`"${id}" is implemented but not declared in COMMANDS.`);
    }
    if (COMMANDS.find((c) => c.id === id).personOnly) {
      throw new Error(`"${id}" is declared person-only and must not be implemented.`);
    }
  }

  function describe() {
    return COMMANDS.map((c) => ({
      id: c.id,
      summary: c.summary,
      params: c.params,
      personOnly: Boolean(c.personOnly),
      ...(c.personOnly ? { why: c.why } : {}),
    }));
  }

  async function run(id, args = {}) {
    const spec = COMMANDS.find((c) => c.id === id);
    if (!spec) throw new Error(`No command called "${id}". Try protavia.commands().`);
    if (spec.personOnly) throw new Error(`"${id}" is the person’s to do. ${spec.why}`);

    for (const p of spec.params) {
      if (p.required && (args[p.name] === undefined || args[p.name] === null)) {
        throw new Error(`"${id}" needs ${p.name} (${p.type}).`);
      }
    }
    return implementations[id](args);
  }

  return { commands: describe, run };
}
