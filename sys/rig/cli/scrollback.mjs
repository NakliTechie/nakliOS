// scrollback — the C4b scrollback model. Redacts token-shaped strings before
// any persistence (§10), and serialises/restores byte-identically. In the
// browser this pairs with xterm's addon-serialize (the VT stream); here we model
// the line buffer so the redaction + round-trip are headlessly testable.

// Redact token substrings in place (unlike oplog.redactTokens which redacts a
// whole value): a log line may embed a token amid other text.
const TOKEN_PATTERNS = [
  /\b(sk|pk|ghp|gho|ghu|ghs|gsk|xox[baprs])[-_][A-Za-z0-9_-]{16,}/g, // provider keys (incl. sk-proj-/dashed)
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /\bxox[baprs]-[A-Za-z0-9-]{12,}/g,  // Slack (multi-dash segments)
  /\bAKIA[0-9A-Z]{16}\b/g,           // AWS access key id
  /\bAIza[A-Za-z0-9_-]{35}\b/g,      // Google API key
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\b[A-Fa-f0-9]{64,}\b/g, // long hex (64+); leaves 40-char git oids visible
];

export function redactLine(line) {
  let out = String(line);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

export function createScrollback({ limit = 5000 } = {}) {
  let lines = [];
  function push(text) {
    for (const l of String(text).split('\n')) lines.push(l);
    if (lines.length > limit) lines = lines.slice(lines.length - limit);
  }
  // Serialise redacted — nothing token-shaped is ever written.
  function serialize() {
    return lines.map(redactLine).join('\n');
  }
  function restore(text) {
    lines = String(text).split('\n');
  }
  return {
    push,
    serialize,
    restore,
    clear() { lines = []; },
    get lines() { return lines.slice(); },
  };
}
