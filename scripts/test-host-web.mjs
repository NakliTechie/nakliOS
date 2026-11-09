// Web search and page reading for agent apps (sys/host/web.mjs): provider choice, consent per host, the reading
// ladder (direct → relay → reader) and History records that carry no page address or contents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebService, WEB_TEXT_CAP, localNetworkHost } from '../sys/host/web.mjs';

function bed({ config = null, allow = () => true, routes = {}, relay = null, key = '' } = {}) {
  const asked = [], records = [], fetched = [];
  const fetchFn = async (url, init = {}) => {
    fetched.push({ url, redirect: init.redirect, init });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new TypeError('Failed to fetch');
    const { status = 200, json, text = json ? JSON.stringify(json) : '', type = '' } = route[1];
    return { ok: status < 400, status, headers: { get: () => type }, text: async () => text };
  };
  const service = createWebService({
    authorize: async (host, how) => { asked.push(`${how} ${host}`); if (!allow(host)) throw Object.assign(new Error(`network access to ${host} was not allowed`), { code: 'ENOGRANT' }); return `grant:${host}`; },
    record: async (host, grantId, output) => { records.push({ host, grantId, output }); },
    searchConfig: () => config,
    searchWith: async (query, cfg) => [{ title: `${cfg.provider}:${query}`, url: 'https://example.org/a', snippet: 's' }],
    egress: async url => relay ? relay(url) : null,
    deepseekKey: () => key,
    fetchFn,
  });
  return { service, asked, records, fetched };
}

test('search falls back to Wikipedia with no provider set, and records only host and count', async () => {
  const { service, asked, records } = bed({ routes: { 'https://en.wikipedia.org/w/api.php': { json: { query: { search: [{ title: 'TeX Live', snippet: '<span>free</span> &amp; open' }] } } } } });
  const out = await service.search('tex live', { maxResults: 3 });
  assert.equal(out.provider, 'wikipedia');
  assert.deepEqual(out.results[0], { title: 'TeX Live', url: 'https://en.wikipedia.org/wiki/TeX_Live', snippet: 'free & open' });
  assert.deepEqual(asked, ['search the web through en.wikipedia.org']);
  assert.deepEqual(records, [{ host: 'en.wikipedia.org', grantId: 'grant:en.wikipedia.org', output: { status: 200, results: 1 } }]);
});

test('search uses the person\'s provider and asks for its host', async () => {
  const { service, asked } = bed({ config: { provider: 'brave', key: 'k' } });
  const out = await service.search('q');
  assert.equal(out.provider, 'brave');
  assert.equal(out.results[0].title, 'brave:q');
  assert.deepEqual(asked, ['search the web through api.search.brave.com']);
});

test('Content-Type decides html, so markup after a long preamble is still html', async () => {
  const { service } = bed({ routes: { 'https://example.org/': { text: '<?xml version="1.0"?>' + ' '.repeat(5000) + '<html><script>x</script></html>', type: 'text/html; charset=utf-8' } } });
  assert.equal((await service.fetch('https://example.org/')).kind, 'html');
});

test('direct reads refuse redirects, and local-network addresses are never read', async () => {
  const { service, fetched } = bed({ routes: { 'https://example.org/': { text: 'ok' } } });
  await service.fetch('https://example.org/');
  assert.equal(fetched[0].redirect, 'error');
  for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.20.0.1', '169.254.169.254', 'router', 'nas.local', '[::1]', '[fd00::1]'])
    await assert.rejects(service.fetch(`http://${host}/`), { code: 'EINVAL' }, host);
  assert.equal(localNetworkHost('example.org'), false);
  assert.equal(localNetworkHost('172.32.0.1'), false);
});

test('History holds an error category, never the error text', async () => {
  const { service, records } = bed({ routes: { 'https://en.wikipedia.org/w/api.php': { text: '<html>login page with secret</html>' } } });
  await assert.rejects(service.search('q'));
  assert.deepEqual(records.at(-1).output, { error: 'failed' });
});

test('a relay that fails still falls through to the reader', async () => {
  const { service, asked } = bed({ relay: async () => { throw new Error('egress: host not allowed'); }, routes: { 'https://r.jina.ai/': { text: 'plain' } } });
  const page = await service.fetch('https://blocked.example/a');
  assert.equal(page.via, 'Jina Reader');
  assert.equal(asked.length, 2);
});

test('a page body is read only up to the byte cap', async () => {
  const { readCapped, WEB_BYTE_CAP } = await import('../sys/host/web.mjs');
  let pulled = 0;
  const stream = new ReadableStream({ pull(controller) { pulled++; controller.enqueue(new Uint8Array(1024 * 1024).fill(97)); } });
  const { text, cut } = await readCapped(new Response(stream));
  assert.equal(cut, true);
  assert.equal(text.length, WEB_BYTE_CAP);
  assert.ok(pulled <= 4, `stopped after ${pulled} chunks`);
});

