// oplog — Rig's append-only operation log (C4).
//
// Every invocation through the agent face appends one line to a JSONL file in
// the store (Crate/Folder via fileops — NEVER localStorage, hard rule #9).
// Each entry (RIG §6): timestamp, actor id, caller id, command, args digest,
// result status. The args are NOT stored verbatim — only a digest — and any
// token-shaped string is redacted before the digest is taken (§10).

function fnvHex(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Token-shaped strings: long hex/base64 runs, JWTs, and common key prefixes.
const TOKENISH = [
  /\b[A-Fa-f0-9]{32,}\b/,                 // long hex (keys, oids over 32)
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}\b/, // provider keys
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,         // long base64
];

export function redactTokens(value) {
  if (typeof value === 'string') {
    return TOKENISH.some((re) => re.test(value)) ? '[redacted]' : value;
  }
  if (Array.isArray(value)) return value.map(redactTokens);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = redactTokens(value[k]);
    return out;
  }
  return value;
}

/** Stable digest of args after redaction — same args ⇒ same digest. */
export function digestArgs(args) {
  return fnvHex(JSON.stringify(redactTokens(args ?? null)));
}

/**
 * @param {object} opts
 * @param {object} opts.fs          a createFileops(...) instance (the store)
 * @param {string} [opts.path]      JSONL path within the mount
 * @param {function} [opts.now]     () => epoch ms (injectable for tests)
 */
export function createOpLog({ fs, path = 'sys/rig/oplog.jsonl', now = () => Date.now() }) {
  if (!fs) throw new Error('createOpLog requires a fileops instance (fs)');

  let _oplogChain = Promise.resolve();
  // Serialize the read-modify-write: Crate/OPFS have no atomic append, so two
  // concurrent appends would both read the same prior and one would silently
  // overwrite the other (lost audit entry, Low8). Chain so they never interleave.
  function append(input) { const p = _oplogChain.then(() => _appendRaw(input)); _oplogChain = p.catch(() => {}); return p; }
  async function _appendRaw({ actor, caller, command, args, status }) {
    const entry = {
      ts: now(),
      actor: actor || 'unknown',
      caller: caller || null,
      command,
      argsDigest: digestArgs(args),
      status,
    };
    // Read-modify-write: Crate has no native append. Append-only by contract.
    const existing = await fs.read(path, { encoding: 'utf-8' });
    const prior = existing.ok ? existing.data : '';
    await fs.write(path, prior + JSON.stringify(entry) + '\n', { createParents: true });
    return entry;
  }

  async function read() {
    const r = await fs.read(path, { encoding: 'utf-8' });
    if (!r.ok) return [];
    return r.data.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  return { append, read, path };
}
