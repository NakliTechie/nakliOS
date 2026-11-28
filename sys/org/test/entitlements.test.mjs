import test from 'node:test'
import assert from 'node:assert/strict'
import { createEntitlementStore, parseEnrollHash, verifySignedEntitlement, OFFLINE_GRACE_MS } from '../entitlements.mjs'

function makeMemoryStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  }
}

function bytesToBase64Url(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function signLikeControlPlane(payload, privateKey) {
  const payloadB64 = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const sigBuf = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(payloadB64))
  return {
    algorithm: 'Ed25519',
    key_id: 'ed25519-v1',
    payload_b64: payloadB64,
    signature_b64: bytesToBase64Url(new Uint8Array(sigBuf)),
  }
}

test('Ed25519 signed entitlement verification + tampering + 7-day offline grace cache', async () => {
  const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
  const spki = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey)))

  const now0 = 1_760_000_000_000
  const payload = {
    org_id: 'org_pilot',
    seat_id: 'seat_1',
    month: '2026-11',
    seat_limit: 50,
    monthly_cap_usd: 100,
    byok_only: false,
    policy_version: 3,
    rails: {
      fs: { allowed_backends: ['fsa'], required_backend: 'fsa', folder_label: 'Office Share', managed_crate: false, storage_quota_mb: 0, audit_fs: true, templates: [] },
      ai: { mode: 'gateway_only', unified_inference: true, allowed_models: ['openai/gpt-4o-mini'], per_seat_budget: { calls: 100, tokens: null, spend_usd: 5 }, audit_ai: true },
      agent: { apps_allowlist: ['draft', 'reckon', 'notes'], deny_commands: ['anvil.shell.*'], force_review_commands: ['notes.delete'], allow_door: false, allow_rig: false, allow_third_party_apps: false, allow_net_egress: false, audit_sync: true },
    },
    issued_at: now0,
    grace_until: now0 + OFFLINE_GRACE_MS,
  }

  const signed = await signLikeControlPlane(payload, kp.privateKey)

  // 1. Valid signature within grace window
  const ok = await verifySignedEntitlement(signed, spki, now0 + 60_000)
  assert.equal(ok.valid, true)
  assert.equal(ok.payload.org_id, 'org_pilot')

  // 2. Tampered payload fails closed
  const tampered = { ...signed, payload_b64: signed.payload_b64.slice(0, -2) + 'AA' }
  const bad = await verifySignedEntitlement(tampered, spki, now0 + 60_000)
  assert.equal(bad.valid, false)

  // 3. Expired offline grace fails closed
  const expired = await verifySignedEntitlement(signed, spki, now0 + OFFLINE_GRACE_MS + 1)
  assert.equal(expired.valid, false)
  assert.match(expired.reason, /expired/i)

  // 4. Unenrolled store makes zero network calls
  let calls = 0
  const storage = makeMemoryStorage()
  let clock = now0
  const store = createEntitlementStore({
    storage,
    now: () => clock,
    fetchFn: async () => {
      calls++
      throw new Error('must not be called')
    },
  })
  const unmanaged = await store.load()
  assert.equal(unmanaged.managed, false)
  assert.equal(calls, 0)

  // 5. Enrolled store fetches live key + entitlement, then survives offline within 7 days
  let online = true
  const store2 = createEntitlementStore({
    storage,
    now: () => clock,
    fetchFn: async (url) => {
      if (!online) throw new Error('offline')
      if (String(url).endsWith('/.well-known/entitlement-key.json')) {
        return new Response(JSON.stringify({ public_key_spki_b64: spki }), { status: 200 })
      }
      return new Response(JSON.stringify({ entitlement: payload, signed }), { status: 200 })
    },
  })
  store2.enroll({ apiUrl: 'https://api.naklios.dev', seatToken: 'nkc_seat_test' })
  const live = await store2.load()
  assert.equal(live.source, 'live')
  assert.equal(live.entitlement.policy_version, 3)

  online = false
  clock = now0 + 3 * 24 * 60 * 60 * 1000
  const cached = await store2.load()
  assert.equal(cached.source, 'offline_cache')
  assert.equal(cached.entitlement.org_id, 'org_pilot')

  clock = now0 + OFFLINE_GRACE_MS + 1000
  const afterGrace = await store2.load()
  assert.equal(afterGrace.source, 'expired')
  assert.equal(afterGrace.entitlement, null)

  // 6. #enroll= fragment parsing (valid https, rejects http non-localhost)
  const validFrag = '#enroll=' + bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ apiUrl: 'https://api.naklios.dev', seatToken: 'nkc_seat_abc' })))
  assert.deepEqual(parseEnrollHash(validFrag), { apiUrl: 'https://api.naklios.dev', seatToken: 'nkc_seat_abc', publicKeySpki: null })
  const badFrag = '#enroll=' + bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ apiUrl: 'http://evil.example', seatToken: 'nkc_seat_abc' })))
  assert.equal(parseEnrollHash(badFrag), null)
})
