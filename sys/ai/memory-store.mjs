// Structured, progressive project memory — the same mechanism as skills, applied
// to FACTS. Facts live at .anvil/memory/<slug>.md in the workspace (they roam
// with it), one fact per file with frontmatter (name, description, type, status,
// relations) + body.
//
// Only the fact INDEX (one line each: name + type + description) is injected at
// task start — cheap, and selective at scale, unlike a flat memory.md that dumps
// everything up to a cap. The agent loads a fact's full body on demand via the
// `recall` tool, and records a durable learning via `remember` (one file per
// fact). Mirrors Claude's memory: file-per-fact + frontmatter + an index.
//
// Facts are RELATED, not just listed (A1, 2026-09-05; NOOA typed edges, Caura
// supersedes_id + derivation, Hermes related_skills all converge here):
//   supersedes: <names>    this fact replaces those — they stay on disk, render
//                          AFTER their successor, tagged; never above their own
//                          correction (Caura's rule)
//   derived_from: <names>  provenance — retract a basis and every dependant is
//                          demoted to hypothesis (revalidation, transitive)
//   contradicts: <names>   a retraction points at what retracted it
//   slot: <key>            a single-valued key (build-tool, db, phase…): the
//                          holder is found by `slotHolder`, and a new value
//                          supersedes it deterministically — no model call
// A revision carries a CAUSE from a closed set (Caura's diagnosis vocabulary),
// so a retraction says WHY, not only that.
//
// Pure module (no fs, no browser, no clock): the app lists/reads/writes files
// and passes text in. Everything here is deterministic and headlessly testable.

import { parseFrontmatter } from './skills.mjs';

import { scanSkill } from './skill-sentinel.mjs';

export const MEMORY_DIR = '.anvil/memory';
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference', 'rule'];
// A RULE is the one fact type injected in full, first, every run (Caura's keystones: fetched
// deterministically, no search, no gating) — ordered by weight, hard-capped so the agent has
// to merge or retract before it can add. Rules bind the agent's own choices; the owner's
// explicit instruction in a task outranks them (the inversion of Caura's fleet posture —
// here the owner is the top of the trust ladder).
export const RULES_CAP_CHARS = 4000;
export const DEFAULT_WEIGHT = 5;
// The lesson-layer contract (Hermes, "lessons not logs"), quoted verbatim at every call
// site that decides to write memory — the remember tool and the code-mode system prompt.
export const LESSON_CONTRACT =
  'Record lessons, not logs: a fact is what to do differently next time and why — ' +
  'a convention, a gotcha, where something lives, a rule you were corrected on — ' +
  'never a narrative of what happened this run. One fact, one lesson, at most three ' +
  'sentences, grounded in something you inspected. Prefer revising an existing fact ' +
  'over adding a near-duplicate.';
// Belief-revision: a learning starts as a HYPOTHESIS, is promoted to VERIFIED when a
// check corroborates it, and is RETRACTED when an observation disproves it — so the
// agent stops re-paying for a wrong note. The status model is OURS. It was inspired
// by Agno's "learning machine" framing (learn from corrections, don't just
// accumulate), but Agno's stores carry no such status — checked against
// agno/learn/ source 2026-09-04: LearnedKnowledge is {title, learning, context,
// tags}; the only retraction there is an appended contradicting event in EntityMemory.
// A fact with no status is a plain durable fact (older files on disk).
export const MEMORY_STATUSES = ['hypothesis', 'verified', 'retracted'];
export const MEMORY_RELATIONS = ['supersedes', 'derived_from', 'contradicts'];
// Why a fact's status changed. Caura's contradiction diagnoses, minus the ones that
// need an entity model we do not have. `correction`: the old fact was wrong.
// `temporal_change`: it was true, and the world moved. `scope_difference`: both hold
// under different qualifiers. `entity_mismatch`: it was about something else.
// `write_error`: the note itself was malformed or misfiled.
export const REVISION_CAUSES = ['correction', 'temporal_change', 'scope_difference', 'entity_mismatch', 'write_error'];

// A single frontmatter value is one line; a relation is a comma-separated list of
// fact names. Names are slugs, so commas and whitespace are safe separators.
function parseList(val){
  return String(val == null ? '' : val).split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
}
function safeSlug(s){ return String(s == null ? '' : s).trim().toLowerCase().replace(/[^a-z0-9._-]+/g, ''); }
// weight 1–10 (rules order by it, highest first); anything else → the default.
function clampWeight(v){ const n = Number(v); return Number.isFinite(n) && n >= 1 && n <= 10 ? Math.round(n) : DEFAULT_WEIGHT; }

