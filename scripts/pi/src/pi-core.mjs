// pi-core.mjs — one Pi (pi-durable) session on NakliOS seams. No Worker or DOM code here, so the
// same module runs in the app's Worker and in node tests.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { createCodingTools } from '@earendil-works/pi-durable/tools';
import { JsonlStorage } from '@earendil-works/pi-durable/storage/jsonl';
import { createBrokerProvider, PROVIDER_ID, MODEL_ID } from './broker-provider.mjs';
import { createNakliosEnv } from './naklios-env.mjs';
import { createSkillsExtension } from './skills-extension.mjs';
import { createPruneExtension } from './prune-extension.mjs';

export const PI_INSTRUCTIONS = [
  'You run inside NakliOS, a desktop in the browser. Your workspace is /workspace.',
  'The bash tool runs the NakliOS rig shell, not GNU bash: it has pipelines, redirection, cd, cat, echo,',
  'printf, ls, grep, sed, awk, jq, find, diff, head, tail, wc, sort and similar commands, and python through',
  'Pyodide when available. There is no node, npm, git binary, network or package manager.',
].join(' ');

// The text of an assistant entry: its model message's text parts, joined.
export function answerText(entry) {
  const messages = Array.isArray(entry?.model) ? entry.model : entry?.model ? [entry.model] : [];
  const parts = messages.flatMap((m) => (Array.isArray(m?.content) ? m.content : typeof m?.content === 'string' ? [{ type: 'text', text: m.content }] : []));
  return parts.filter((p) => p?.type === 'text').map((p) => p.text).join('');
}

function modelMessages(entry) {
  return Array.isArray(entry?.model) ? entry.model : entry?.model ? [entry.model] : [];
}
function userText(entry) {
  return modelMessages(entry).map((m) => (typeof m?.content === 'string' ? m.content
    : (Array.isArray(m?.content) ? m.content : []).filter((p) => p?.type === 'text').map((p) => p.text).join(''))).join('');
}
function toolCallNames(entry) {
  return modelMessages(entry).flatMap((m) => (Array.isArray(m?.content) ? m.content : []))
    .filter((p) => p?.type === 'toolCall' && p.name).map((p) => p.name);
}

// Where Pi keeps its conversations: JSONL beside the workspace, on the same storage as the files.
export const SESSIONS_DIR = '/.pi/sessions';

