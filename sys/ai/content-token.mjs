// ── the version token (pure, leaf) ─────────────────────────────────────────
// A short digest of a text's content — FNV-1a over the code units plus the length — that a
// read-before-edit ledger stores as "the version the model last saw": F8's file ledger in
// agent-tools.mjs and B6's fact session in memory-store.mjs. Two contents with the same token are
// the same content for every purpose an edit has; a differing token is the stale refusal. Not a
// security hash: nothing here defends against an adversary forging one. A leaf so a store module
// can take the token without taking the tool executor.
export function contentToken(text) {
  const s = String(text == null ? '' : text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return s.length.toString(36) + ':' + (h >>> 0).toString(36);
}

// What a write leaves behind is what a read will hand back: UTF-8 on disk, decoded — a leading
// BOM or a lone surrogate does not survive the round trip, and recording the string as handed
// in made the very next edit a false "stale" (checker, 2026-09-12). Token the stored form.
export const asStored = (s) => new TextDecoder('utf-8').decode(new TextEncoder().encode(String(s ?? '')));
