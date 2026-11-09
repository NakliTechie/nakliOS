// web.mjs — web search and page reading for agent apps (naklios.experimental_web).
//
// Agents in a browser cannot resolve DNS or reach most sites (CORS), so Dish's own web tools failed:
// "configured web provider deepseek-official is not registered" and "node:dns/promises.lookup is not
// available in the worker host" (2026-11-09). The host reads for them instead.
//
// Search: the person's provider from the assistant panel (Brave, Tavily or SearXNG; the key stays in the
// host), else Wikipedia search, which needs no key or account.
// Fetch: the page directly; else the person's own web relay; else Jina Reader (r.jina.ai), which sees the
// address. Every host contacted, the reader included, needs the person's one-time consent for that app and
// is recorded in History (host and status, never the URL path or the body).
//
// deps:
//   authorize(host, how) → grant id; throws when the person declines
//   record(host, grantId, output) → appends one History event
//   searchConfig() → { provider, key, url } | null
//   searchWith(query, config) → [{ title, url, snippet }]   (sys/voice/more-tools.mjs searchWeb)
//   egress(url) → { status, body: Uint8Array } | null when no relay is configured
//   fetchFn — fetch, injectable for tests
export const WEB_TEXT_CAP = 200000;
const SEARCH_HOSTS = { brave: () => 'api.search.brave.com', tavily: () => 'api.tavily.com', searxng: config => new URL(config.url).hostname };

export function createWebService({ authorize, record, searchConfig, searchWith, egress, fetchFn = fetch }) {
  async function guarded(host, how, run) {
    const grantId = await authorize(host, how);
    try {
      const value = await run();
      await record(host, grantId, value.output);
      return value.result;
    } catch (error) {
      await record(host, grantId, { error: String(error?.message || error).slice(0, 200) });
      throw error;
    }
  }

  async function wikipedia(query, max) {
    const url = 'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&formatversion=2&origin=*'
      + `&srlimit=${max}&srsearch=${encodeURIComponent(query)}`;
    const response = await fetchFn(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Wikipedia search answered HTTP ${response.status}`);
    const data = await response.json();
    return (data.query?.search || []).map(hit => ({
      title: hit.title,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(hit.title).replace(/ /g, '_'))}`,
      snippet: String(hit.snippet || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    }));
  }

  async function search(query, { maxResults = 5 } = {}) {
    query = String(query || '').trim();
    if (!query) throw Object.assign(new Error('web search needs a query'), { code: 'EINVAL' });
    const max = Math.max(1, Math.min(10, Number(maxResults) || 5));
    const config = searchConfig();
    const provider = config && SEARCH_HOSTS[config.provider] && (config.key || config.url) ? config.provider : 'wikipedia';
    const host = provider === 'wikipedia' ? 'en.wikipedia.org' : SEARCH_HOSTS[provider](config);
    const results = await guarded(host, 'search the web through', async () => {
      const found = provider === 'wikipedia' ? await wikipedia(query, max) : (await searchWith(query, config)).slice(0, max);
      return { result: found, output: { status: 200, results: found.length } };
    });
    return { provider, results };
  }

  async function fetchPage(url) {
    let target;
    try { target = new URL(String(url)); } catch { throw Object.assign(new Error('web fetch needs an absolute URL'), { code: 'EINVAL' }); }
    if (!/^https?:$/.test(target.protocol)) throw Object.assign(new Error('web fetch reads http and https pages only'), { code: 'EINVAL' });
    const host = target.hostname.toLowerCase();
    const page = await guarded(host, 'read pages from', async () => {
      let read;
      try {
        const response = await fetchFn(target.href, { credentials: 'omit', signal: AbortSignal.timeout(10000) });
        read = { status: response.status, text: await response.text(), via: 'direct' };
      } catch (_) {
        const relayed = await egress(target.href);
        if (relayed) read = { status: relayed.status, text: new TextDecoder().decode(relayed.body), via: 'web relay' };
      }
      if (!read) return { result: null, output: { blocked: true } };
      return { result: read, output: { status: read.status, bytes: read.text.length, via: read.via } };
    });
    const read = page || await guarded('r.jina.ai', `read ${host}, which blocks direct reading, through`, async () => {
      const response = await fetchFn(`https://r.jina.ai/${target.href}`, { headers: { 'X-Return-Format': 'text' }, signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      return { result: { status: response.status, text, via: 'Jina Reader', plain: true }, output: { status: response.status, bytes: text.length } };
    });
    const html = !read.plain && /^\s*(<!doctype html|<html|<head|<body)/i.test(read.text.slice(0, 500));
    return { url: target.href, status: read.status, kind: html ? 'html' : 'text', content: read.text.slice(0, WEB_TEXT_CAP),
      truncated: read.text.length > WEB_TEXT_CAP, via: read.via };
  }

  return { search, fetch: fetchPage };
}