// An ISO-8601 instant, or null. Anything that is not one is treated as ABSENT rather than as
// an error: a hand-edited fact with a garbled date must still load and still bind.
//
// STRICT on purpose, because Date.parse is not (a cross-family review found all three):
//   `1`                     → Date.parse gives 2001-01-01; a bare number is not a date here.
//   `2026-02-30`            → Date.parse rolls it to 2026-03-02; a date that does not exist
//                             must not become a different one that does.
//   `2026-09-07T10:00:00`   → parsed in the READER's timezone, so the same file orders
//                             differently on two machines. A timezone is required.
// Accepted: `YYYY-MM-DD` (read as UTC midnight) and `YYYY-MM-DDTHH:MM[:SS[.sss]]` with an
// explicit `Z` or `±HH:MM`. The round-trip through Date is checked, which is what catches a
// rolled-over day.
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
function parseCreated(v){
  const s = String(v == null ? '' : v).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  const d = s.match(ISO_DATE);
  if (d) {
    const t = Date.parse(`${s}T00:00:00Z`);
    if (!Number.isFinite(t)) return null;
    // reject a rolled-over date (2026-02-30 → 2026-03-02): the day must survive the round trip
    return new Date(t).toISOString().slice(0, 10) === s ? new Date(t).toISOString() : null;
  }
  const m = s.match(ISO_INSTANT);
  if (!m) return null;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  // the calendar day must survive the round trip in the SAME offset the input carried
  const iso = new Date(t).toISOString();
  const asUtcDay = m[8] === 'Z' ? iso.slice(0, 10) : null;
  if (asUtcDay !== null && asUtcDay !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  return iso;
}

// Parse a fact file → { name, description, type, status, cause, slot, created, supersedes,
// derived_from, contradicts, body }. Unknown/absent type falls back to 'project';
// unknown/absent status → null (a plain fact); relations → [] when absent.
export function parseFact(text){
  const { meta, body } = parseFrontmatter(text);
  return {
    name: meta.name || '',
    description: meta.description || '',
    type: MEMORY_TYPES.includes((meta.type || '').toLowerCase()) ? meta.type.toLowerCase() : 'project',
    status: MEMORY_STATUSES.includes((meta.status || '').toLowerCase()) ? meta.status.toLowerCase() : null,
    cause: REVISION_CAUSES.includes((meta.cause || '').toLowerCase()) ? meta.cause.toLowerCase() : null,
    slot: meta.slot ? safeSlug(meta.slot) || null : null,
    created: parseCreated(meta.created),
    weight: clampWeight(meta.weight),
    supersedes: parseList(meta.supersedes),
    derived_from: parseList(meta.derived_from),
    contradicts: parseList(meta.contradicts),
    body,
  };
}

// The one serializer. Frontmatter is written from a parsed fact; absent optionals
// are omitted, so a plain fact round-trips to the same four lines it always had.
export function serializeFact(f){
  const lines = [
    `name: ${f.name || ''}`,
    `description: ${String(f.description || '').replace(/\r?\n/g, ' ')}`,
    `type: ${MEMORY_TYPES.includes(f.type) ? f.type : 'project'}`,
  ];
  if (MEMORY_STATUSES.includes(f.status)) lines.push(`status: ${f.status}`);
  if (REVISION_CAUSES.includes(f.cause)) lines.push(`cause: ${f.cause}`);
  if (f.slot) lines.push(`slot: ${safeSlug(f.slot)}`);
  const created = parseCreated(f.created); if (created) lines.push(`created: ${created}`);
  const w = clampWeight(f.weight); if (w !== DEFAULT_WEIGHT) lines.push(`weight: ${w}`);
  for (const rel of MEMORY_RELATIONS){
    const list = Array.isArray(f[rel]) ? f[rel].map(safeSlug).filter(Boolean) : [];
    if (list.length) lines.push(`${rel}: ${[...new Set(list)].join(', ')}`);
  }
  return `---\n${lines.join('\n')}\n---\n${String(f.body || '').trimEnd()}\n`;
}

// A short, stable, non-cryptographic digest — enough to keep generated slugs apart. FNV-1a.
function shortDigest(s){
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return (h % 2176782336).toString(36); // 36^6 — modulo, not slice: slicing base36 from the
                                        // front discards the low digit on 7-digit renderings
                                        // and throws away an order of magnitude of the space.
}

// Which fact currently holds a single-valued slot: the newest live holder — not retracted, not
// superseded by another fact. Null when the slot is free.
//
// ORDERING CONTRACT (forward-pass S-3): "newest" now means the newest RECORDED time, and
// falls back to array order only for facts that carry none. Facts written before `created:`
// existed have no timestamp, so they keep the old behaviour exactly: untimed holders sort
// among themselves in disk order, and any timed holder is newer than all of them — a fact
// that recorded when it was written beats one that never did. That is the deliberate reading
// of an ambiguous store, not an accident of sort stability.
//
// The supersedes graph is used FIRST and does not depend on order at all: any holder another
// fact supersedes is already excluded, and a supersede CYCLE resolves to a single live winner
// rather than none. Time decides only between holders with no relation between them.
export function slotHolder(facts, slot){
  const key = safeSlug(slot); if (!key) return null;
  const superseded = supersededSet(facts);
  const live = (facts || [])
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f && f.slot === key && f.status !== 'retracted' && !superseded.has(f.name));
  if (!live.length) return null;
  const at = ({ f }) => { const c = parseCreated(f.created); return c ? Date.parse(c) : -Infinity; };
  live.sort((a, b) => (at(a) - at(b)) || (a.i - b.i));
  return live[live.length - 1].f.name;
}
// Live rules, highest weight first (ties keep disk order). Retracted and superseded never bind.
function liveRules(live, stale){
  return live.filter(f => f.type === 'rule' && !stale.has(f.name))
    .map((f, i) => ({ f, i })).sort((a, b) => (clampWeight(b.f.weight) - clampWeight(a.f.weight)) || (a.i - b.i)).map(x => x.f);
}
// The one rendering of a rule in the injected index. Shared with buildMemoryIndex on purpose:
// the cap must measure what is actually INJECTED — the "## name" heading and the blank line
// between rules — not just the bodies. Counting bodies alone let a set of rules pass the cap
// and then render over it (forward-pass S-4), which is exactly the failure the cap exists to
// prevent. One function, so the two can never drift apart again.
function renderRule(r){
  return `## ${r.name}${r.status === 'hypothesis' ? ' _(hypothesis)_' : ''}\n${String(r.body || r.description || '').trim()}`;
}
const RULE_SEP = '\n\n';
// Would adding `newBody` as a rule exceed the cap? The cap is what makes the agent choose:
// over it, the tool errors and the agent must merge or retract a rule first (Hermes).
// `name`/`status` describe the prospective rule so its heading is counted too.
export function checkRulesCap(facts, newBody, { name = 'new-rule', status = null } = {}){
  const all = (facts || []).filter(f => f && f.name);
  const rules = liveRules(all.filter(f => f.status !== 'retracted'), supersededSet(all));
  const rendered = rules.map(renderRule);
  const total = rendered.join(RULE_SEP).length;
  const incoming = renderRule({ name, status, body: newBody });
  const next = rendered.concat(incoming).join(RULE_SEP).length;
  return { ok: next <= RULES_CAP_CHARS, total, next, cap: RULES_CAP_CHARS, count: rules.length };
}
export function rulesCapReply(c){
  return `Refused: project rules are capped at ${c.cap} characters and this one would take them to ${c.next} (${c.count} rule(s), ${c.total} now) — merge or retract a rule with \`revise\` first, or record this as a plain fact.`;
}
function supersededSet(facts){
  const list = (facts || []).filter(f => f && f.status !== 'retracted');
  const out = new Map(); // stale name -> successor name
  for (const f of list){
    for (const s of (f.supersedes || [])) if (s !== f.name && !out.has(s)) out.set(s, f.name);
  }
  // Break supersede CYCLES. If A supersedes B and B supersedes A, every member reads as stale
  // and the store is left with no live winner at all — the index tags each one "superseded by"
  // the other and the claim silently disappears (forward-pass S-2). A cycle is a contradiction
  // the facts cannot resolve themselves, so resolve it the way the rest of this module reads
  // recency: the newest RECORDED time, falling back to disk order for facts that carry none.
  // (A cross-family review caught this reading array order even when both members were timed,
  // which made the cycle's winner change when the caller sorted the array.) Exactly one member
  // of each cycle stays live.
  const idx = new Map(list.map((f, i) => [f.name, i]));
  const when = new Map(list.map((f) => { const c = parseCreated(f.created); return [f.name, c ? Date.parse(c) : -Infinity]; }));
  for (const [stale] of [...out]){
    if (!out.has(stale)) continue;                       // already freed as a cycle's winner
    const members = new Set([stale]);
    let cur = out.get(stale), cyclic = false;
    while (cur != null){
      if (cur === stale) { cyclic = true; break; }
      if (members.has(cur)) break;                       // a lasso, not a cycle through `stale`
      members.add(cur);
      cur = out.get(cur);
    }
    if (!cyclic) continue;
    let winner = null, bestAt = -Infinity, bestIdx = -1;
    for (const n of members){
      const at = when.has(n) ? when.get(n) : -Infinity;
      const i = idx.has(n) ? idx.get(n) : -1;
      if (at > bestAt || (at === bestAt && i > bestIdx)){ bestAt = at; bestIdx = i; winner = n; }
    }
    if (winner != null) out.delete(winner);
  }
  return out;
}

