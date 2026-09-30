// Read-only, bounded copies of user-selected foreign agent transcripts.
// These entries never enter Anvil's hash-verified run ledger or its replay path.

export const FOREIGN_ADAPTERS = Object.freeze({
  claude: 'claude-code-jsonl-v1',
  codex: 'codex-rollout-jsonl-v1',
});

export const FOREIGN_LIMITS = Object.freeze({
  sourceBytes: 32 * 1024 * 1024,
  lineChars: 1024 * 1024,
  entries: 20_000,
  textChars: 8_000,
  fieldChars: 4_000,
  rawChars: 12_000,
});

const SAFE_METRIC_KEY = /^(?:tokenCount|tokens|input[_-]?Tokens|output[_-]?Tokens|max[_-]?Tokens|cache[_-]?Creation[_-]?Tokens|cache[_-]?Read[_-]?Tokens)$/i;
const SENSITIVE_KEY = /(?:^|[_-])(?:api[_-]?key|access[_-]?token|auth[_-]?token|id[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|password|passwd|credential|authorization|bearer|secret|token)$/i;
function sensitiveKey(key) {
  const split = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return !SAFE_METRIC_KEY.test(key) && SENSITIVE_KEY.test(split);
}
const SECRET_PATTERNS = [
  /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/g,
  /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+[^\s"',;]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|password|secret|authorization)\s*[:=]\s*["']?[^\s"',;]+/gi,
  /\b[A-Za-z][A-Za-z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|id[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|secret[_-]?access[_-]?key|password|passwd|credential|authorization|bearer|secret|token)\s*[:=]\s*["']?[^\s"',;]+/gi,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];

export function redactForeignText(value, maxChars = FOREIGN_LIMITS.fieldChars) {
  let text = String(value ?? '');
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]');
  if (text.length > maxChars) text = text.slice(0, maxChars) + `\n[TRUNCATED ${text.length - maxChars} chars]`;
  return text;
}

// Unknown fields remain available for source inspection, subject to the same
// redaction and size bounds as recognized text. Nothing stores the original row.
export function sanitizeForeignValue(value, depth = 0) {
  if (depth > 6) return '[TRUNCATED depth]';
  if (typeof value === 'string') return redactForeignText(value);
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    const out = value.slice(0, 64).map(item => sanitizeForeignValue(item, depth + 1));
    if (value.length > 64) out.push(`[TRUNCATED ${value.length - 64} items]`);
    return out;
  }
  if (typeof value !== 'object') return String(value);
  const out = Object.create(null);
  const keys = Object.keys(value);
  for (const key of keys.slice(0, 64)) {
    out[key] = sensitiveKey(key) ? '[REDACTED]' : sanitizeForeignValue(value[key], depth + 1);
  }
  if (keys.length > 64) out._truncatedKeys = keys.length - 64;
  return out;
}

function hashText(value) {
  // Stable IDs for deduplication, never an integrity proof. Native records use
  // their separate SHA-256 chain and do not accept these IDs as evidence.
  let a = 2166136261, b = 2246822519;
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 3266489917);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function timestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  const d = new Date(n);
  return Number.isFinite(n) && Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function projectName(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return redactForeignText(parts.at(-1) || '', 160);
}

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const block of content) {
    if (typeof block === 'string') { out.push(block); continue; }
    if (!block || typeof block !== 'object') continue;
    if (typeof block.text === 'string') out.push(block.text);
    else if (typeof block.input_text === 'string') out.push(block.input_text);
    else if (typeof block.output_text === 'string') out.push(block.output_text);
    else if (block.type === 'tool_use') out.push(`[tool request: ${String(block.name || 'unknown')}]`);
    else if (block.type === 'tool_result') out.push(...textParts(block.content));
  }
  return out;
}

function claudeRow(raw, state) {
  const message = raw.message && typeof raw.message === 'object' ? raw.message : {};
  const role = message.role || (raw.type === 'user' || raw.type === 'assistant' ? raw.type : 'observation');
  const parts = textParts(message.content ?? raw.content);
  return {
    kind: raw.type === 'user' || raw.type === 'assistant' ? 'message' : 'observation',
    role: String(role),
    text: parts.join('\n'),
    threadId: raw.sessionId || state.threadId || null,
    sourceEventId: raw.uuid || null,
    project: projectName(raw.cwd || state.cwd),
    ts: timestamp(raw.timestamp),
    version: String(raw.version || 'unknown'),
    parentEventId: raw.parentUuid || null,
  };
}

