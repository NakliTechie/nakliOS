// NakliOS local Ed25519 entitlement & three-rail policy verifier (Batch E).
// Compatible with naklios-cloud/src/entitlement-signing.ts (WebCrypto Ed25519, 7-day offline grace).
// Completely inert (zero network calls) when no org enrollment is configured.

export const ORG_ENROLLMENT_KEY = 'nakliOS.orgEnrollment.v1'
export const ORG_ENTITLEMENT_CACHE_KEY = 'nakliOS.orgEntitlementCache.v1'
export const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000

function base64UrlToBytes(str) {
  const clean = String(str || '')
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '')
    .replace(/-/g, '+')
    .replace(/_/g, '/')
  const padded = clean + '='.repeat((4 - (clean.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Parse a `#enroll=<base64url JSON { apiUrl, seatToken }>` fragment without touching the network. */
export function parseEnrollHash(hashStr) {
  const m = String(hashStr || '').match(/(?:^#|&)enroll=([A-Za-z0-9_-]+)/)
  if (!m) return null
  try {
    const decoded = JSON.parse(new TextDecoder().decode(base64UrlToBytes(m[1])))
    if (!decoded || typeof decoded !== 'object') return null
    const apiUrl = typeof decoded.apiUrl === 'string' ? decoded.apiUrl.trim().replace(/\/+$/, '') : ''
    const seatToken = typeof decoded.seatToken === 'string' ? decoded.seatToken.trim() : ''
    if (!apiUrl || !seatToken) return null
    const parsedUrl = new URL(apiUrl)
    if (parsedUrl.protocol !== 'https:' && parsedUrl.hostname !== '127.0.0.1' && parsedUrl.hostname !== 'localhost') return null
    return { apiUrl, seatToken, publicKeySpki: typeof decoded.publicKeySpki === 'string' ? decoded.publicKeySpki : null }
  } catch {
    return null
  }
}

/** Verify an Ed25519-signed entitlement/policy token from the control plane and enforce offline grace. */
export async function verifySignedEntitlement(signed, publicKeySpki, nowMs = Date.now()) {
  if (!signed || signed.algorithm !== 'Ed25519' || typeof signed.payload_b64 !== 'string' || typeof signed.signature_b64 !== 'string') {
    return { valid: false, reason: 'unsupported or malformed signed entitlement' }
  }
  if (!publicKeySpki || typeof publicKeySpki !== 'string') {
    return { valid: false, reason: 'missing public key' }
  }
  try {
    const pubBytes = base64UrlToBytes(publicKeySpki)
    const pubKey = await crypto.subtle.importKey('spki', pubBytes, 'Ed25519', false, ['verify'])
    const sigBytes = base64UrlToBytes(signed.signature_b64)
    const ok = await crypto.subtle.verify('Ed25519', pubKey, sigBytes, new TextEncoder().encode(signed.payload_b64))
    if (!ok) return { valid: false, reason: 'invalid signature' }
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(signed.payload_b64)))
    if (!payload || typeof payload.grace_until !== 'number' || nowMs > payload.grace_until) {
      return { valid: false, reason: 'offline grace period expired' }
    }
    if (!payload.org_id || !payload.rails || typeof payload.rails !== 'object') {
      return { valid: false, reason: 'entitlement payload missing required fields' }
    }
    return { valid: true, payload }
  } catch {
    return { valid: false, reason: 'malformed signed entitlement' }
  }
}

/**
 * Local enrollment and offline-grace entitlement store.
 * When unenrolled, load() returns { managed: false, entitlement: null } without touching the network.
 */
export function createEntitlementStore({ storage, fetchFn = fetch, now = Date.now } = {}) {
  const readJson = (key) => {
    try {
      const raw = storage?.getItem(key)
      return raw ? JSON.parse(raw) : null
    } catch {
      return null
    }
  }
  const writeJson = (key, val) => {
    try {
      if (val === null) storage?.removeItem(key)
      else storage?.setItem(key, JSON.stringify(val))
    } catch {
      /* ignore quota */
    }
  }

  function getEnrollment() {
    const e = readJson(ORG_ENROLLMENT_KEY)
    if (!e || typeof e.apiUrl !== 'string' || typeof e.seatToken !== 'string') return null
    return e
  }

  function enroll({ apiUrl, seatToken, publicKeySpki = null }) {
    const cleanUrl = String(apiUrl || '').trim().replace(/\/+$/, '')
    const cleanToken = String(seatToken || '').trim()
    if (!cleanUrl || !cleanToken) throw new Error('apiUrl and seatToken are required')
    writeJson(ORG_ENROLLMENT_KEY, { apiUrl: cleanUrl, seatToken: cleanToken, publicKeySpki: publicKeySpki || null, enrolledAt: now() })
  }

  function unenroll() {
    writeJson(ORG_ENROLLMENT_KEY, null)
    writeJson(ORG_ENTITLEMENT_CACHE_KEY, null)
  }

  async function resolvePublicKey(enrollment) {
    if (enrollment.publicKeySpki) return enrollment.publicKeySpki
    const res = await fetchFn(`${enrollment.apiUrl}/.well-known/entitlement-key.json`, { method: 'GET' })
    if (!res.ok) throw new Error(`failed to fetch entitlement public key (HTTP ${res.status})`)
    const doc = await res.json()
    if (!doc?.public_key_spki_b64) throw new Error('missing public_key_spki_b64')
    enrollment.publicKeySpki = doc.public_key_spki_b64
    writeJson(ORG_ENROLLMENT_KEY, enrollment)
    return doc.public_key_spki_b64
  }

  /** Fetch fresh signed entitlement; fall back to cached verified token within 7-day offline grace. */
  async function load() {
    const enrollment = getEnrollment()
    if (!enrollment) return { managed: false, entitlement: null, source: 'unmanaged' }

    try {
      const pubKey = await resolvePublicKey(enrollment)
      const res = await fetchFn(`${enrollment.apiUrl}/v1/entitlements`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${enrollment.seatToken}` },
      })
      if (res.status === 401 || res.status === 403) {
        return { managed: true, entitlement: null, source: 'revoked', error: `HTTP ${res.status}` }
      }
      if (res.ok) {
        const data = await res.json()
        if (!data?.signed) return { managed: true, entitlement: null, source: 'error', error: 'server returned unsigned entitlement' }
        const v = await verifySignedEntitlement(data.signed, pubKey, now())
        if (!v.valid) return { managed: true, entitlement: null, source: 'invalid', error: v.reason }
        writeJson(ORG_ENTITLEMENT_CACHE_KEY, { signed: data.signed, publicKeySpki: pubKey, cachedAt: now() })
        return { managed: true, entitlement: v.payload, source: 'live' }
      }
    } catch {
      /* offline — fall through to 7-day grace cache */
    }

    const cached = readJson(ORG_ENTITLEMENT_CACHE_KEY)
    if (cached?.signed && cached?.publicKeySpki) {
      const v = await verifySignedEntitlement(cached.signed, cached.publicKeySpki, now())
      if (v.valid) return { managed: true, entitlement: v.payload, source: 'offline_cache' }
      return { managed: true, entitlement: null, source: 'expired', error: v.reason }
    }
    return { managed: true, entitlement: null, source: 'offline_no_cache', error: 'unable to reach control plane and no cached entitlement' }
  }

  async function sendHeartbeat({ clientVersion = '', policyVersion = 0 } = {}) {
    const enrollment = getEnrollment()
    if (!enrollment) return false
    try {
      const res = await fetchFn(`${enrollment.apiUrl}/v1/heartbeat`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${enrollment.seatToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_version: clientVersion, policy_version: policyVersion }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  async function syncAuditHead({ chainHead, eventCount, doors = {} }) {
    const enrollment = getEnrollment()
    if (!enrollment) return false
    try {
      const res = await fetchFn(`${enrollment.apiUrl}/v1/audit/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${enrollment.seatToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain_head: chainHead, event_count: eventCount, doors }),
      })
      return res.ok
    } catch {
      return false
    }
  }

  return { getEnrollment, enroll, unenroll, load, sendHeartbeat, syncAuditHead }
}