// Build the injected index from parsed facts. One line per fact; '' when there are
// none (caller concatenates blindly). Ordering rule (Caura): a superseded fact may
// surface, but never above its own correction — it renders right after its
// successor, tagged. Retracted facts are hidden and counted.
// A recorded fact/rule is injected as a binding instruction, but nothing scanned it on
// the way in (unlike a skill). Run the same prompt-injection sentinel at the injection
// boundary so a poisoned memory (one-shot injection recorded as a "rule") cannot become
// a persistent, owner-authority-level instruction. Prompt-injection only — other checks
// (size, etc.) must not silently drop a long-but-legit rule.
function injectionUnsafe(f){
  try {
    const scan = scanSkill({ name: String(f && f.name || ''), description: String(f && f.description || ''), body: String(f && f.body || '') });
    return (scan.findings || []).some(x => x.check === 'prompt-injection');
  } catch (_) { return false; }
}
export function buildMemoryIndex(facts){
  const all = (facts || []).filter(f => f && (f.name || f.description) && !injectionUnsafe(f));
  const liveAll = all.filter(f => f.status !== 'retracted');
  const retracted = all.length - liveAll.length;
  if (!liveAll.length) return '';
  const staleAll = supersededSet(liveAll);
  const rules = liveRules(liveAll, staleAll);
  const live = liveAll.filter(f => f.type !== 'rule');
  const stale = staleAll; // a rule may supersede an ordinary fact too — one stale set for the whole store
  const rulesBlock = rules.length ? '\n\n# Project rules\n' +
    'Mandatory for THIS project — they bind your own choices; the owner\'s explicit instruction ' +
    'in this task overrides them. Read once, obey throughout.\n\n' +
    rules.map(renderRule).join(RULE_SEP) + '\n' : '';
  const foot = retracted ? `\n\n${retracted} fact(s) were retracted (disproven) and hidden — do not re-derive them.` : '';
  if (!live.length) return rulesBlock ? rulesBlock + foot.replace(/^\n\n/, '\n') : '';
  const byName = new Map(live.map(f => [f.name, f]));
  const emitted = new Set();
  const lines = [];
  const line = (f) => {
    const tag = f.status === 'hypothesis' ? ' _(hypothesis — verify or retract with `revise`)_' : '';
    const sup = stale.has(f.name) ? ` _(superseded by **${stale.get(f.name)}** — prefer it)_` : '';
    return `- **${f.name || '(fact)'}** (${f.type || 'project'}): ${String(f.description || '').replace(/\s+/g, ' ').trim()}${tag}${sup}`;
  };
  const emit = (f) => {
    if (!f || emitted.has(f.name)) return;
    emitted.add(f.name); lines.push(line(f));
    // its stale predecessors ride immediately below it
    for (const s of (f.supersedes || [])) if (byName.has(s) && stale.get(s) === f.name) emit(byName.get(s));
  };
  for (const f of live){
    if (stale.has(f.name) && byName.has(stale.get(f.name))) continue; // rendered under its successor
    emit(f);
  }
  for (const f of live) emit(f); // any stale fact whose successor is unnamed still renders
  return rulesBlock + '\n\n# Project memory\n' +
    'Durable learnings recorded for THIS project — honor them. A fact marked ' +
    '_hypothesis_ is provisional: when a check corroborates it, promote it with ' +
    '`revise`; when an observation disproves it, retract it with `revise` so you ' +
    'stop re-paying for it. A fact marked _superseded_ has a newer replacement — ' +
    'prefer the replacement. Load a fact\'s full detail with the `recall` tool when ' +
    'the one-line entry is not enough; record a new durable learning with `remember`.\n\n' +
    lines.join('\n') + foot + '\n';
}

