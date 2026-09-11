// Sentinel — the deterministic scan a skill passes BEFORE it can bind (C1).
// A skill is executed instructions: the agent reads it
// and does what it says. A sovereign agent will eventually pull one from a repo, so
// this is a security control, not hygiene. No model, no network, no clock —
// regexes and byte counts; cacheable by content hash; p95 under 50 ms on a 40 KB
// body (pinned by test).
//
// Severity drives what happens to the skill:
//   fatal    → the write is REFUSED (path violations, size caps)
//   critical → the skill is written QUARANTINED — never injected, never active
//              (prompt-injection markers, shell injection in script-like files)
//   warn     → written, the finding rides on the review card (URL exfiltration,
//              citation stuffing)

export const BODY_MAX_BYTES = 40_000;
export const DESCRIPTION_MAX_BYTES = 160;
export const CITATION_MAX = 20;
export const SENTINEL_CHECKS = Object.freeze(['prompt-injection', 'shell-injection', 'url-exfiltration', 'path-violation', 'body-size', 'description-size', 'citation-stuffing']);

const utf8 = (s) => new TextEncoder().encode(String(s == null ? '' : s)).length;

// Phrases that only exist to override the instructions above them.
const INJECTION = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|system)\s+(instructions?|prompts?|rules?)/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /\bnew\s+system\s+prompt\b/i,
  /<\|im_start\|>|<\|im_end\|>|<\|endoftext\|>/,
  /\[\s*(SYSTEM|INST)\s*\]/,
  /^\s*(system|assistant)\s*:\s*/im,
  /\bdo\s+not\s+tell\s+the\s+(user|owner)\b/i,
  /\bwithout\s+(telling|asking)\s+the\s+(user|owner)\b/i,
];

// In a script-like support file, these are exfiltration or destruction primitives.
const SHELL = [
  // an absolute interpreter path is the same act: `curl … | /bin/sh` (forward-pass NAF-14)
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(\/\S*\/)?(sh|bash|zsh|python[0-9.]*|node)\b/i,
  // …and so is an end-of-options separator: `rm -rf -- /`. Require a recursive flag somewhere
  // on the line, then a dangerous target, with any number of flags or `--` in between.
  // Checker A2 (2026-09-11): the target may be followed by shell punctuation (`rm -rf -- /;`) and
  // may be a root-anchored path (`rm -rf /home/alice`), not only `/` itself — so the target is
  // matched by its PREFIX (`/`, `~`, `$HOME`) with no end-boundary; only a bare `*` needs one,
  // so `rm -rf *.log` stays ordinary cleanup.
  /\brm\b[^\n]*?\s-[a-z]*r[a-z]*\b[^\n]*?\s(\/|~|\$HOME|\*(?=[\s;|&)]|$))/i,
  /\beval\s*\(?\s*\$\(/,
  /\bbase64\s+(-d|--decode)\b[^\n]*\|\s*(sh|bash)/i,
  /\bnc\b[^\n]*\s-e\s/,
  /\bchmod\s+\+x\s+[^\s]*\/\.[a-z]/i,
  /\$\(\s*(curl|wget)\b/i,
  /\bmkfifo\b|\/dev\/tcp\//,
];
const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|bat|cmd)$/i;

// A URL that carries something that looks like a secret or a variable, or points
// at a tunnel / raw address. Warn-level: a link is not an act.
const EXFIL = [
  /https?:\/\/[^\s)]+[?&](token|key|secret|api[_-]?key|auth|password|passwd)=/i,
  /https?:\/\/[^\s)]*(\$\{?[A-Z_]{3,}|\{\{)/,
  /https?:\/\/[^\s/)]*(ngrok|webhook\.site|requestbin|pipedream|burpcollaborator|interact\.sh)/i,
  /https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?\//,
];

const CITATION = /\[\[([^\]]+)\]\]|\bfact:([a-z0-9._-]+)|\bmemory\/([a-z0-9._-]+)/gi;

