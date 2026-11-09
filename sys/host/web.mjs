// web.mjs — web search and page reading for agent apps (naklios.experimental_web).
//
// Agents in a browser cannot resolve DNS or reach most sites (CORS), so Dish's own web tools failed:
// "configured web provider deepseek-official is not registered" and "node:dns/promises.lookup is not
// available in the worker host" (2026-11-09). The host reads for them instead.
//
// Search: the person's provider from the assistant panel (Brave, Tavily or SearXNG); else DeepSeek's native web search
// when a DeepSeek key is saved in Settings → AI (the same call dsh's deepseek-official provider makes); else Wikipedia
// search, which needs no key or account. Keys stay in the host.
// Fetch (GET only): the page directly, refusing redirects; else the person's own web relay, without the Git
// token; else Jina Reader (r.jina.ai), which sees the address. Local-network addresses are refused. Every host
// contacted, the reader included, needs the person's one-time consent for that app (a web.read Grant, separate
// from naklios.net's), and is recorded in History as host, status and size: never the address, the body or an
// error's text, which can quote the body.
//
// deps:
//   authorize(host, how) → grant id; throws when the person declines
//   record(host, grantId, output) → appends one History event
//   searchConfig() → { provider, key, url } | null
//   deepseekKey() → the DeepSeek API key saved in Settings → AI, or ''
//   searchWith(query, config) → [{ title, url, snippet }]   (sys/voice/more-tools.mjs searchWeb; config.signal set)
//   egress(url) → { status, headers, body: Uint8Array } | null when no relay is configured
//   fetchFn — fetch, injectable for tests
export const WEB_TEXT_CAP = 200000;
export const WEB_BYTE_CAP = 2 * 1024 * 1024;
const SEARCH_HOSTS = { brave: () => 'api.search.brave.com', tavily: () => 'api.tavily.com', searxng: config => new URL(config.url).hostname };
export const DEEPSEEK_SEARCH = Object.freeze({ endpoint: 'https://api.deepseek.com/anthropic/v1/messages', model: 'deepseek-v4-flash', maxTokens: 4096, maxUses: 5 });

// DeepSeek answers through its Anthropic-compatible API with web_search_tool_result blocks; citations carry snippets.
export function deepseekSources(response, max) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  const results = blocks.filter(block => block?.type === 'web_search_tool_result');
  if (!results.length) throw new Error('DeepSeek returned no web search results');
  const snippets = new Map();
  for (const block of blocks) if (block?.type === 'text') for (const cite of block.citations || [])
    if (cite?.url && cite.cited_text && !snippets.has(cite.url)) snippets.set(cite.url, cite.cited_text);
  const seen = new Set(), out = [];
  for (const block of results) for (const item of block.content || []) {
    if (item?.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue;
    seen.add(item.url);
    out.push({ title: item.title || item.url, url: item.url, snippet: snippets.get(item.url) || '', ...item.page_age ? { publishedAt: item.page_age } : {} });
  }
  return out.slice(0, max);
}

// Loopback, private, link-local and unique-local addresses, plus names that only resolve on this network.
export function localNetworkHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.') && !h.includes(':')) return true;
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  return h.includes(':') && (h === '::' || h === '::1' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:'));
}

// Read at most `max` bytes, then stop the download, so a hostile page cannot exhaust the host page's memory.
export async function readCapped(response, max = WEB_BYTE_CAP) {
  if (!response.body?.getReader) { const text = await response.text(); return { text: text.slice(0, max), cut: text.length > max }; }
  const reader = response.body.getReader();
  const chunks = []; let size = 0, cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.byteLength;
    if (size > max) { cut = true; await reader.cancel().catch(() => {}); break; }
  }
  const bytes = new Uint8Array(Math.min(size, max)); let at = 0;
  for (const chunk of chunks) { const part = chunk.subarray(0, Math.max(0, bytes.length - at)); bytes.set(part, at); at += part.length; if (at >= bytes.length) break; }
  return { text: new TextDecoder().decode(bytes), cut };
}

const failure = error => ({ error: error?.code === 'ENOGRANT' ? 'declined' : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'failed' });