// `storage`: 'files' keeps sessions as JSONL under SESSIONS_DIR through the env, so they persist on
// whatever backend `fs` sits on (Folder, Crate, OPFS); 'memory' (tests) forgets them; or pass a
// pi-durable Storage. `harness.resume()` continues a run a reload interrupted.
// `skills` ({ list, read }, from naklios.experimental_skills) adds the NakliOS skills library.
export async function openPi({ fs, shell, callBroker, skills = null, prune = undefined, cwd = '/workspace', storage = 'files', context = BACKGROUND_CONTEXT }) {
  const models = createModels();
  models.setProvider(createBrokerProvider(callBroker));
  const registry = createRegistry();
  registry.install(createCodingTools());
  if (skills) registry.install(createSkillsExtension(skills));
  // Superseded reads and empty results shrink in what each request sends (sys/ai/supersede-prune.mjs).
  registry.install(createPruneExtension(prune));
  const env = createNakliosEnv({ fs, shell, cwd });
  await fs.mkdir(cwd.replace(/^\/+/, ''), { recursive: true });
  const store = storage === 'memory' ? new MemoryStorage()
    : storage === 'files' ? await JsonlStorage.open(SESSIONS_DIR, env, context)
    : storage;
  const harness = await Harness.open(store, { models, registry, env: () => env }, context);
  harness.resume();
  const agent = { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, instructions: PI_INSTRUCTIONS, cwd };
  const root = await harness.root(context, { agent });

  // pi-durable keeps every conversation but has no call that lists them, so Pi keeps a small index
  // beside the sessions: one row per conversation (id, name, times, what it was forked from), newest
  // activity first. The root conversation is row one, so a session from before the index still shows.
  let index = await readIndex(fs);
  if (!index.conversations.some((c) => c.id === root.id)) {
    index.conversations.push({ id: root.id, title: '', createdAt: Date.now(), updatedAt: Date.now() });
  }
  if (!index.active || !index.conversations.some((c) => c.id === index.active)) index.active = root.id;
  let active = (await harness.conversation(index.active, context)) || root;
  index.active = active.id;
  await writeIndex(fs, index);
  const row = (id) => index.conversations.find((c) => c.id === id);
  const touch = async (id, patch = {}) => { Object.assign(row(id), patch, { updatedAt: Date.now() }); await writeIndex(fs, index); };

  // Submit one input and wait for its run: `done` with the answer, or `unanswered` with a reason.
  // `settled.answer` is the id of the answer's transcript entry; its text is read back from it.
  async function ask(text) {
    const conv = active;
    const submission = await conv.submit({ type: 'input', content: text }, context);
    if (!row(conv.id).title) await touch(conv.id, { title: titleFrom(text) });
    const settled = await submission.wait(context);
    let answer = '';
    if (settled.status === 'done' && settled.type === 'input') {
      const entry = await conv.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      answer = answerText(entry);
    }
    await touch(conv.id);
    return { settled, answer };
  }

  // The active conversation so far, as the page draws it, so a reload or a switch shows what was said.
  async function transcript() {
    // pi-durable 1.5 removed viewState(); context() gives the raw active entries the model sees.
    const view = await active.context(context);
    const rows = [];
    for (const entry of view.entries || []) {
      if (entry.kind === 'pi.user') {
        const text = userText(entry);
        if (text) rows.push({ role: 'you', text });
      } else if (entry.kind === 'pi.assistant') {
        const calls = toolCallNames(entry);
        if (calls.length) rows.push({ role: 'sys', text: 'Tool call: ' + calls.join(', ') });
        const text = answerText(entry);
        if (text) rows.push({ role: 'assistant', text });
      } else if (entry.kind === 'pi.compaction') {
        rows.push({ role: 'sys', text: 'Earlier messages were compacted into a summary.' });
      }
    }
    return rows;
  }

  // Every conversation, newest activity first, with the active one marked.
  function list() {
    return [...index.conversations].sort((a, b) => b.updatedAt - a.updatedAt)
      .map((c) => ({ ...c, title: c.title || 'New conversation', active: c.id === active.id }));
  }

  async function newConversation(title = '') {
    const conv = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, context);
    index.conversations.push({ id: conv.id, title: String(title).slice(0, 80), createdAt: Date.now(), updatedAt: Date.now() });
    active = conv; index.active = conv.id;
    await writeIndex(fs, index);
    return row(conv.id);
  }

  // Switch by `{ id }`, by position in list() (1-based), or by the first name that contains the text.
  async function switchTo(which) {
    const rows = list();
    let pick;
    if (which && typeof which === 'object') {
      pick = rows.find((c) => String(c.id) === String(which.id));
      if (!pick) throw new Error(`No conversation ${which.id}`);
    } else {
      const key = String(which ?? '').trim();
      pick = (/^\d+$/.test(key) ? rows[Number(key) - 1] : null)
        || (key ? rows.find((c) => c.title.toLowerCase().includes(key.toLowerCase())) : null);
      if (!pick) throw new Error(`No conversation matches "${key}"`);
    }
    const conv = await harness.conversation(pick.id, context);
    if (!conv) throw new Error(`Conversation ${pick.id} is listed but missing from the session store`);
    active = conv; index.active = conv.id;
    await writeIndex(fs, index);
    return row(conv.id);
  }

  // A copy of the active conversation up to its newest entry; the copy becomes active.
  async function fork(title) {
    const view = await active.context(context);
    const at = view.entries.length ? view.entries[view.entries.length - 1].id : null;
    if (!at) throw new Error('Nothing to fork yet: the conversation is empty');
    const from = row(active.id);
    const conv = await active.fork(at, { ownership: { kind: 'ownerless' } }, context);
    index.conversations.push({ id: conv.id, title: String(title || `Fork of ${from.title || 'conversation'}`).slice(0, 80), forkOf: from.id, createdAt: Date.now(), updatedAt: Date.now() });
    active = conv; index.active = conv.id;
    await writeIndex(fs, index);
    return row(conv.id);
  }

  async function rename(title) {
    const t = String(title || '').trim().slice(0, 80);
    if (!t) throw new Error('Give a name, for example /name Fix the parser');
    await touch(active.id, { title: t });
    return row(active.id);
  }

  // Summarise older messages into one entry, so long conversations fit the model's context.
  async function compact(instructions) {
    const taskId = await active.compact(instructions || undefined, context);
    const settled = await harness.waitForTask(taskId, context);
    await touch(active.id);
    // A plain answer for the page: whether a summary was written, or why the task ended without one.
    const out = settled?.state?.outcome || {};
    if (out.status === 'completed') return { status: 'completed', compacted: !!(out.result && (out.result.entryId || out.result.submissionId)) };
    return { status: out.status || 'unknown', error: out.error?.message || out.reason || null };
  }

  return {
    harness, root, env, ask, transcript, list, newConversation, switchTo, fork, rename, compact,
    get active() { return row(active.id); },
    close: () => harness.close(context),
  };
}

export const INDEX_PATH = '.pi/conversations.json';

// A conversation's first name: the start of its first message, on one line.
export function titleFrom(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 59) + '…' : t;
}

async function readIndex(fs) {
  try {
    const r = await fs.read(INDEX_PATH, { encoding: 'utf-8' });
    if (r && r.ok) {
      const v = JSON.parse(r.data);
      if (v && Array.isArray(v.conversations)) return v;
    }
  } catch (_) { /* a missing or damaged index starts fresh; the sessions themselves are untouched */ }
  return { version: 1, active: null, conversations: [] };
}

async function writeIndex(fs, index) {
  await fs.write(INDEX_PATH, JSON.stringify(index, null, 1), { createParents: true });
}