// Turn a free-text note into a fact file. Deterministic: slug + description come
// from the note's first line; body is the full note. Returns the parts + the
// serialized file text. The caller ensures the slug is unique on disk.
// `rel` carries optional relations for the new fact: { slot, derived_from, supersedes }.
export function noteToFact(note, type, status, rel = {}){
  const clean = String(note == null ? '' : note).trim();
  const firstLine = (clean.split('\n')[0] || '').trim();
  const description = firstLine.length > 140 ? firstLine.slice(0, 139).trimEnd() + '…' : firstLine;
  // A first line with no alphanumeric token used to slug to the bare word "fact", so every
  // such note collided on one name and the caller had to notice (forward-pass S-5). The
  // fallback now carries a short deterministic digest of the note, so two different notes
  // get two different names while the same note still round-trips to the same one.
  const slug = firstLine.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').filter(Boolean).slice(0, 6).join('-') || `fact-${shortDigest(clean)}`;
  const t = MEMORY_TYPES.includes(type) ? type : 'project';
  // status is optional (a plain fact when omitted); the app passes 'verified' when a
  // check has corroborated the learning this run, else 'hypothesis'.
  const st = MEMORY_STATUSES.includes(status) ? status : null;
  const fact = {
    name: slug, description, type: t, status: st, cause: null,
    slot: rel && rel.slot ? safeSlug(rel.slot) || null : null,
    // The recency signal slotHolder needs. Deterministic when the caller supplies
    // `rel.created` (the tests and any replay do); otherwise stamped from the clock,
    // which is the ONE non-deterministic field in this function.
    created: parseCreated(rel && rel.created) || new Date().toISOString(),
    weight: clampWeight(rel && rel.weight),
    supersedes: parseList(Array.isArray(rel?.supersedes) ? rel.supersedes.join(',') : rel?.supersedes),
    derived_from: parseList(Array.isArray(rel?.derived_from) ? rel.derived_from.join(',') : rel?.derived_from),
    contradicts: [],
    body: clean,
  };
  return { ...fact, slug, file: serializeFact(fact) };
}