function codexRow(raw, state) {
  const payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  if (raw.type === 'session_meta') {
    state.threadId = String(payload.id || state.threadId || '');
    state.cwd = String(payload.cwd || state.cwd || '');
    state.version = String(payload.cli_version || state.version || 'unknown');
    return null;
  }
  let kind = 'observation', role = 'observation', parts = [];
  if (raw.type === 'response_item') {
    if (payload.type === 'message') {
      kind = 'message'; role = String(payload.role || 'unknown');
      parts = textParts(payload.content);
    } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      kind = 'tool-request'; role = 'assistant';
      parts = [`[tool request: ${String(payload.name || 'unknown')}]`, String(payload.arguments || payload.input || '')];
    } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      kind = 'tool-observation'; role = 'tool'; parts = [String(payload.output || '')];
    }
  } else if (raw.type === 'event_msg') {
    if (payload.type === 'user_message' || payload.type === 'agent_message') {
      kind = 'message'; role = payload.type === 'user_message' ? 'user' : 'assistant';
      parts = [String(payload.message || '')];
    }
  }
  return {
    kind, role, text: parts.join('\n'),
    threadId: state.threadId || null,
    sourceEventId: payload.id || null,
    project: projectName(payload.cwd || state.cwd),
    ts: timestamp(raw.timestamp),
    version: state.version || 'unknown',
    parentEventId: null,
  };
}

export function foreignSourceId(provider, source) {
  return hashText(`${provider}\0${source?.name || 'selected file'}\0${source?.size || 0}\0${source?.lastModified || 0}\0${source?.sampleDigest || ''}`);
}

export function detectForeignProvider(text) {
  let found = null;
  for (const line of String(text).split('\n').slice(0, 1000)) {
    let row;
    try { row = JSON.parse(line); } catch (_) { continue; }
    const type = row && row.type;
    const next = (type === 'session_meta' || type === 'response_item' || type === 'event_msg') ? 'codex'
      : ((type === 'user' || type === 'assistant') && row.message && typeof row.message === 'object') ? 'claude' : null;
    if (!next) continue;
    if (found && found !== next) return 'mixed';
    found = next;
  }
  return found;
}

export function normalizeForeignRow(raw, { provider, source, line, state = {} }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Unsupported foreign transcript provider');
  const mapped = provider === 'claude' ? claudeRow(raw, state) : codexRow(raw, state);
  if (!mapped) return null;
  const safe = sanitizeForeignValue(raw);
  let rawText = JSON.stringify(safe);
  if (rawText.length > FOREIGN_LIMITS.rawChars) rawText = rawText.slice(0, FOREIGN_LIMITS.rawChars) + '[TRUNCATED raw fields]';
  const sourceName = redactForeignText(source?.name || 'selected file', 160);
  const sourceId = foreignSourceId(provider, source);
  const text = redactForeignText(mapped.text || rawText, FOREIGN_LIMITS.textChars);
  const eventFingerprint = mapped.sourceEventId
    ? hashText(`${provider}\0${mapped.threadId || ''}\0${mapped.sourceEventId}`) : null;
  const identity = mapped.sourceEventId
    ? `${sourceId}\0${eventFingerprint}`
    : `${sourceId}\0${line}\0${hashText(rawText)}`;
  return {
    id: 'foreign:' + hashText(identity), eventFingerprint, provenance: 'foreign-copy',
    provider, adapter: FOREIGN_ADAPTERS[provider], version: redactForeignText(mapped.version, 80),
    kind: mapped.kind, role: redactForeignText(mapped.role, 80), text,
    project: mapped.project, threadId: mapped.threadId == null ? null : redactForeignText(mapped.threadId, 160),
    parentEventId: mapped.parentEventId == null ? null : redactForeignText(mapped.parentEventId, 160),
    ts: mapped.ts, source: { id: sourceId, name: sourceName, line, size: source?.size || null, lastModified: source?.lastModified || null },
    raw: rawText, toolOutcome: 'unknown',
  };
}