test('a declined host sends nothing', async () => {
  const { service, fetched } = bed({ allow: () => false });
  await assert.rejects(service.search('q'), { code: 'ENOGRANT' });
  assert.deepEqual(fetched, []);
});

test('fetch reads directly, labels html, caps content, and records no path', async () => {
  const big = '<!doctype html><title>x</title>' + 'a'.repeat(WEB_TEXT_CAP);
  const { service, records } = bed({ routes: { 'https://example.org/': { text: big } } });
  const page = await service.fetch('https://example.org/secret/path?q=1');
  assert.equal(page.kind, 'html', 'a doctype with no Content-Type still reads as html');
  assert.equal(page.via, 'direct');
  assert.equal(page.truncated, true);
  assert.equal(page.content.length, WEB_TEXT_CAP);
  assert.equal(JSON.stringify(records).includes('secret'), false);
});

test('a blocked page goes through the relay when one is set', async () => {
  const { service, asked } = bed({ relay: async () => ({ status: 200, body: new TextEncoder().encode('relayed text') }) });
  const page = await service.fetch('https://blocked.example/a');
  assert.equal(page.via, 'web relay');
  assert.equal(page.content, 'relayed text');
  assert.deepEqual(asked, ['read pages from blocked.example']);
});

test('with no relay, the reader is used only after its own consent', async () => {
  const { service, asked } = bed({ routes: { 'https://r.jina.ai/': { text: 'Title: A\nplain text' } } });
  const page = await service.fetch('https://blocked.example/a');
  assert.equal(page.via, 'Jina Reader');
  assert.equal(page.kind, 'text');
  assert.deepEqual(asked, ['read pages from blocked.example', 'read blocked.example, which blocks direct reading, through r.jina.ai']);
  const declined = bed({ allow: host => host !== 'r.jina.ai' });
  await assert.rejects(declined.service.fetch('https://blocked.example/a'), { code: 'ENOGRANT' });
});

test('only http and https pages are read', async () => {
  const { service } = bed();
  await assert.rejects(service.fetch('file:///etc/passwd'), { code: 'EINVAL' });
  await assert.rejects(service.fetch('not a url'), { code: 'EINVAL' });
});

const DEEPSEEK_REPLY = { content: [
  { type: 'server_tool_use', name: 'web_search' },
  { type: 'web_search_tool_result', content: [
    { type: 'web_search_result', url: 'https://douk-audio.example/manual', title: 'Manual', page_age: '2026-01-02' },
    { type: 'web_search_result', url: 'https://douk-audio.example/manual', title: 'Duplicate' },
    { type: 'web_search_result', url: 'https://forum.example/clock', title: 'Clock thread' } ] },
  { type: 'text', text: 'x', citations: [{ url: 'https://douk-audio.example/manual', cited_text: 'Hold SET for 3 s' }] } ] };

test('a saved DeepSeek key makes DeepSeek the search provider, with its native web_search tool', async () => {
  const { service, asked, fetched, records } = bed({ key: 'sk-test-123', routes: { 'https://api.deepseek.com/anthropic/v1/messages': { json: DEEPSEEK_REPLY } } });
  const out = await service.search('douk clock', { maxResults: 5 });
  assert.equal(out.provider, 'deepseek');
  assert.deepEqual(out.results.map(r => r.url), ['https://douk-audio.example/manual', 'https://forum.example/clock']);
  assert.equal(out.results[0].snippet, 'Hold SET for 3 s');
  assert.deepEqual(asked, ['search the web through api.deepseek.com']);
  const body = JSON.parse(fetched[0].init.body);
  assert.equal(body.tools[0].type, 'web_search_20250305');
  assert.equal(fetched[0].init.headers['x-api-key'], 'sk-test-123');
  assert.equal(JSON.stringify(records).includes('sk-test-123'), false, 'History never holds the key');
});

test('the panel provider still wins over a saved DeepSeek key', async () => {
  const { service } = bed({ key: 'sk-test', config: { provider: 'brave', key: 'b' } });
  assert.equal((await service.search('q')).provider, 'brave');
});

test('a DeepSeek reply without search results is an error, not an empty answer', async () => {
  const { service } = bed({ key: 'sk', routes: { 'https://api.deepseek.com/anthropic/v1/messages': { json: { content: [{ type: 'text', text: 'no' }] } } } });
  await assert.rejects(service.search('q'), /no web search results/);
});
