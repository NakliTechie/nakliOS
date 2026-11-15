// The command manifest: every action the page can take, in one list (doctrine rule 6, two doors, one core).
// The page's buttons dispatch through `run`, the NakliOS rail registers the same handlers, and window.lectella
// exposes them to an outside agent. `ui` names the control that does the same thing. `personOnly` marks an act
// an agent may not take for the person, with the reason. The tests check commands.json and the page against it.

import { buildIndex, search } from './core.js';

/** @typedef {import('./store.js').Library} Library */
/**
 * @typedef {{ name: string, description: string, scope: 'read' | 'write' | 'destructive', ui: string,
 *   input: { type: 'object', properties: Record<string, any>, required?: string[] },
 *   personOnly?: string, run?: (lib: Library, args: any) => Promise<any> | any }} Command
 */

const str = (/** @type {string} */ description, extra = {}) => ({ type: 'string', description, ...extra });
const none = () => ({ type: /** @type {const} */ ('object'), properties: {} });

/** @param {Library} lib @param {any} ref */
function nbOf(lib, ref) {
  const nb = lib.findNotebook(String(ref ?? ''));
  if (!nb) throw new Error(`No notebook named or with id "${ref}". Call notebook.list to see them.`);
  return nb;
}

/** @type {Command[]} */
export const COMMANDS = [
  {
    name: 'notebook.list',
    description: 'List the notebooks in Lectella, newest first, with how many sources and notes each holds.',
    scope: 'read',
    ui: 'The notebook list in the left column.',
    input: none(),
    run: (lib) => lib.notebooks().map((n) => ({ id: n.id, name: n.name, description: n.description, sources: n.sources.length, notes: n.notes.length })),
  },
  {
    name: 'notebook.create',
    description: 'Create a notebook for one research topic.',
    scope: 'write',
    ui: 'The "New notebook" button.',
    input: { type: 'object', properties: { name: str('Notebook name', { minLength: 1 }), description: str('What the notebook is about; the model reads it in chat') }, required: ['name'] },
    run: async (lib, a) => {
      const nb = await lib.createNotebook({ name: a?.name, description: a?.description });
      return { id: nb.id, name: nb.name };
    },
  },
  {
    name: 'notebook.update',
    description: 'Rename a notebook or change its description.',
    scope: 'write',
    ui: 'The "Edit" button beside the open notebook\'s name.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id'), name: str('New name'), description: str('New description') }, required: ['notebook'] },
    run: async (lib, a) => {
      const nb = await lib.updateNotebook(nbOf(lib, a?.notebook).id, { name: a?.name, description: a?.description });
      return { id: nb.id, name: nb.name, description: nb.description };
    },
  },
  {
    name: 'notebook.delete',
    description: 'Delete a notebook with its notes and chat. Sources that no other notebook uses are deleted too.',
    scope: 'destructive',
    ui: 'The "Delete notebook" button in the notebook\'s edit dialog.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id') }, required: ['notebook'] },
    run: (lib, a) => lib.deleteNotebook(nbOf(lib, a?.notebook).id),
  },
  {
    name: 'source.list',
    description: 'List the sources in a notebook, with whether each is switched on for chat.',
    scope: 'read',
    ui: 'The Sources column.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id') }, required: ['notebook'] },
    run: (lib, a) => {
      const nb = nbOf(lib, a?.notebook);
      return lib.sourcesOf(nb.id).map((s) => ({ id: s.id, title: s.title, kind: s.kind, chars: s.chars, inChat: !nb.off.includes(s.id) }));
    },
  },
  {
    name: 'source.add',
    description: 'Add a text source (pasted text or Markdown) to a notebook. The same text twice is not added again: status is added, present (already there) or linked (taken from another notebook).',
    scope: 'write',
    ui: 'The "Add source" button, Paste text tab.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id'), title: str('Source title'), text: str('The source text', { minLength: 1 }) }, required: ['notebook', 'text'] },
    run: async (lib, a) => {
      const { source: s, status } = await lib.importSource(nbOf(lib, a?.notebook).id, { title: a?.title, text: a?.text, origin: 'command' });
      return { id: s.id, title: s.title, chars: s.chars, status };
    },
  },
  {
    name: 'source.import',
    description: 'Add a PDF, Markdown or text file from your disk as a source. A PDF needs a text layer.',
    scope: 'write',
    ui: 'The "Add source" button, Choose file, or dropping a file on the Sources column.',
    input: none(),
    personOnly: 'Choosing a file from your disk is your act; the page reads only files you pick.',
  },
  {
    name: 'source.read',
    description: 'Read a source\'s full text.',
    scope: 'read',
    ui: 'Clicking a source in the Sources column.',
    input: { type: 'object', properties: { source: str('Source id from source.list') }, required: ['source'] },
    run: async (lib, a) => ({ ...lib.source(String(a?.source)), text: await lib.sourceText(String(a?.source)) }),
  },
  {
    name: 'source.rename',
    description: 'Change a source\'s title.',
    scope: 'write',
    ui: 'The "Rename" button in the source viewer.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id'), source: str('Source id'), title: str('New title', { minLength: 1 }) }, required: ['notebook', 'source', 'title'] },
    run: async (lib, a) => {
      const s = await lib.renameSource(nbOf(lib, a?.notebook).id, String(a?.source), a?.title);
      return { id: s.id, title: s.title };
    },
  },
  {
    name: 'source.remove',
    description: 'Remove a source from a notebook. Its files are deleted when no other notebook uses it.',
    scope: 'destructive',
    ui: 'The "Remove" button in the source viewer.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id'), source: str('Source id') }, required: ['notebook', 'source'] },
    run: (lib, a) => lib.removeSource(nbOf(lib, a?.notebook).id, String(a?.source)),
  },
  {
    name: 'context.set',
    description: 'Switch a source or note in or out of the notebook\'s chat context.',
    scope: 'write',
    ui: 'The checkbox beside each source and note.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id'), item: str('Source or note id'), on: { type: 'boolean', description: 'true to include it in chat' } }, required: ['notebook', 'item', 'on'] },
    run: async (lib, a) => {
      await lib.setInChat(nbOf(lib, a?.notebook).id, String(a?.item), !!a?.on);
      return { item: String(a?.item), on: !!a?.on };
    },
  },
  {
    name: 'note.list',
    description: 'List the notes in a notebook, newest first.',
    scope: 'read',
    ui: 'The Notes column.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id') }, required: ['notebook'] },
    run: (lib, a) => {
      const nb = nbOf(lib, a?.notebook);
      return lib.notesOf(nb.id).map((n) => ({ id: n.id, title: n.title, kind: n.kind, updated: n.updated, inChat: !nb.off.includes(n.id) }));
    },
  },
  {
    name: 'note.read',
    description: 'Read a note\'s Markdown.',
    scope: 'read',
    ui: 'Clicking a note in the Notes column.',
    input: { type: 'object', properties: { note: str('Note id from note.list') }, required: ['note'] },
    run: async (lib, a) => ({ ...lib.note(String(a?.note)), body: await lib.noteBody(String(a?.note)) }),
  },
  {
    name: 'note.add',
    description: 'Write a new note in a notebook.',
    scope: 'write',
    ui: 'The "New note" button.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id'), title: str('Note title'), body: str('Markdown text') }, required: ['notebook', 'body'] },
    run: async (lib, a) => {
      const n = await lib.addNote(nbOf(lib, a?.notebook).id, { title: a?.title, body: a?.body, kind: 'human' });
      return { id: n.id, title: n.title };
    },
  },
  {
    name: 'note.update',
    description: 'Change a note\'s title or Markdown.',
    scope: 'write',
    ui: 'The note editor\'s Save button.',
    input: { type: 'object', properties: { note: str('Note id'), title: str('New title'), body: str('New Markdown text') }, required: ['note'] },
    run: async (lib, a) => {
      const n = await lib.updateNote(String(a?.note), { title: a?.title, body: a?.body });
      return { id: n.id, title: n.title };
    },
  },
  {
    name: 'note.delete',
    description: 'Delete a note.',
    scope: 'destructive',
    ui: 'The note editor\'s Delete button.',
    input: { type: 'object', properties: { note: str('Note id') }, required: ['note'] },
    run: async (lib, a) => {
      await lib.deleteNote(String(a?.note));
      return { deleted: String(a?.note) };
    },
  },
  {
    name: 'notebook.search',
    description: 'Keyword search over a notebook\'s sources and notes; returns the best-matching passages. Works without AI.',
    scope: 'read',
    ui: 'The search box above the Sources column.',
    input: { type: 'object', properties: { notebook: str('Notebook name or id'), query: str('Words to look for', { minLength: 1 }), limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['notebook', 'query'] },
    run: async (lib, a) => searchNotebook(lib, nbOf(lib, a?.notebook).id, String(a?.query ?? ''), Number(a?.limit) || 8),
  },
  {
    name: 'notebook.briefing',
    description: 'Summarise each source switched on for chat, then combine the summaries into one briefing note that cites them.',
    scope: 'write',
    ui: 'The "Briefing" button above the notes list.',
    input: none(),
    personOnly: 'A briefing sends your sources to the model you chose in NakliOS; you start it, so you see what is sent.',
  },
  {
    name: 'notebook.audio',
    description: 'Write a two-voice audio overview script from the sources switched on for chat, saved as a note you can play.',
    scope: 'write',
    ui: 'The "Audio overview" button above the notes list.',
    input: none(),
    personOnly: 'It sends your sources to the model you chose in NakliOS; you start it, so you see what is sent.',
  },
  {
    name: 'notebook.mindmap',
    description: 'Make a mind map of the sources switched on for chat, saved as a note that draws it.',
    scope: 'write',
    ui: 'The "Mind map" button above the notes list.',
    input: none(),
    personOnly: 'It sends your sources to the model you chose in NakliOS; you start it, so you see what is sent.',
  },
  {
    name: 'notebook.slides',
    description: 'Make a slide deck from the sources switched on for chat, saved as a note you can present.',
    scope: 'write',
    ui: 'The "Slides" button above the notes list.',
    input: none(),
    personOnly: 'It sends your sources to the model you chose in NakliOS; you start it, so you see what is sent.',
  },
  {
    name: 'note.present',
    description: 'Show a slide deck note full screen.',
    scope: 'read',
    ui: 'The "Present" button in a slides note.',
    input: none(),
    personOnly: 'Full screen needs your click; a browser refuses it otherwise.',
  },
  {
    name: 'note.listen',
    description: 'Read the open note aloud with this device\'s voices; an audio overview plays in two voices.',
    scope: 'read',
    ui: 'The "Listen" button in the note editor.',
    input: none(),
    personOnly: 'Playback is something you start and stop in the page.',
  },
  {
    name: 'storage.choose',
    description: 'Choose where the library lives: this browser, your NakliOS Folder, or your Crate. Each is a separate library.',
    scope: 'write',
    ui: 'The "Library in" menu in the header.',
    input: none(),
    personOnly: 'Where your library lives is your decision; switching shows a different library and copies nothing.',
  },
  {
    name: 'chat.ask',
    description: 'Ask the notebook a question in chat, answered from the sources and notes switched on, with citations.',
    scope: 'write',
    ui: 'The chat box and its Send button.',
    input: none(),
    personOnly: 'A chat question sends your sources to the model you chose in NakliOS; you start it, so you see what is sent.',
  },
  {
    name: 'chat.save-note',
    description: 'Save a chat answer as an AI note, with its citations.',
    scope: 'write',
    ui: 'The "Save to note" button under each answer.',
    input: none(),
    personOnly: 'You pick which answer is worth keeping.',
  },
];

