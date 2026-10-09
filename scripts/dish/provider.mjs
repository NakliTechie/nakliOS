import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { toChatRequest, responseChunks } from './protocol.mjs';
export const name = 'naklios-llm';
export const inject = ['llm'];
export function apply(ctx) {
  class NakliOSAdapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'NakliOS shared model' }; }
    async listModels(provider) { return [{ provider, id: 'shared', name: 'Settings → AI', inputModalities: ['text'] }]; }
    async resolveModel(provider, id) { return { provider, id, name: 'NakliOS shared model', inputModalities: ['text'] }; }
    async *stream(options) {
      const result = await globalThis.__dishInference(toChatRequest(options), options.signal);
      yield* responseChunks(result);
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['naklios'], new NakliOSAdapter()));
}
