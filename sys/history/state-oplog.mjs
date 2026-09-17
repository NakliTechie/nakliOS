// CRIB-D D3 (khiladi §8): a durable, single-writer op-log for the app's OWN state writes. The run
// record chains what the agent did; nothing chained what the APP did to its state — two tabs on
// one project wrote the same blob last-writer-wins until `139c381` serialised them under a Web
// Lock with a monotonic rev. This is the other half: every write (and every refused stale write)
// is one hash-chained line in `.anvil/oplog.jsonl`, appended under the same lock, so the state's
// lineage is replayable and a tampered or torn log is caught at the line. The ledger's chain
// primitives, the ledger's NDJSON — plus the small `input` inline, verified against the event's
// input_hash, so a replay needs no store and a doctored input is caught too.
//
// Append reads the whole file but parses and hashes the LAST line only (the log grows a line per
// save); replay verifies the whole chain and is the audit. ROTATION (2026-09-17): at OPLOG_ROTATE_LINES
// the file moves aside to `.anvil/oplog.<ts of its last line>.jsonl` — its own chain, untouched — and
// the live log starts a new chain whose first line, `oplog.rotated`, names the archive and carries
// the hash of its last event; replayStateLogs walks the files in order and checks each link, so the
// lineage stays one verified whole across files without a prev_hash ever spanning a file. A torn last
// line (a write that never finished) is not an event: append drops it, notes `oplog.torn`, and
// continues; a tear anywhere else is left in place — replay names it, append never truncates.
import { appendEvent, verifyChain, eventHash, contentHash } from './ledger.mjs';

export const OPLOG_PATH = '.anvil/oplog.jsonl';
export const OPLOG_ROTATE_LINES = 2000; // ~340 B a line: the live file stays under ~700 KB, and append's read with it
const archiveName = (path, ts) => path.replace(/\.jsonl$/, '') + '.' + new Date(Number(ts) || 0).toISOString().replace(/[:.]/g, '-') + '.jsonl';
const FIELDS = ['ts', 'principal', 'door', 'tool', 'app', 'input_hash', 'output_hash', 'grant_id', 'prev_hash'];
const line = (event, input) => JSON.stringify({ ...Object.fromEntries(FIELDS.map((k) => [k, event[k] ?? null])), input });
// Parse leniently: every line that parses, plus the index of the first that does not (or -1).
function parseLines(text) {
  const raw = String(text || '').split('\n').filter((l) => l.trim());
  const events = []; let torn = -1;
  for (let i = 0; i < raw.length; i++) { try { events.push(JSON.parse(raw[i])); } catch (_) { torn = i; break; } }
  return { events, torn, raw };
}
const inputOk = async (e) => (await contentHash(e.input ?? null)) === e.input_hash;

