// prune-extension.mjs — omp's superseded-read and uneventful-result pruning in Pi, as a pi-durable extension.
//
// The core is NakliOS's (sys/ai/supersede-prune.mjs, shared with Anvil). pi-durable's generation task calls
// `beforeRequest` before every request attempt and uses what it returns "for that request only", so the pruned
// copy reaches the model while Pi's JSONL session keeps every result. Returning nothing sends the request as is.

import { defineExtension, hook, GenerationTask } from '@earendil-works/pi-durable';
import { prunePiMessages } from '../../../sys/ai/supersede-prune.mjs';

export function createPruneExtension(options) {
  return defineExtension({
    name: 'naklios-prune',
    hooks: [hook(GenerationTask, {
      beforeRequest({ messages }) {
        const out = prunePiMessages(messages, options);
        return out.pruned ? { messages: out.messages } : undefined;
      },
    })],
  });
}
