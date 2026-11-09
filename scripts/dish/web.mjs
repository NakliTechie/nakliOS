// Dish's web search and fetch providers: the Worker has no DNS and meets CORS, so dsh's own providers failed
// ("deepseek-official is not registered"; "node:dns/promises.lookup is not available in the worker host").
// These ask Dish's page, which asks NakliOS (naklios.experimental_web); the host holds keys and asks the person.
export const name = 'naklios-web';
export const inject = ['web'];
// Each request carries its own MessageChannel port for the answer. The Worker's own message channel belongs to
// dsh's tunnel, which stops the Worker on any frame it does not know ("unknown frame type dish-web-result", 2026-11-09).
function ask(op, request, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Web request cancelled')); return; }
    const { port1, port2 } = new MessageChannel();
    const done = () => { port1.close(); signal?.removeEventListener('abort', cancel); };
    const cancel = () => { done(); reject(new Error('Web request cancelled')); };
    signal?.addEventListener('abort', cancel, { once: true });
    port1.onmessage = event => { done(); if (event.data?.error) reject(new Error(event.data.error)); else resolve(event.data?.result); };
    globalThis.postMessage({ t: 'dish-web', op, request }, [port2]);
  });
}
export function apply(ctx) {
  ctx.effect(() => ctx.web.registerSearchProvider({
    id: 'naklios',
    available: () => true,
    async search(request, signal) {
      const { results } = await ask('search', { query: request.query, maxResults: request.maxResults }, signal);
      return { sources: results.map(hit => ({ url: hit.url, title: hit.title, snippet: hit.snippet })), truncated: false };
    },
  }));
  ctx.effect(() => ctx.web.registerFetchProvider({
    id: 'naklios',
    available: () => true,
    async fetch(request, signal) {
      const page = await ask('fetch', { url: request.url }, signal);
      return { url: page.url, statusCode: page.status, body: { kind: page.kind, content: page.content }, truncated: page.truncated };
    },
  }));
}
