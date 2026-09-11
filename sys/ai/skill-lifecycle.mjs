// Skill lifecycle — the curator's deterministic half (C4).
// Ages skills by DELIBERATE use (foldSkillUsage over the
// run records): active → stale after 30 days unused → archived after 90. Never deletes:
// an archived skill stays on disk, out of the index, one status flip from active.
// `pinned: true` exempts a skill; staged and quarantined skills are the reviewer's,
// not the curator's, and are left alone. A skill that was never used ages from its
// `created` stamp, and one with no stamp at all gets a grace floor of "now" — an
// unknown age is not an old age.
//
// Pure: takes parsed skills + a usage map + a clock value; returns proposals. The
// app applies them with `applySkillStatus` and writes the files.

import { parseFrontmatter, SKILL_STATUSES } from './skills.mjs';
import { serializeSkillFile } from './skill-manage.mjs';

export const STALE_AFTER_DAYS = 30;
export const ARCHIVE_AFTER_DAYS = 90;
const DAY = 86_400_000;

function ts(v) { const n = typeof v === 'number' ? v : Date.parse(String(v || '')); return Number.isFinite(n) ? n : null; }
// Stamps are always ISO strings on disk; a numeric clock is converted, never written raw.
function iso(v) { const n = ts(v); return n == null ? null : new Date(n).toISOString(); }
function clock(now) { const n = ts(now); if (n == null) throw new Error('skill lifecycle needs a clock (`now`)'); return n; }

// Proposals: [{ name, from, to, reason, unusedDays }] for every skill whose status
// should move. Statuses only ever move forward here (active → stale → archived); a
// use resets nothing by itself — the app re-activates a stale skill on its next
// deliberate load (see `reviveOnUse`).
export function skillLifecycle(skills, usage, { now, staleDays = STALE_AFTER_DAYS, archiveDays = ARCHIVE_AFTER_DAYS } = {}) {
  const nowMs = clock(now);
  const out = [];
  for (const s of (skills || [])) {
    if (!s || !s.name) continue;
    if (s.pinned) continue;
    if (s.status === 'staged' || s.status === 'quarantined' || s.status === 'archived') continue;
    const u = usage && usage.get ? usage.get(s.name) : null;
    // The most recent of a deliberate load and a hand edit: an owner touching a skill is a
    // relevance signal too (checker judgement). No signal at all → grace floor of now.
    const anchor = Math.max(u && u.lastUsed ? u.lastUsed : 0, ts(s.updated) ?? 0, ts(s.created) ?? 0) || nowMs;
    const unusedDays = Math.floor(Math.max(0, nowMs - anchor) / DAY);
    const to = unusedDays >= archiveDays ? 'archived' : unusedDays >= staleDays ? 'stale' : 'active';
    const from = s.status || 'active';
    if (to !== from && !(from === 'stale' && to === 'active')) {
      out.push({ name: s.name, from, to, unusedDays, reason: u && u.lastUsed ? `last loaded ${unusedDays} days ago` : (s.updated || s.created ? `never loaded; written ${unusedDays} days ago` : 'never loaded; no stamp — grace') });
    }
  }
  return out;
}

// A stale skill the model loads again is live again. The app calls this when the
// `skill` tool serves a stale skill; it returns the rewritten text or null.
export function reviveOnUse(text, { now } = {}) {
  const s = parseSkillText(text);
  if (s.status !== 'stale') return null;
  return serializeSkillFile({ ...s, status: 'active', updated: iso(now) || s.updated });
}

// `automatic: true` for a transition THIS module proposed. `updated` is one of the anchors
// aging reads, so stamping it on an automatic stale transition reset the very clock that drives
// archival — a skill went stale at 30 days and then needed another 90, not 60 (forward-pass
// NAF-18). An owner's edit still counts as a relevance signal; the curator's own bookkeeping
// does not.
export function applySkillStatus(text, status, { now, automatic = false } = {}) {
  if (!SKILL_STATUSES.includes(status)) throw new Error(`unknown skill status "${status}" — one of ${SKILL_STATUSES.join(', ')}`);
  const s = parseSkillText(text);
  return serializeSkillFile({ ...s, status, updated: automatic ? s.updated : (iso(now) || s.updated) });
}

function parseSkillText(text) {
  const { meta, body } = parseFrontmatter(text);
  return { name: meta.name || '', description: meta.description || '', status: (meta.status || 'active').toLowerCase(), pinned: /^(true|yes|1)$/i.test(String(meta.pinned || '')), created: meta.created || null, updated: meta.updated || null, body };
}

// Dedupe by normalised description (the same normalisation the memory store uses):
// groups of skills that say the same thing. Returns [{ keep, drop:[names] }] — a
// PROPOSAL to archive the drops, never a deletion. The oldest live skill is kept
// (it has the usage history); a pinned one always wins its group.
export function dedupeSkills(skills) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
  const groups = new Map();
  for (const s of (skills || [])) {
    if (!s || !s.name || s.status === 'archived') continue;
    const k = norm(s.description); if (!k) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const keep = g.find((s) => s.pinned) || [...g].sort((a, b) => (ts(a.created) ?? Infinity) - (ts(b.created) ?? Infinity))[0];
    out.push({ keep: keep.name, drop: g.filter((s) => s !== keep).map((s) => s.name), description: keep.description });
  }
  return out;
}
