// pi-core.mjs — one Pi (pi-durable) session on NakliOS seams. No Worker or DOM code here, so the
// same module runs in the app's Worker and in node tests.

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { AssistantEntry, createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { createCodingTools } from '@earendil-works/pi-durable/tools';
import { createBrokerProvider, PROVIDER_ID, MODEL_ID } from './broker-provider.mjs';
import { createNakliosEnv } from './naklios-env.mjs';

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

export async function openPi({ fs, shell, callBroker, cwd = '/workspace', storage = new MemoryStorage(), context = BACKGROUND_CONTEXT }) {
  const models = createModels();
  models.setProvider(createBrokerProvider(callBroker));
  const registry = createRegistry();
  registry.install(createCodingTools());
  const env = createNakliosEnv({ fs, shell, cwd });
  await fs.mkdir(cwd.replace(/^\/+/, ''), { recursive: true });
  const harness = await Harness.open(storage, { models, registry, env: () => env }, context);
  const root = await harness.root(context, {
    agent: { model: { provider: PROVIDER_ID, modelId: MODEL_ID }, instructions: PI_INSTRUCTIONS, cwd },
  });

  // Submit one input and wait for its run: `done` with the answer, or `unanswered` with a reason.
  // `settled.answer` is the id of the answer's transcript entry; its text is read back from it.
  async function ask(text) {
    const submission = await root.submit({ type: 'input', content: text }, context);
    const settled = await submission.wait(context);
    let answer = '';
    if (settled.status === 'done' && settled.type === 'input') {
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
      answer = answerText(entry);
    }
    return { settled, answer };
  }

  return { harness, root, env, ask, close: () => harness.close(context) };
}