// Belief revision: rewrite a fact file to a new status (verified | retracted) and
// append a revision note to its body. `cause` is the closed-set WHY (REVISION_CAUSES);
// `reason` is the free one-liner of evidence; `contradicts` names the fact or
// observation that retracted this one. Pure — the app reads the file, calls this,
// writes it back. Preserves identity and every relation already on the fact.
export function applyRevision(text, { status, reason, cause, contradicts } = {}){
  const st = MEMORY_STATUSES.includes(status) ? status : 'retracted';
  const f = parseFact(text);
  const c = REVISION_CAUSES.includes(cause) ? cause : null;
  const why = String(reason || '').replace(/\r?\n/g, ' ').trim();
  const head = `**Revised → ${st}${c ? ` (${c})` : ''}${why ? ':' : '.'}**`;
  const next = {
    ...f, status: st, cause: c || f.cause,
    contradicts: [...f.contradicts, ...parseList(contradicts)],
    body: `${f.body.trimEnd()}\n\n${head}${why ? ' ' + why : ''}`,
  };
  return serializeFact(next);
}

// Revalidation: when `retracted` is retracted, every fact derived from it — and from
// those, transitively — has lost its basis. Returns their names (live ones only),
// in dependency order. Pure; the app rewrites each with `applyDemotion`.
export function dependantsOf(facts, retracted){
  const out = [];
  const seen = new Set([retracted]);
  const queue = [retracted];
  while (queue.length){
    const basis = queue.shift();
    for (const f of (facts || [])){
      if (!f || seen.has(f.name) || f.status === 'retracted') continue;
      if ((f.derived_from || []).includes(basis)){ seen.add(f.name); out.push(f.name); queue.push(f.name); }
    }
  }
  return out;
}