/** Search every source and note in a notebook (switched on or not). @param {Library} lib @param {string} nbId @param {string} query @param {number} limit */
export async function searchNotebook(lib, nbId, query, limit = 8) {
  const docs = [];
  for (const s of lib.sourcesOf(nbId)) docs.push({ id: s.id, title: s.title, chunks: await lib.sourceChunks(s.id) });
  const notes = lib.notesOf(nbId);
  const chunks = await lib.chunksFor(await Promise.all(notes.map(async (n) => ({ id: n.id, kind: 'note', text: await lib.noteBody(n.id) }))));
  for (const n of notes) docs.push({ id: n.id, title: n.title, chunks: chunks.get(n.id) ?? [] });
  const kinds = new Map([...lib.sourcesOf(nbId).map((s) => [s.id, 'source']), ...notes.map((n) => [n.id, 'note'])]);
  return search(buildIndex(docs), query, limit).map((h) => ({ kind: kinds.get(h.docId), id: h.docId, title: h.title, passage: h.chunk + 1, text: h.text, score: Math.round(h.score * 100) / 100 }));
}

/** The commands an agent may call: every one with a handler and no personOnly reason. */
export const railCommands = () => COMMANDS.filter((c) => c.run && !c.personOnly);

/** The commands.json manifest the host reads while the app is closed. */
export const ACCEPTS = [{ action: 'import', label: 'Add to Lectella', extensions: ['.pdf', '.md', '.markdown', '.txt'] }];

export function manifest() {
  return { accepts: ACCEPTS, commands: railCommands().map(({ name, description, scope, input }) => ({ name, description, scope, input })) };
}

/** @param {Library} lib @param {string} name @param {any} args */
export async function run(lib, name, args) {
  const c = COMMANDS.find((x) => x.name === name);
  if (!c) throw new Error(`Lectella has no command "${name}"`);
  if (!c.run) throw new Error(`${name} is done in the page: ${c.personOnly}`);
  return c.run(lib, args ?? {});
}