// Path rules for a support file inside the skill folder: relative, no traversal,
// no hidden segment, printable UTF-8 only.
export function pathViolation(p) {
  const s = String(p == null ? '' : p);
  if (!s.trim()) return 'empty path';
  if (/^([a-zA-Z]:)?[\\/]/.test(s)) return 'absolute path';
  const segs = s.replace(/\\/g, '/').split('/');
  if (segs.some((x) => x === '..')) return 'path traversal (..)';
  if (segs.some((x) => x === '.' || x === '')) return 'empty or dot segment — write a plain relative path';
  if (segs.some((x) => x.startsWith('.'))) return 'hidden segment';
  if (/[\x00-\x1f\x7f\uFFFD]/.test(s)) return 'control or replacement character in path';
  return null;
}

// Fold look-alikes before matching: NFKC (fullwidth Ｉ → I, ligatures) and strip format
// characters (zero-width joiners) — the two cheap evasions the checker found. Homoglyphs
// from other scripts and paraphrase are out of scope for a regex pass, and said so.
function fold(text) { return String(text).normalize('NFKC').replace(/\p{Cf}/gu, ''); }
function scanText(text, patterns) {
  const hits = []; const t = fold(text);
  for (const re of patterns) { const m = t.match(re); if (m) hits.push(m[0].slice(0, 80)); }
  return hits;
}

// Scan one skill: { name, description, body, files?: [{ path, content }] }.
// Returns { state, findings, ms } — `state` is the worst severity's disposition.
export function scanSkill({ name = '', description = '', body = '', files = [] } = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const findings = [];
  const add = (check, severity, where, detail) => findings.push({ check, severity, where, detail });

  // 1. size caps (fatal)
  const bodyBytes = utf8(body), descBytes = utf8(description);
  if (bodyBytes > BODY_MAX_BYTES) add('body-size', 'fatal', 'body', `${bodyBytes} bytes > ${BODY_MAX_BYTES}`);
  if (descBytes > DESCRIPTION_MAX_BYTES) add('description-size', 'fatal', 'description', `${descBytes} bytes > ${DESCRIPTION_MAX_BYTES}`);

  // 2. paths (fatal)
  for (const f of (files || [])) { const v = pathViolation(f && f.path); if (v) add('path-violation', 'fatal', String(f && f.path), v); }
  if (/\uFFFD/.test(body) || /\uFFFD/.test(description)) add('path-violation', 'fatal', 'content', 'replacement character — not valid UTF-8');

  // 3. prompt injection (critical) — body, description, and every text file
  const texts = [['body', body], ['description', description], ...(files || []).map((f) => [String(f && f.path), String(f && f.content || '')])];
  for (const [where, text] of texts) for (const hit of scanText(text, INJECTION)) add('prompt-injection', 'critical', where, hit);

  // 4. shell injection (critical) — only in script-like files
  for (const f of (files || [])) {
    const content = String(f && f.content || '');
    const scriptLike = SCRIPT_EXT.test(String(f && f.path || '')) || /^#!/.test(content) || /^\s*(#!\/|set -e|#!\s*\/usr\/bin\/env)/.test(content);
    if (!scriptLike) continue;
    for (const hit of scanText(content, SHELL)) add('shell-injection', 'critical', String(f.path), hit);
  }

  // 5. URL exfiltration (warn)
  for (const [where, text] of texts) for (const hit of scanText(text, EXFIL)) add('url-exfiltration', 'warn', where, hit);

  // 6. citation stuffing (warn)
  const cited = new Set();
  for (const m of String(body).matchAll(CITATION)) cited.add((m[1] || m[2] || m[3] || '').toLowerCase());
  if (cited.size > CITATION_MAX) add('citation-stuffing', 'warn', 'body', `${cited.size} cited facts > ${CITATION_MAX}`);

  const worst = findings.some((f) => f.severity === 'fatal') ? 'refused'
    : findings.some((f) => f.severity === 'critical') ? 'quarantined'
    : findings.length ? 'warn' : 'clean';
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { name, state: worst, findings, ms };
}

// One line for a review card or a tool reply.
export function sentinelLine(scan) {
  if (!scan || !scan.findings.length) return 'Sentinel: clean';
  const by = {};
  for (const f of scan.findings) by[f.check] = (by[f.check] || 0) + 1;
  return `Sentinel: ${scan.state} — ` + Object.entries(by).map(([k, n]) => `${k}×${n}`).join(', ');
}
