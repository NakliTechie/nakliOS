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
    name: 'list-deck-options',
    description: 'List the languages and topics any AnkiGen deck can be built from. Returns a promise.',
    params: {},
    ui: 'The language and topic menus under "Build any AnkiGen deck".',
    run: (r) => r.deckOptions(),
  },
  {
    name: 'build-deck',
    description:
      'Build an AnkiGen deck on the device and show its first card. know is a language code, or "=" for definitions in the learned language. Returns a promise.',
    params: { learn: 'string, a language code', know: 'string, a language code or "="', modules: 'string[], topic ids from list-deck-options' },
    ui: 'The "Build and open" button under "Build any AnkiGen deck".',
    run: (r, a) => r.buildDeck({ learn: String(a?.learn ?? ''), know: String(a?.know ?? ''), modules: Array.isArray(a?.modules) ? a.modules.map(String) : [] }),
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
    description: 'Turn the current card between question and answer. typed is an answer to compare on a type-in card.',
    params: { typed: 'string, optional: what was typed into a type-in answer box' },
    ui: 'The "Flip" button, or Space / Enter (Enter in a type-in box flips too).',
    run: (r, a) => r.flip(a?.typed === undefined ? undefined : String(a.typed)),
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
    name: 'toggle-shuffle',
    description: 'Shuffle the deck being browsed, or return to deck order. The order is saved with the place.',
    params: {},
    ui: 'The "Shuffle" button above the card.',
    run: (r) => r.toggleShuffle(),
  },
  {
    name: 'speak-card',
    description: 'Return the text-to-speech parts of the current side ({ lang, text }); the page reads them aloud.',
    params: {},
    ui: 'The "Speak" buttons on a card with text-to-speech fields.',
    run: (r) => r.current().speech,
  },
  {
    name: 'download-deck',
    description: 'Return the last picker-built deck as { fileName, bytes }; the page saves it as an .apkg file.',
    params: {},
    ui: 'The "Download .apkg" button above a picker-built deck.',
    run: (r) => r.download(),
  },
  {
    name: 'toggle-theme',
    description: 'Switch between light (the default) and dark. Saved per viewer.',
    params: {},
    ui: 'The "Dark" / "Light" button in the header.',
    run: (r) => r.toggleTheme(),
  },
  {
    name: 'study-deck',
    description: 'Study a deck: due cards first, then new cards up to the daily limit, scheduled by FSRS.',
    params: { deckId: 'string, an id from list-decks; the open deck when omitted' },
    ui: 'The "Study" button above the card, or next to a deck in the deck list.',
    run: (r, a) => r.studyDeck(String(a?.deckId || r.deckId)),
  },
  {
    name: 'rate',
    description: 'Rate the card in study mode and show the next due card. 1 Again, 2 Hard, 3 Good, 4 Easy.',
    params: { rating: 'number, 1 to 4' },
    ui: 'The Again / Hard / Good / Easy buttons, or keys 1 to 4, after flipping in study mode.',
    run: (r, a) => r.rate(Number(a?.rating)),
  },
  {
    name: 'suspend-card',
    description: 'Hide the current card from study until progress is imported without it.',
    params: {},
    ui: 'The "Suspend" button in study mode.',
    run: (r) => r.suspendCard(),
  },
  {
    name: 'bury-card',
    description: 'Hide the current card from study for the rest of today.',
    params: {},
    ui: 'The "Bury" button in study mode.',
    run: (r) => r.buryCard(),
  },
  {
    name: 'flag-card',
    description: 'Flag the current card 1 to 4, or clear its flag with 0.',
    params: { flag: 'number, 0 to 4' },
    ui: 'The "Flag" button in study mode (cycles through the flags).',
    run: (r, a) => r.flagCard(Number(a?.flag)),
  },
  {
    name: 'set-new-limit',
    description: 'Set how many new cards study mode introduces per day (default 20).',
    params: { limit: 'number, 0 to 9999' },
    ui: 'The "New cards per day" box under Study progress.',
    run: (r, a) => r.setNewLimit(Number(a?.limit)),
  },
  {
    name: 'study-stats',
    description: "Today's reviews and new cards, the daily limit, the review streak in days, and how many cards have progress.",
    params: {},
    ui: 'The Study progress line on the start screen.',
    run: (r) => r.stats(),
  },
  {
    name: 'export-progress',
    description: 'Return all saved progress (places, study, settings) as JSON; the page saves it as a file.',
    params: {},
    ui: 'The "Export progress" button under Study progress.',
    run: (r) => r.exportProgress(),
  },
  {
    name: 'import-progress',
    description: 'Replace all saved progress with an exported JSON string.',
    params: { json: 'string, from export-progress' },
    ui: 'The "Import progress" button under Study progress (picks a file).',
    run: (r, a) => r.importProgress(String(a?.json ?? '')),
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
