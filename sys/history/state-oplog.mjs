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
// save; rotation is the next item); replay verifies the whole chain and is the audit. A torn last
// line (a write that never finished) is not an event: append drops it, notes `oplog.torn`, and
// continues; a tear anywhere else is left in place — replay names it, append never truncates.
import { appendEvent, verifyChain, eventHash, contentHash } from './ledger.mjs';

export const OPLOG_PATH = '.anvil/oplog.jsonl';
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
export function createStateOplog({ read, write, path = OPLOG_PATH, now = () => Date.now(), app = 'anvil' }) {
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
      if (torn >= 0) { const { event, head } = await mk(prev, { writer, tool: 'oplog.torn', input: { dropped: 1 }, output: {} }); out.push(line(event, { dropped: 1 })); prev = head; }
      const { event, head } = await mk(prev, { writer, tool, input, output });
      out.push(line(event, input));
      await write(path, [...kept, ...out].join('\n') + '\n');
      return { head, index: kept.length + out.length - 1 };
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
