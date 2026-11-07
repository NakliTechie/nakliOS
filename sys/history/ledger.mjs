// History — the attributable, tamper-evident cross-app ledger (handoff P0.3).
// Extends the Rig op-log (append-only JSONL) into a hash chain. One canonical
// event per action; each event commits to the prior event's hash, so any edit,
// reorder, or drop breaks the chain detectably. Content is committed by HASH
// (input_hash / output_hash), not stored — integrity without hoarding data.
// A Rote run.json is a slice of this ledger; the NDJSON export replays without
// NakliOS (Closure) and is the commercial audit format (signed), no new format.
//
// Pure over crypto.mjs (SHA-256). Storage/append is the caller's (the op-log fs).

import { sha256Hex } from '../identity/crypto.mjs';

// 'net' is the sovereign-egress door — a distinct authority surface with its own
// Grant (scope net:<host-glob>, tools ['net.fetch']); see plan/egress-transport-spec.md §6.
// 'tex' is the shared TeX service: one event per compile, with the project path and outcome.
export const DOORS = Object.freeze(['ui', 'call', 'brief', 'net', 'tex']);

// Canonical JSON (sorted keys) so a hash is stable across engines.
function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}

// A content hash for input/output payloads (what happened, not the raw data).
export async function contentHash(payload) {
  return 'sha256:' + (await sha256Hex(stable(payload ?? null)));
}

// The 9-field canonical event. `prev_hash` links to the prior event IN THIS
// STORE's chain (null at genesis).
function eventFields(e) {
  return { ts: e.ts, principal: e.principal, door: e.door, tool: e.tool, app: e.app,
    input_hash: e.input_hash, output_hash: e.output_hash, grant_id: e.grant_id ?? null, prev_hash: e.prev_hash ?? null };
}
// A stored event's own hash — over all 9 fields, so tampering any field is caught.
export async function eventHash(e) { return 'sha256:' + (await sha256Hex(stable(eventFields(e)))); }

// Build one event, computing the content hashes. `prevHash` is the chain head of
// this event's store (the prior event's hash, or null). Returns { event, head }.
export async function appendEvent(prevHash, { ts, principal, door, tool, app, input, output, grant_id = null }) {
  if (!DOORS.includes(door)) throw new Error(`unknown door "${door}"`);
  const event = { ts, principal, door, tool, app,
    input_hash: await contentHash(input), output_hash: await contentHash(output),
    grant_id, prev_hash: prevHash ?? null };
  const head = await eventHash(event);
  return { event, head };
}

// Verify a single store's chain (events in order). Returns { ok, brokenAt } —
// brokenAt is the index whose prev_hash does not match the recomputed hash of the
// event before it (or -1 when ok).
export async function verifyChain(events) {
  let prev = null;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if ((e.prev_hash ?? null) !== (prev ?? null)) return { ok: false, brokenAt: i };
    prev = await eventHash(e);
  }
  return { ok: true, brokenAt: -1 };
}

// Merge N per-app chains into one time-ordered view WITHOUT re-chaining — each
// app's chain stays independently verifiable. `byApp` is { app: events[] }. Ties
// on ts break by app name then original index, for a deterministic merge.
export function mergeChains(byApp) {
  const rows = [];
  for (const [app, events] of Object.entries(byApp || {})) events.forEach((e, i) => rows.push({ e, app, i }));
  rows.sort((a, b) => (a.e.ts - b.e.ts) || (a.app < b.app ? -1 : a.app > b.app ? 1 : a.i - b.i));
  return rows.map((r) => r.e);
}

// NDJSON export/import — replays without NakliOS (Closure rule).
export function toNDJSON(events) { return events.map((e) => JSON.stringify(eventFields(e))).join('\n'); }
export function fromNDJSON(text) {
  return String(text || '').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

// Replay: walk the ledger and resolve each event's committed output into the
// reconstructed effect. `resolve(event)` returns the staged diff/value for that
// event (from a content-addressed store keyed by output_hash). Returns the ordered
// list of resolved effects — the M0's "reconstruct every staged diff from the
// ledger alone". `resolve` returning undefined drops the event from the effect list.
export function replay(events, resolve) {
  const out = [];
  for (const e of events) { const v = resolve(e); if (v !== undefined) out.push({ app: e.app, tool: e.tool, effect: v }); }
  return out;
}