export function createWebService({ authorize, record, searchConfig, searchWith, egress, deepseekKey = () => '', fetchFn = fetch }) {
  async function guarded(host, how, run) {
    const grantId = await authorize(host, how);
    try {
      const value = await run();
      await record(host, grantId, value.output);
      return value.result;
    } catch (error) {
      await record(host, grantId, failure(error));
      throw error;
    }
  }

  async function wikipedia(query, max) {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&formatversion=2&origin=*'
      + `&srlimit=${max}&srsearch=${encodeURIComponent(query)}`;
    const response = await fetchFn(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
    if (!response.ok) throw new Error(`Wikipedia search answered HTTP ${response.status}`);
    const data = JSON.parse((await readCapped(response)).text);
    return (data.query?.search || []).map(hit => ({
      title: hit.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(hit.title).replace(/ /g, '_'))}`,
      snippet: String(hit.snippet || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    }));
  }

  async function deepseek(query, max, key) {
    const response = await fetchFn(DEEPSEEK_SEARCH.endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { 'x-api-key': key, authorization: `Bearer ${key}`, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: DEEPSEEK_SEARCH.model, max_tokens: DEEPSEEK_SEARCH.maxTokens, thinking: { type: 'disabled' },
        messages: [{ role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: DEEPSEEK_SEARCH.maxUses }] }),
    });
    if (!response.ok) throw new Error(`DeepSeek search answered HTTP ${response.status}`);
    return deepseekSources(JSON.parse((await readCapped(response)).text), max);
  }

  async function search(query, { maxResults = 5 } = {}) {
    query = String(query || '').trim();
    if (!query) throw Object.assign(new Error('web search needs a query'), { code: 'EINVAL' });
    const max = Math.max(1, Math.min(10, Number(maxResults) || 5));
    const config = searchConfig();
    const key = String(deepseekKey() || '');
    const provider = config && SEARCH_HOSTS[config.provider] && (config.key || config.url) ? config.provider : key ? 'deepseek' : 'wikipedia';
    const host = provider === 'wikipedia' ? 'en.wikipedia.org' : provider === 'deepseek' ? 'api.deepseek.com' : SEARCH_HOSTS[provider](config);
    const results = await guarded(host, 'search the web through', async () => {
      const found = provider === 'wikipedia' ? await wikipedia(query, max)
        : provider === 'deepseek' ? await deepseek(query, max, key)
        : (await searchWith(query, { ...config, signal: AbortSignal.timeout(15000) })).slice(0, max);
      return { result: found, output: { status: 200, results: found.length } };
    });
    return { provider, results };
  }

  async function fetchPage(url) {
    let target;
    try { target = new URL(String(url)); } catch { throw Object.assign(new Error('web fetch needs an absolute URL'), { code: 'EINVAL' }); }
    if (!/^https?:$/.test(target.protocol)) throw Object.assign(new Error('web fetch reads http and https pages only'), { code: 'EINVAL' });
    const host = target.hostname.toLowerCase();
    if (localNetworkHost(host)) throw Object.assign(new Error(`web fetch does not read local-network addresses (${host})`), { code: 'EINVAL' });
    const page = await guarded(host, 'read pages from', async () => {
      let read = null;
      try {
        // A redirect could reach a host the person never allowed, so a redirected page goes to the relay or the reader.
        const response = await fetchFn(target.href, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
        const { text, cut } = await readCapped(response);
        read = { status: response.status, type: response.headers?.get?.('content-type') || '', text, cut, via: 'direct' };
      } catch (_) {}
      if (!read) {
        try {
          const relayed = await egress(target.href);
          if (relayed) {
            const body = relayed.body.subarray(0, WEB_BYTE_CAP);
            read = { status: relayed.status, type: String(Object.entries(relayed.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || ''),
              text: new TextDecoder().decode(body), cut: relayed.body.byteLength > WEB_BYTE_CAP, via: 'web relay' };
          }
        } catch (_) {}
      }
      if (!read) return { result: null, output: { blocked: true } };
      return { result: read, output: { status: read.status, bytes: read.text.length, via: read.via } };
    });
    const read = page || await guarded('r.jina.ai', `read ${host}, which blocks direct reading, through`, async () => {
      const response = await fetchFn(`https://r.jina.ai/${target.href}`, { headers: { 'X-Return-Format': 'text' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      const { text, cut } = await readCapped(response);
      return { result: { status: response.status, type: 'text/plain', text, cut, via: 'Jina Reader' }, output: { status: response.status, bytes: text.length } };
    });
    const html = /html|xml/i.test(read.type) || (!read.type && /<html[\s>]|<!doctype html/i.test(read.text.slice(0, 4000)));
    return { url: target.href, status: read.status, kind: html ? 'html' : 'text', content: read.text.slice(0, WEB_TEXT_CAP),
      truncated: read.cut || read.text.length > WEB_TEXT_CAP, via: read.via };
  }

  return { search, fetch: fetchPage };
}