// `read(path)` → the log's text or null; `write(path, text)` replaces it. The caller serialises
// (the app's Web Lock).
export function createStateOplog({ read, write, path = OPLOG_PATH, now = () => Date.now(), app = 'anvil', rotateLines = OPLOG_ROTATE_LINES }) {
  const mk = (prev, { writer, tool, input, output }) => appendEvent(prev, { ts: now(), principal: String(writer || 'anvil'), door: 'ui', tool: String(tool || 'state.written'), app, input, output });
  return {
    path,
    async append({ writer, tool, input = {}, output = {} }) {
      const text = await read(path);
      // the tail line only: the chain hashes one event and parses one line however long the log is;
      // a torn TAIL (a write that never finished) is dropped and said; anything torn mid-file is left
      // in place for replay to name — an audit log never loses valid history to a repair
      const raw = String(text || '').split('\n').filter((l) => l.trim());
      let tail = null, torn = -1;
      if (raw.length) { try { tail = JSON.parse(raw[raw.length - 1]); } catch (_) { torn = raw.length - 1; } }
      const kept = torn >= 0 ? raw.slice(0, -1) : raw;
      if (torn >= 0 && kept.length) { try { tail = JSON.parse(kept[kept.length - 1]); } catch (_) { throw new Error('oplog: two torn lines at the tail — not repairing'); } }
      const events = tail ? [tail] : [];
      if (tail && !(await inputOk(tail))) throw new Error(`oplog tail input does not match its hash (line ${kept.length - 1}) — not extending it`);
      let prev = tail ? await eventHash(tail) : null;
      const out = [];
      let base = kept, rotated = null;
      if (rotateLines > 0 && kept.length >= rotateLines && tail && torn < 0) { // a torn tail defers by one append: its note belongs to THIS file, and rides into the archive
        // the full file moves aside untouched (its own chain, its own audit); the live log restarts on a
        // line that names the archive and the hash of its last event — the link replay checks
        rotated = archiveName(path, tail.ts);
        await write(rotated, kept.join('\n') + '\n');
        const link = { archive: rotated, lines: kept.length, head: prev };
        const { event, head } = await mk(null, { writer, tool: 'oplog.rotated', input: link, output: {} });
        out.push(line(event, link)); prev = head; base = [];
      }
      if (torn >= 0) { const { event, head } = await mk(prev, { writer, tool: 'oplog.torn', input: { dropped: 1 }, output: {} }); out.push(line(event, { dropped: 1 })); prev = head; }
      const { event, head } = await mk(prev, { writer, tool, input, output });
      out.push(line(event, input));
      await write(path, [...base, ...out].join('\n') + '\n');
      return { head, index: base.length + out.length - 1, ...(rotated ? { rotated } : {}) };
    },
  };
}

// Replay a log: { ok, brokenAt, writes: [{ index, ts, writer, tool, input }] } — the state's lineage,
// verified whole: the chain, and each line's inline input against its hash. `writes` stops at the
// first broken or unparseable line, so a torn or doctored log replays only what is trusted.
export async function replayStateLog(text) {
  const { events, torn } = parseLines(text);
  const v = await verifyChain(events);
  let upto = v.ok ? events.length : v.brokenAt;
  let brokenAt = v.ok ? -1 : v.brokenAt;
  for (let i = 0; i < upto; i++) if (!(await inputOk(events[i]))) { upto = i; brokenAt = i; break; }
  if (brokenAt < 0 && torn >= 0) brokenAt = torn;
  const writes = events.slice(0, upto).map((e, index) => ({ index, ts: e.ts, writer: e.principal, tool: e.tool, input: e.input ?? null }));
  return { ok: brokenAt < 0, brokenAt, writes };
}

// Replay the lineage across rotated files: `files` is [{ name, text }] — the archives and the live log,
// any order (sorted here: archives by name, the live log last). Each file verifies on its own; a
// file whose first line is `oplog.rotated` must name the previous file and carry the hash of its
// last event, or the lineage breaks THERE. `writes` carry their file; `brokenAt` is { file, index }.
export async function replayStateLogs(files, { path = OPLOG_PATH } = {}) {
  const ordered = [...files].sort((a, b) => (a.name === path ? 1 : b.name === path ? -1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const writes = []; let brokenAt = null; let prevName = null, prevHead = null;
  for (const f of ordered) {
    const r = await replayStateLog(f.text);
    const { events } = parseLines(f.text);
    const first = r.writes[0];
    if (prevName !== null) {
      const link = first && first.tool === 'oplog.rotated' ? first.input : null;
      if (!link || link.archive !== prevName || link.head !== prevHead) { brokenAt = { file: f.name, index: 0, why: first ? 'the rotation link does not name the previous file and its last hash' : 'the live log has no trusted first line' }; break; }
    } else if (first && first.tool === 'oplog.rotated') { brokenAt = { file: f.name, index: 0, why: 'a rotation link with no archive before it' }; break; }
    for (const w of r.writes) writes.push({ ...w, file: f.name });
    if (!r.ok) { brokenAt = { file: f.name, index: r.brokenAt }; break; }
    prevName = f.name; prevHead = events.length ? await eventHash(events[events.length - 1]) : null;
  }
  return { ok: brokenAt === null, brokenAt, writes, files: ordered.map((f) => f.name) };
}

