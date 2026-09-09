// nakli-egress — pure logic, no Worker globals, so it unit-tests under node.
// The security core: canonical signing string, allowlist match, and SSRF guard.
// Crypto (HMAC/SHA-256) uses WebCrypto (crypto.subtle), available in both Workers
// and node ≥ 16, so verifySignature works in both.

// ── Canonicalization ─────────────────────────────────────────────────────────
// The signed string binds method + url + headers + a HASH of the body (not the
// body itself, so a multi-MB packfile isn't re-serialized) + nonce + ts. Header
// order is normalized (lowercased keys, sorted) so client and server agree.
export function canonicalHeaders(headers) {
  const entries = Object.entries(headers || {})
    .map(([k, v]) => [String(k).toLowerCase(), String(v)])
    .filter(([k]) => !HOP_BY_HOP.has(k))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}:${v}`).join('\n');
}

export function canonicalString({ method, url, headers, bodySha256, nonce, ts }) {
  return [
    String(method || 'GET').toUpperCase(),
    String(url || ''),
    canonicalHeaders(headers),
    String(bodySha256 || ''),
    String(nonce || ''),
    String(ts || ''),
  ].join('\n');
}

// Hop-by-hop / host-set headers the relay must not forward or sign.
export const HOP_BY_HOP = new Set([
  'host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding',
  'upgrade', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
]);

// ── Crypto (WebCrypto, works in Workers + node) ──────────────────────────────
const enc = new TextEncoder();

export async function sha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes instanceof Uint8Array ? bytes : enc.encode(String(bytes)));
  return hex(new Uint8Array(buf));
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return hex(new Uint8Array(sig));
}

function hex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

// Constant-time-ish compare (avoid early-exit timing leak on the signature).
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ── Allowlist + SSRF ─────────────────────────────────────────────────────────
// Default-deny. A rule matches the URL's host exactly, or as a suffix when it
// starts with '*.' (e.g. '*.githubusercontent.com'). http(s) only.
export function hostAllowed(urlStr, allowlist) {
  let u;
  try { u = new URL(urlStr); } catch (_) { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (isPrivateHost(host)) return false; // SSRF guard even if an allowlist rule is loose
  for (const raw of allowlist || []) {
    const rule = String(raw).toLowerCase().trim();
    if (!rule) continue;
    if (rule.startsWith('*.')) { const base = rule.slice(2); if (host === base || host.endsWith('.' + base)) return true; }
    else if (host === rule) return true;
  }
  return false;
}

// Block obvious internal/loopback/metadata targets (defense-in-depth under the
// allowlist). Literal-IP based; the allowlist is the primary guard.
export function isPrivateHost(host) {
  let h = String(host || '').toLowerCase().replace(/\.+$/, ''); // drop trailing dot(s)
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);  // unwrap IPv6 literal
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '169.254.169.254') return true; // cloud metadata
  // IPv4-mapped / IPv4-compatible IPv6 → evaluate the embedded IPv4. The WHATWG URL
  // parser serializes these in COMPRESSED HEX (e.g. new URL('http://[::ffff:169.254.169.254]/')
  // .hostname === '[::ffff:a9fe:a9fe]'), never the dotted form, so match hex hextets too.
  const dotted = h.match(/^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (dotted) { h = dotted[1]; }
  else {
    const hx = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hx) {
      const hi = parseInt(hx[1], 16), lo = parseInt(hx[2], 16);
      h = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    }
  }
  // IPv4 literal ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 loopback (::1, ::), ULA (fc00::/7 → fc/fd), link-local (fe80::/10 → fe8/fe9/fea/feb)
  if (h === '::1' || h === '::' || /^(fc|fd|fe8|fe9|fea|feb)/.test(h)) return true;
  return false;
}

// ── Envelope verification (pure; caller supplies now()) ──────────────────────
// Returns { ok, reason?, req? }. req = { url, method, headers, bodyBytes }.
export async function verifyEnvelope(env, secret, { now, windowSec = 300, seenNonce } = {}) {
  if (!env || typeof env !== 'object') return { ok: false, reason: 'no envelope' };
  const { url, method = 'GET', headers = {}, body = null, nonce, ts, sig } = env;
  if (!url || !nonce || !ts || !sig) return { ok: false, reason: 'missing fields' };
  const skew = Math.abs(Number(now) - Number(ts));
  if (!Number.isFinite(skew) || skew > windowSec * 1000) return { ok: false, reason: 'stale timestamp' };
  // Decode + hash the body and verify the SIGNATURE first — before touching any
  // shared/persistent state. This is the order that matters: an unauthenticated
  // caller must not be able to mutate the nonce store (a fresh-nonce flood would
  // otherwise grow it unboundedly → isolate OOM). Body hashing is unavoidable
  // pre-auth (it's part of what's signed) but is bounded by the request-size cap.
  let bodyBytes;
  try { bodyBytes = body ? b64ToBytes(body) : new Uint8Array(0); }
  catch (_) { return { ok: false, reason: 'bad body encoding' }; }
  const bodySha256 = body ? await sha256Hex(bodyBytes) : '';
  const expect = await hmacHex(secret, canonicalString({ method, url, headers, bodySha256, nonce, ts }));
  if (!timingSafeEqual(expect, String(sig))) return { ok: false, reason: 'bad signature' };
  // Authenticated: NOW enforce single-use. Only a valid signature can grow `seen`.
  if (seenNonce && seenNonce(nonce)) return { ok: false, reason: 'replayed nonce' };
  return { ok: true, req: { url, method, headers, bodyBytes } };
}

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export function bytesToB64(u8) {
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin);
}