// Demote a dependant to hypothesis with a note naming the retracted basis. A fact
// already retracted is returned unchanged (a retraction is never undone here).
export function applyDemotion(text, { basis } = {}){
  const f = parseFact(text);
  if (f.status === 'retracted') return serializeFact(f);
  const note = `**Basis retracted:** \`${safeSlug(basis)}\` — re-verify this fact or retract it.`;
  return serializeFact({ ...f, status: 'hypothesis', body: `${f.body.trimEnd()}\n\n${note}` });
}

// ───────────────────────────────────────────── search before save (A2) ──

// Normalise text for comparison: lower-case, punctuation out, whitespace collapsed.
function norm(s){ return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function tokens(s){ return new Set(norm(s).split(' ').filter(w => w.length > 2)); }
function jaccard(a, b){
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}
export const NEAR_DUPLICATE_JACCARD = 0.8;

// Polarity, for the near-duplicate guard below. A claim and its NEGATION share almost every
// token ("the build tool is vite" vs "the build tool is NOT vite" score exactly 0.8), so a
// lexical near-match cannot tell a correction from a restatement — it refused the single most
// important write there is.
//
// Polarity is read off the TOKEN SET, not the raw text, and that is load-bearing: `tokens()`
// drops words of ≤2 chars, so a bare "no" is not a token. Reading the raw text instead would
// let "no, the build tool is vite" — a restatement whose tokens are identical — count as a
// flip and slip through as a non-duplicate.
//
// KNOWN LIMIT (pre-existing, not closed here): `norm` strips apostrophes, so "isn't" becomes
// "isn t" and its negation is invisible — "the build tool isn't vite" is still refused as a
// near-duplicate. Apostrophe-free forms ("dont", "isnt") are caught. Closing the contraction
// case needs stemming, which this deterministic no-model matcher deliberately avoids.
const NEGATIONS = new Set(['not', 'never', 'none', 'cannot', 'cant', 'isnt', 'wasnt', 'arent',
  'werent', 'doesnt', 'didnt', 'dont', 'wont', 'wouldnt', 'shouldnt', 'couldnt', 'neither', 'nor']);
function hasNegation(set){ for (const w of set) if (NEGATIONS.has(w)) return true; return false; }
function withoutNegations(set){ const o = new Set(); for (const w of set) if (!NEGATIONS.has(w)) o.add(w); return o; }
function sameTokens(a, b){ if (a.size !== b.size) return false; for (const w of a) if (!b.has(w)) return false; return true; }
// A polarity FLIP — the same claim asserted one way and denied the other — needs both: exactly
// one side negated, AND the two token sets identical once the negation words are removed. The
// second half is what keeps the guard narrow: "…run with plain node" vs "…run with plain node,
// NO runner" is not a flip ("runner" is an added qualifier, not a denial), so it stays a
// near-duplicate, as it should.
function polarityFlip(aTokens, bTokens){
  if (hasNegation(aTokens) === hasNegation(bTokens)) return false;
  return sameTokens(withoutNegations(aTokens), withoutNegations(bTokens));
}

// Does this note already exist? Deterministic, no model. Returns null, or a structured
// refusal the agent can act on (Caura's duplicate_memory: the reason IS the next move):
//   exact      — same text (normalised) as a live fact          → recall / revise it
//   near       — first line ≥ 0.8 Jaccard with a live fact's     → recall / revise it
//   superseded — matches a fact that is retracted or superseded  → do not re-derive it;
//                `successor` names the replacement when there is one
// `facts` are parsed facts (parseFact shape). Live facts are checked before stale ones,
// so a re-recorded disproven note is reported against its live successor when one exists.
// `exempt` names facts the note is ALLOWED to overlap: the ones it declares it supersedes
// and the holder of its slot — a correction must be able to say the opposite of the claim
// it replaces without being refused as its duplicate (the checker's trap, closed).
export function findDuplicate(facts, note, { exempt = [] } = {}){
  const clean = String(note == null ? '' : note).trim();
  if (!clean) return null;
  const skip = new Set(parseList(Array.isArray(exempt) ? exempt.join(',') : exempt).map(safeSlug));
  const all = (facts || []).filter(f => f && f.name && !skip.has(f.name));
  const staleTo = supersededSet(all);
  const isLive = (f) => f.status !== 'retracted' && !staleTo.has(f.name);
  const firstLine = clean.split('\n')[0] || '';
  const nBody = norm(clean), nFirst = tokens(firstLine);
  const matchOf = (f) => {
    if (nBody && (norm(f.body) === nBody || norm(f.description) === nBody)) return 'exact';
    // A polarity flip is a CORRECTION, never a duplicate: the note asserts what the existing
    // fact denies (or the reverse). Only the lexical `near` branch is fooled by this — an
    // `exact` match cannot differ in polarity, because the text is identical.
    const fTokens = tokens(f.description);
    if (jaccard(nFirst, fTokens) >= NEAR_DUPLICATE_JACCARD && !polarityFlip(nFirst, fTokens)) return 'near';
    return null;
  };
  for (const f of all.filter(isLive)){
    const m = matchOf(f);
    if (m) return { reason: m, existing: f.name, status: f.status, successor: null };
  }
  for (const f of all.filter(f => !isLive(f))){
    if (matchOf(f)) return { reason: 'superseded', existing: f.name, status: f.status === 'retracted' ? 'retracted' : 'superseded', successor: staleTo.get(f.name) || null };
  }
  return null;
}

// Render a refusal as the tool's reply — one line, naming the next move.
export function duplicateReply(dup){
  if (!dup) return '';
  if (dup.reason === 'superseded'){
    return `Refused: this learning was already recorded as "${dup.existing}" and is ${dup.status}` +
      (dup.successor ? ` (replaced by "${dup.successor}" — prefer it).`
                     : ` (disproven — do not re-derive it). If this note is the CORRECTION, record it with supersedes: "${dup.existing}".`);
  }
  return `Refused: ${dup.reason === 'exact' ? 'this exact learning' : 'a near-identical learning'} already exists as "${dup.existing}"` +
    (dup.status ? ` (${dup.status})` : '') + ' — use `recall` to read it, `revise` to change its status, or record the replacement with supersedes: "' + dup.existing + '".';
}

// Per-run cap on new learnings (Agno's max_updates_per_run): the hoard is the failure
// mode, not the miss. One counter per run; the tool errors when it is spent.
export const MAX_REMEMBER_PER_RUN = 5;
export function createRememberBudget(max = MAX_REMEMBER_PER_RUN){
  let used = 0;
  return {
    take(){ if (used >= max) return { ok: false, used, left: 0, max }; used++; return { ok: true, used, left: max - used, max }; },
    get used(){ return used; },
    get left(){ return Math.max(0, max - used); },
  };
}
export function budgetSpentReply(b){
  return `Refused: this run has recorded ${b.max} learnings, its cap — record only what still matters next session; merge or retract before adding more.`;
}

// OpenAI-style tool: load one fact's full body on demand.
export function recallTool(){
  return {
    type: 'function',
    function: {
      name: 'recall',
      description: 'Load a project-memory fact\'s full detail by name (from the ' +
        'Project memory list in your context), when the one-line entry is not enough.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The fact name, exactly as listed.' },
          offset: { type: 'integer', description: 'Character offset to continue a long fact from (default 0).' },
        },
        required: ['name'],
      },
    },
  };
}

