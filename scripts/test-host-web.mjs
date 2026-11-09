// Web search and page reading for agent apps (sys/host/web.mjs): provider choice, consent per host, the reading
// ladder (direct → relay → reader) and History records that carry no page address or contents.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebService, WEB_TEXT_CAP } from '../sys/host/web.mjs';

function bed({ config = null, allow = () => true, routes = {}, relay = null } = {}) {
  const asked = [], records = [], fetched = [];
  const fetchFn = async (url) => {
    fetched.push(url);
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) throw new TypeError('Failed to fetch');
    const { status = 200, text = '', json } = route[1];
    return { ok: status < 400, status, text: async () => text, json: async () => json };
  };
  const service = createWebService({
    authorize: async (host, how) => { asked.push(`${how} ${host}`); if (!allow(host)) throw Object.assign(new Error(`network access to ${host} was not allowed`), { code: 'ENOGRANT' }); return `grant:${host}`; },
    record: async (host, grantId, output) => { records.push({ host, grantId, output }); },
    searchConfig: () => config,
    searchWith: async (query, cfg) => [{ title: `${cfg.provider}:${query}`, url: 'https://example.org/a', snippet: 's' }],
    egress: async url => relay ? relay(url) : null,
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

test('a declined host sends nothing', async () => {
  const { service, fetched } = bed({ allow: () => false });
  await assert.rejects(service.search('q'), { code: 'ENOGRANT' });
  assert.deepEqual(fetched, []);
});

test('fetch reads directly, labels html, caps content, and records no path', async () => {
  const big = '<!doctype html><title>x</title>' + 'a'.repeat(WEB_TEXT_CAP);
  const { service, records } = bed({ routes: { 'https://example.org/': { text: big } } });
  const page = await service.fetch('https://example.org/secret/path?q=1');
  assert.equal(page.kind, 'html');
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
