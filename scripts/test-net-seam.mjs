// Conformance — the naklios.net egress SDK seam (sdk/naklios.js).
// Loads the real SDK in a mocked window (vm) and asserts the seam contract:
// net is unavailable until a host advertises a backend, and every call fails fast
// with a typed ENOEGRESS/EINVAL instead of a 30s RPC timeout. No backend exists
// yet — this pins the seam behavior (spec: plan/egress-transport-spec.md §4).
//   node scripts/test-net-seam.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../sdk/naklios.js', import.meta.url), 'utf8');

function load(hosted, netCap) {
  const listeners = [];
  const win = {
    location: { search: '' },
    addEventListener: (t, cb) => { if (t === 'message') listeners.push(cb); },
    postMessage: () => {},
  };
  win.parent = hosted ? { postMessage: () => {} } : win; // real embed → parent !== self
  win.self = win;
  const ctx = { window: win, self: win, document: { referrer: '' }, URL };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const nak = win.naklios;
  if (netCap != null && listeners.length) {
    listeners[0]({
      source: win.parent, origin: 'https://naklios.dev',
      data: { type: 'naklios:capabilities', net: netCap, netBackend: netCap ? 'worker' : null },
    });
  }
  return nak;
}

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error('FAIL:', n); } };
async function rejects(fn) { try { await fn(); return null; } catch (e) { return e; } }

// 1. Standalone — no host at all.
{
  const nak = load(false, null);
  ok('net surface exists', nak && nak.net && typeof nak.net.fetch === 'function');
  ok('available() is false standalone', nak.net.available() === false);
  const err = await rejects(() => nak.net.fetch({ url: 'https://example.com' }));
  ok('fetch rejects standalone', !!err);
  ok('code is ENOEGRESS', err && err.code === 'ENOEGRESS');
  ok('error is egress-flagged', err && err.egress === true);
  const e2 = await rejects(() => nak.net.fetch({}));
  ok('missing url → EINVAL', e2 && e2.code === 'EINVAL');
  ok('info() resolves null standalone', (await nak.net.info()) === null);
}
// 2. Hosted, but the host advertises NO backend (net:false).
{
  const nak = load(true, false);
  ok('available() false when host says net:false', nak.net.available() === false);
  const err = await rejects(() => nak.net.fetch({ url: 'https://example.com' }));
  ok('hosted + no backend → ENOEGRESS', err && err.code === 'ENOEGRESS');
}
// 3. Hosted, host advertises a backend (net:true) → capability flips on.
{
  const nak = load(true, true);
  ok('available() true when host advertises a backend', nak.net.available() === true);
}

console.log(`net-seam: ${pass}/${pass + fail} passed — ENOEGRESS until a host advertises a backend; typed errors, no timeout.`);
if (fail) process.exit(1);