// OpenAI-style tool: belief revision. Promote a corroborated hypothesis to verified,
// or retract one an observation disproved — the mechanism that keeps memory from
// re-asserting a wrong note. A retraction says WHY (cause) and what retracted it.
export function reviseTool(){
  return {
    type: 'function',
    function: {
      name: 'revise',
      description: 'Update a project-memory fact\'s confidence after new evidence: ' +
        'set status "verified" when a check corroborates it, or "retracted" when an ' +
        'observation disproves it (so you stop re-deriving a wrong note). Give the ' +
        'fact name exactly as listed, the new status, a one-line reason, and for a ' +
        'retraction the cause: correction (it was wrong), temporal_change (it was true ' +
        'and the world moved), scope_difference (true only under a qualifier), ' +
        'entity_mismatch (it was about something else), write_error (the note was ' +
        'malformed). Retracting a fact demotes every fact derived from it to hypothesis.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The fact name, exactly as listed.' },
          status: { type: 'string', enum: ['verified', 'retracted'], description: 'verified (corroborated) or retracted (disproven).' },
          reason: { type: 'string', description: 'One line: what evidence changed the fact\'s status.' },
          cause: { type: 'string', enum: REVISION_CAUSES.slice(), description: 'Why (retractions): correction | temporal_change | scope_difference | entity_mismatch | write_error.' },
          contradicts: { type: 'string', description: 'Optional: the fact name that contradicts this one, if the evidence is another fact.' },
        },
        required: ['name', 'status'],
      },
    },
  };
}
