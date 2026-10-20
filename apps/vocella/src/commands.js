// The command manifest: every action the page can take, in one list. The buttons and keys dispatch through
// `run`, and the same list is the agent face (window.vocella.tools / window.vocella.run). The parity test
// checks that every data-command in the page names an entry here, and that every entry names its UI door.
//
// personOnly marks an act an agent may not take for the person, with the reason. Never left implicit.

/** @typedef {import('./reader.js').Reader} Reader */
/**
 * @typedef {{
 *   name: string, description: string, params: Record<string, string>, ui: string,
 *   personOnly?: string, run?: (reader: Reader, args: any) => any
 * }} Command
 */

/** @type {Command[]} */
export const COMMANDS = [
  {
    name: 'import-deck',
    description: 'Open an Anki package (.apkg or .colpkg) from your disk.',
    params: {},
    ui: 'The "Open .apkg" button, or dropping a file on the page.',
    personOnly: 'Choosing a file from your disk is your act; the page offers no way to read files you did not pick.',
  },
  {
    name: 'list-shelf',
    description: 'List the onboarded language decks that ship with the app.',
    params: {},
    ui: 'The "Language decks" shelf on the start screen.',
    run: (r) => r.shelf(),
  },
  {
    name: 'open-shelf-deck',
    description: 'Open an onboarded deck by id and show its first card, question side. Returns a promise.',
    params: { id: 'string, an id from list-shelf' },
    ui: 'Clicking a deck on the "Language decks" shelf.',
    run: (r, a) => r.openShelfDeck(String(a?.id ?? '')),
  },
  {
    name: 'list-decks',
    description: 'List the decks in the open file (yours or an onboarded one), with card counts (a deck counts its subdecks).',
    params: {},
    ui: 'The deck list shown after a file opens.',
    run: (r) => r.decks(),
  },
  {
    name: 'open-deck',
    description: 'Open a deck by id and show its first card, question side.',
    params: { deckId: 'string, an id from list-decks' },
    ui: 'Clicking a deck in the deck list.',
    run: (r, a) => r.openDeck(String(a?.deckId ?? '')),
  },
  {
    name: 'flip',
    description: 'Turn the current card between question and answer.',
    params: {},
    ui: 'The "Flip" button, or Space / Enter.',
    run: (r) => r.flip(),
  },
  {
    name: 'next-card',
    description: 'Go to the next card, question side.',
    params: {},
    ui: 'The "Next" button, or the right arrow key.',
    run: (r) => r.move(1),
  },
  {
    name: 'prev-card',
    description: 'Go to the previous card, question side.',
    params: {},
    ui: 'The "Previous" button, or the left arrow key.',
    run: (r) => r.move(-1),
  },
  {
    name: 'show-card',
    description: 'Return the current card: deck, position, side, and its text.',
    params: {},
    ui: 'The card frame and the position line under it.',
    run: (r) => r.current(),
  },
  {
    name: 'close-deck',
    description: 'Leave the deck and go back to the start screen.',
    params: {},
    ui: 'The "Decks" button above the card.',
    run: (r) => r.closeDeck(),
  },
];

/** The manifest without handlers, as published to agents. */
export const tools = () => COMMANDS.map(({ run, ...rest }) => rest);

/**
 * Run a command by name. Person-only commands refuse when called by an agent.
 * @param {Reader} reader @param {string} name @param {any} [args] @param {{ person?: boolean }} [opts]
 */
export function run(reader, name, args, opts = {}) {
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) throw new Error(`Unknown command "${name}". Known: ${COMMANDS.map((c) => c.name).join(', ')}.`);
  if (cmd.personOnly && !opts.person) throw new Error(`"${name}" is person-only: ${cmd.personOnly}`);
  if (!cmd.run) throw new Error(`"${name}" runs from the page only.`);
  return cmd.run(reader, args);
}