// Async chunks may come from a selected File.stream(), a fixture, or an export.
// onEntry is awaited so the caller can commit bounded IndexedDB batches.
export async function importForeignJsonl(chunks, { provider, source, onEntry, limits = {} } = {}) {
  if (provider !== 'claude' && provider !== 'codex') throw new Error('Unsupported foreign transcript provider');
  if (typeof onEntry !== 'function') throw new Error('onEntry is required');
  const cap = { ...FOREIGN_LIMITS, ...limits };
  const decoder = new TextDecoder();
  const state = {};
  const seen = new Set();
  const report = { provider, adapter: FOREIGN_ADAPTERS[provider], bytes: 0, lines: 0, imported: 0,
    duplicate: 0, malformed: 0, oversized: 0, metadata: 0, truncated: false, truncationReason: null };
  let pending = '', discard = false, limitReached = false;
  const processLine = async (line) => {
    report.lines++;
    if (discard || line.length > cap.lineChars) { report.oversized++; discard = false; return; }
    if (!line.trim()) return;
    let raw;
    try { raw = JSON.parse(line); } catch (_) { report.malformed++; return; }
    const row = normalizeForeignRow(raw, { provider, source, line: report.lines, state });
    if (!row) { report.metadata++; return; }
    if (seen.has(row.id)) { report.duplicate++; return; }
    seen.add(row.id);
    const accepted = await onEntry(row);
    if (accepted === false || typeof accepted === 'string') {
      report.truncated = true; report.truncationReason = typeof accepted === 'string' ? accepted : 'caller limit';
      limitReached = true; return;
    }
    report.imported++;
    if (report.imported >= cap.entries) { report.truncated = true; report.truncationReason = 'entry cap'; limitReached = true; }
  };
  const consume = async (text) => {
    let pos = 0;
    while (pos < text.length && !limitReached) {
      const end = text.indexOf('\n', pos);
      const part = text.slice(pos, end < 0 ? text.length : end);
      if (!discard) {
        pending += part;
        if (pending.length > cap.lineChars) { pending = ''; discard = true; }
      }
      if (end < 0) break;
      await processLine(pending.replace(/\r$/, ''));
      pending = ''; pos = end + 1;
    }
  };
  for await (const input of chunks) {
    const chunk = input instanceof Uint8Array ? input : new Uint8Array(input);
    const remaining = cap.sourceBytes - report.bytes;
    if (remaining <= 0) { report.truncated = true; report.truncationReason = 'file byte cap'; break; }
    const taken = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    report.bytes += taken.byteLength;
    await consume(decoder.decode(taken, { stream: true }));
    if (chunk.byteLength > remaining) { report.truncated = true; report.truncationReason = 'file byte cap'; break; }
    if (limitReached) break;
  }
  if (!report.truncated) {
    await consume(decoder.decode());
    if (pending || discard) await processLine(pending.replace(/\r$/, ''));
  }
  return report;
}

export function matchesForeignRow(row, { query = '', project = '', provider = '', from = '', to = '' } = {}) {
  const q = String(query).toLowerCase(), p = String(project).toLowerCase();
  const start = from ? Date.parse(from) : -Infinity;
  const end = to ? Date.parse(to) + (/^\d{4}-\d{2}-\d{2}$/.test(to) ? 86_399_999 : 0) : Infinity;
  if (!row || row.provenance !== 'foreign-copy') return false;
  if (provider && row.provider !== provider) return false;
  if (p && !String(row.project || '').toLowerCase().includes(p)) return false;
  const at = row.ts ? Date.parse(row.ts) : NaN;
  if ((from || to) && (!Number.isFinite(at) || at < start || at > end)) return false;
  if (q && !String(row.text || '').toLowerCase().includes(q)) return false;
  return true;
}

export function searchForeignRows(rows, filters = {}) {
  const { limit = 50 } = filters;
  const hits = [];
  for (const row of rows || []) {
    if (!matchesForeignRow(row, filters)) continue;
    hits.push(row);
  }
  hits.sort((a, b) => (Date.parse(b.ts || '') || 0) - (Date.parse(a.ts || '') || 0) || a.source.name.localeCompare(b.source.name) || a.source.line - b.source.line);
  return hits.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export function foreignSourceLabel(row) {
  return `${row?.source?.name || 'selected file'}:${row?.source?.line || '?'}`;
}

const BLOOM_BITS = 32768;
export function foreignStoredBytes(row) {
  // Conservative local quota estimate, including the separate search bitmap.
  return 2 * JSON.stringify(row).length + BLOOM_BITS / 8 + 2048;
}
function trigramHashes(a, b, c) {
  const x = Math.imul(Math.imul(a ^ 2166136261, 16777619) ^ b, 16777619) ^ c;
  const y = Math.imul(Math.imul(c ^ 2246822519, 3266489917) ^ b, 3266489917) ^ a;
  return [(x >>> 0) % BLOOM_BITS, (y >>> 0) % BLOOM_BITS];
}

// A negative answer is exact for substring search over the stored, bounded text.
// Positives are candidates and must be checked against the text itself.
export function foreignBloom(text) {
  const lower = String(text || '').toLowerCase();
  const bits = new Uint8Array(BLOOM_BITS / 8);
  for (let i = 0; i + 2 < lower.length; i++) {
    for (const bit of trigramHashes(lower.charCodeAt(i), lower.charCodeAt(i+1), lower.charCodeAt(i+2))) bits[bit >> 3] |= 1 << (bit & 7);
  }
  return bits;
}

export function foreignBloomMayContain(bits, query) {
  const lower = String(query || '').toLowerCase();
  if (lower.length < 3) return true;
  if (!(bits instanceof Uint8Array) || bits.length !== BLOOM_BITS / 8) return true;
  for (let i = 0; i + 2 < lower.length; i++) {
    for (const bit of trigramHashes(lower.charCodeAt(i), lower.charCodeAt(i+1), lower.charCodeAt(i+2))) {
      if (!(bits[bit >> 3] & (1 << (bit & 7)))) return false;
    }
  }
  return true;
}
