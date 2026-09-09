// Conformance — nakli-egress security core (src/lib.js).
// Runs under node (WebCrypto + atob/btoa are global). No Worker, no network.
//   node nakli-egress/test/lib.test.mjs
import {
  canonicalString, canonicalHeaders, hostAllowed, isPrivateHost,
  verifyEnvelope, hmacHex, sha256Hex, bytesToB64, timingSafeEqual,
} from '../src/lib.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error('FAIL:', n); } };

// Build a valid signed envelope the way the host will.
async function sign(secret, { url, method = 'GET', headers = {}, body = null, ts, nonce }) {
  const bodyBytes = body ? new TextEncoder().encode(body) : new Uint8Array(0);
  const bodySha256 = body ? await sha256Hex(bodyBytes) : '';
  const sig = await hmacHex(secret, canonicalString({ method, url, headers, bodySha256, nonce, ts }));
  return { url, method, headers, body: body ? bytesToB64(bodyBytes) : null, nonce, ts, sig };
}

const SECRET = 'test-secret-abc';
const now = 1000000;

await (async () => {
  // ── allowlist ──
  ok('exact host allowed', hostAllowed('https://github.com/a/b.git/info/refs', ['github.com']));
  ok('suffix rule allows subdomain', hostAllowed('https://codeload.githubusercontent.com/x', ['*.githubusercontent.com']));
  ok('suffix rule allows apex', hostAllowed('https://githubusercontent.com/x', ['*.githubusercontent.com']));
  ok('unlisted host denied', !hostAllowed('https://evil.com/x', ['github.com']));
  ok('http(s) only', !hostAllowed('ftp://github.com/x', ['github.com']));
  ok('empty allowlist denies all', !hostAllowed('https://github.com/x', []));

  // ── SSRF ──
  ok('localhost blocked', isPrivateHost('localhost'));
  ok('loopback blocked', isPrivateHost('127.0.0.1'));
  ok('10.x blocked', isPrivateHost('10.1.2.3'));
  ok('192.168 blocked', isPrivateHost('192.168.0.1'));
  ok('172.16-31 blocked', isPrivateHost('172.20.1.1'));
  ok('metadata IP blocked', isPrivateHost('169.254.169.254'));
  ok('public IP allowed', !isPrivateHost('140.82.121.3'));
  ok('allowlist rejects a private target even if rule is loose', !hostAllowed('http://127.0.0.1/x', ['*.0.0.1', '127.0.0.1']));
  // hardened SSRF cases (audit #4)
  ok('bracketed IPv6 loopback blocked', isPrivateHost('[::1]'));
  ok('bare IPv6 loopback blocked', isPrivateHost('::1'));
  ok('IPv4-mapped IPv6 loopback blocked', isPrivateHost('::ffff:127.0.0.1'));
  ok('bracketed IPv4-mapped metadata blocked', isPrivateHost('[::ffff:169.254.169.254]'));
  ok('trailing-dot loopback literal blocked', isPrivateHost('127.0.0.1.'));
  // The forms the WHATWG URL parser actually emits (compressed hex), i.e. what the
  // real request pipeline feeds isPrivateHost — not the dotted form above.
  ok('hex IPv4-mapped loopback blocked', isPrivateHost('::ffff:7f00:1'));
  ok('hex IPv4-mapped metadata blocked', isPrivateHost('::ffff:a9fe:a9fe'));
  ok('hex IPv4-mapped RFC1918 blocked', isPrivateHost('::ffff:a00:1'));
  ok('hex IPv4-compat loopback blocked', isPrivateHost('::7f00:1'));
  ok('parser-emitted hostname blocked', isPrivateHost(new URL('http://[::ffff:169.254.169.254]/').hostname.replace(/^\[|\]$/g,'')));
  ok('SSRF guard beats a loose IPv6 allowlist rule', !hostAllowed('http://[::ffff:169.254.169.254]/', ['::ffff:a9fe:a9fe']));
  ok('ULA fd00 blocked', isPrivateHost('fd12:3456::1'));
  ok('link-local fe80 blocked', isPrivateHost('fe80::1'));
  ok('public IPv6 allowed', !isPrivateHost('2606:4700::1111'));

  // ── envelope verification ──
  const good = await sign(SECRET, { url: 'https://github.com/a/b.git/info/refs?service=git-receive-pack', ts: now, nonce: 'n1' });
  const r1 = await verifyEnvelope(good, SECRET, { now });
  ok('valid envelope verifies', r1.ok);
  ok('verified req carries url + method', r1.ok && r1.req.url.includes('github.com') && r1.req.method === 'GET');

  const badSig = { ...good, sig: 'deadbeef' };
  ok('bad signature rejected', !(await verifyEnvelope(badSig, SECRET, { now })).ok);

  const wrongSecret = await verifyEnvelope(good, 'other-secret', { now });
  ok('wrong secret rejected', !wrongSecret.ok);

  const stale = await sign(SECRET, { url: 'https://github.com/x', ts: now - 10 * 60 * 1000, nonce: 'n2' });
  ok('stale timestamp rejected', !(await verifyEnvelope(stale, SECRET, { now })).ok);

  // tamper: change the url after signing → sig no longer matches
  const tampered = { ...good, url: 'https://evil.com/x' };
  ok('url tamper breaks signature', !(await verifyEnvelope(tampered, SECRET, { now })).ok);

  // body binding: a signed POST with a body verifies; flipping the body fails
  const withBody = await sign(SECRET, { url: 'https://github.com/a/b.git/git-receive-pack', method: 'POST', body: 'PACKDATA', ts: now, nonce: 'n3' });
  ok('signed body verifies', (await verifyEnvelope(withBody, SECRET, { now })).ok);
  const flippedBody = { ...withBody, body: bytesToB64(new TextEncoder().encode('EVILDATA')) };
  ok('body tamper breaks signature', !(await verifyEnvelope(flippedBody, SECRET, { now })).ok);

  // replay: same nonce twice with a seenNonce set → second is rejected
  const seenSet = new Set();
  const seenNonce = (n) => { if (seenSet.has(n)) return true; seenSet.add(n); return false; };
  const rep = await sign(SECRET, { url: 'https://github.com/x', ts: now, nonce: 'n4' });
  ok('first use of a nonce passes', (await verifyEnvelope(rep, SECRET, { now, seenNonce })).ok);
  ok('replayed nonce rejected', !(await verifyEnvelope(rep, SECRET, { now, seenNonce })).ok);

  // audit #1: an UNAUTHENTICATED request must NOT consume/grow the nonce store.
  const guard = new Set();
  const guardNonce = (n) => { if (guard.has(n)) return true; guard.add(n); return false; };
  const forged = { url: 'https://github.com/x', method: 'GET', headers: {}, body: null, nonce: 'attacker', ts: now, sig: 'deadbeef' };
  const fr = await verifyEnvelope(forged, SECRET, { now, seenNonce: guardNonce });
  ok('forged request rejected as bad signature (not replay)', !fr.ok && fr.reason === 'bad signature');
  ok('forged request did NOT touch the nonce store', !guard.has('attacker'));

  // audit #6: malformed base64 body → clean reason, no throw
  const badB64 = { url: 'https://github.com/x', method: 'POST', headers: {}, body: '@@not-base64@@', nonce: 'n5', ts: now, sig: 'x' };
  const br = await verifyEnvelope(badB64, SECRET, { now });
  ok('malformed body encoding handled cleanly', !br.ok && br.reason === 'bad body encoding');

  // ── misc ──
  ok('canonical headers lowercase+sorted, drop hop-by-hop', canonicalHeaders({ 'B': '2', 'a': '1', 'Host': 'x' }) === 'a:1\nb:2');
  ok('timingSafeEqual true on match', timingSafeEqual('abc', 'abc'));
  ok('timingSafeEqual false on diff', !timingSafeEqual('abc', 'abd'));
})();

console.log(`nakli-egress lib: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
