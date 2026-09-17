// Conformance — the app's state op-log (CRIB-D D3): two writers, one hash-chained log, replayable;
// a doctored input, a tampered field or a torn line is caught at the line — and the log survives it.
//   node sys/history/test/state-oplog.test.mjs
import { createStateOplog, replayStateLog, replayStateLogs, OPLOG_PATH, OPLOG_ROTATE_LINES } from '../state-oplog.mjs';

let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e && e.message || String(e) }); } }
const eq = (a, b, m = '') => { if (a !== b) throw new Error(`${m} — ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const store = () => { const files = new Map(); return { files, read: async (p) => files.has(p) ? files.get(p) : null, write: async (p, t) => { files.set(p, t); } }; };
const lines = (s) => s.files.get(OPLOG_PATH).split('\n').filter(Boolean);

await test('two writers, one log: each append chains on the last, the replay lists them in order with their inputs', async () => {
  const s = store(); let t = 1_000;
  const logA = createStateOplog({ ...s, now: () => t++ });
  const logB = createStateOplog({ ...s, now: () => t++ });
  eq((await logA.append({ writer: 'tab-a', tool: 'state.written', input: { rev: 1 } })).index, 0);
  eq((await logB.append({ writer: 'tab-b', tool: 'state.written', input: { rev: 2 } })).index, 1);
  eq((await logB.append({ writer: 'tab-b', tool: 'state.refused', input: { mine: 1, diskRev: 2 } })).index, 2, 'a refused stale write is a line too');
  eq((await logA.append({ writer: 'tab-a', tool: 'state.written', input: { rev: 3 } })).index, 3);
  eq(lines(s).length, 4, 'four lines');
  const r = await replayStateLog(s.files.get(OPLOG_PATH));
  eq(r.ok, true); eq(r.brokenAt, -1);
  eq(r.writes.map((w) => `${w.writer}:${w.tool}:${JSON.stringify(w.input)}`).join(' | '), 'tab-a:state.written:{"rev":1} | tab-b:state.written:{"rev":2} | tab-b:state.refused:{"mine":1,"diskRev":2} | tab-a:state.written:{"rev":3}');
  eq(r.writes.map((w) => w.ts).join(','), '1000,1001,1002,1003', 'the clock the caller injects');
});

await test('a tampered hashed field breaks the chain at the next line; a doctored inline input breaks at ITS line; replay trusts only the prefix', async () => {
  const s = store();
  const log = createStateOplog({ ...s, now: () => 5 });
  for (const rev of [1, 2, 3]) await log.append({ writer: 'w', input: { rev } });
  const L = lines(s); const bad = JSON.parse(L[1]); bad.ts = 999; L[1] = JSON.stringify(bad); s.files.set(OPLOG_PATH, L.join('\n') + '\n');
  let r = await replayStateLog(s.files.get(OPLOG_PATH));
  eq(r.ok, false); eq(r.brokenAt, 2, 'line 2 no longer chains on the tampered line 1'); eq(r.writes.length, 2);
  const s2 = store(); const log2 = createStateOplog({ ...s2, now: () => 5 });
  for (const rev of [1, 2, 3]) await log2.append({ writer: 'w', input: { rev } });
  const L2 = lines(s2); const doc = JSON.parse(L2[1]); doc.input = { rev: 999 }; L2[1] = JSON.stringify(doc); s2.files.set(OPLOG_PATH, L2.join('\n') + '\n');
  r = await replayStateLog(s2.files.get(OPLOG_PATH));
  eq(r.ok, false); eq(r.brokenAt, 1, 'the doctored input is caught at its own line — the chain fields still verify'); eq(r.writes.length, 1); eq(r.writes[0].input.rev, 1);
  // append chains on the TAIL only — a doctored tail input refuses; a tampered middle line is replay's to catch
  let threw = null; try { await createStateOplog({ ...s2, now: () => 6 }).append({ writer: 'w', input: { rev: 4 } }); } catch (e) { threw = e.message; }
  eq(threw, null, 'the tail (line 2) is intact, so the append lands; replay reports the doctored line 1');
  const L3 = lines(s2); const dt = JSON.parse(L3[3]); dt.input = { rev: 7 }; L3[3] = JSON.stringify(dt); s2.files.set(OPLOG_PATH, L3.join('\n') + '\n');
  threw = null; try { await createStateOplog({ ...s2, now: () => 7 }).append({ writer: 'w', input: { rev: 5 } }); } catch (e) { threw = e.message; }
  assert(/tail input does not match its hash \(line 3\)/.test(threw || ''), 'a doctored tail refuses: ' + threw);
});

await test('a torn last line is dropped and said, not fatal: the next append notes oplog.torn and continues; replay of the torn log stops there', async () => {
  const s = store(); const log = createStateOplog({ ...s, now: () => 9 });
  for (const rev of [1, 2]) await log.append({ writer: 'w', input: { rev } });
  const full = s.files.get(OPLOG_PATH); s.files.set(OPLOG_PATH, full.slice(0, full.length - 25)); // a write that never finished
  const r0 = await replayStateLog(s.files.get(OPLOG_PATH));
  eq(r0.ok, false); eq(r0.brokenAt, 1, 'replay names the torn line'); eq(r0.writes.length, 1);
  const a = await log.append({ writer: 'w', input: { rev: 3 } });
  eq(a.index, 2, 'the torn marker took index 1, the write index 2');
  const r = await replayStateLog(s.files.get(OPLOG_PATH));
  eq(r.ok, true); eq(r.writes.map((w) => w.tool + ':' + JSON.stringify(w.input)).join(' | '), 'state.written:{"rev":1} | oplog.torn:{"dropped":1} | state.written:{"rev":3}');
  eq(lines(s).length, 3, 'the torn tail was dropped, the marker and the write took its place');
});

await test('a tear in the MIDDLE is left in place — append still chains on the intact tail, replay names the torn line, no valid line is lost', async () => {
  const s = store(); const log = createStateOplog({ ...s, now: () => 3 });
  for (const rev of [1, 2, 3, 4]) await log.append({ writer: 'w', input: { rev } });
  const L = lines(s); L[1] = L[1].slice(0, 30); s.files.set(OPLOG_PATH, L.join('\n') + '\n');
  eq((await log.append({ writer: 'w', input: { rev: 5 } })).index, 4, 'appended after the four existing lines');
  const after = lines(s); eq(after.length, 5, 'nothing dropped'); eq(after[1], L[1], 'the torn middle line is untouched');
  const r = await replayStateLog(s.files.get(OPLOG_PATH)); eq(r.ok, false); eq(r.brokenAt, 1); eq(r.writes.length, 1);
});

await test('an empty or missing log starts a chain; a log without a trailing newline is continued cleanly', async () => {
  const s = store();
  const log = createStateOplog({ ...s, now: () => 1 });
  eq((await log.append({ writer: 'w', input: { rev: 1 } })).index, 0);
  s.files.set(OPLOG_PATH, s.files.get(OPLOG_PATH).trimEnd());
  eq((await log.append({ writer: 'w', input: { rev: 2 } })).index, 1);
  const r = await replayStateLog(s.files.get(OPLOG_PATH)); eq(r.ok, true); eq(r.writes.length, 2);
  eq((await replayStateLog('')).writes.length, 0); eq((await replayStateLog(null)).ok, true);
});

// ── rotation (khiladi 7's residual, 2026-09-17) ─────────────────────────────────────────────
await test('rotation: at the threshold the file moves aside untouched, the live log restarts on a link line, and the lineage replays whole across files', async () => {
  const s = store(); let t = 1_700_000_000_000;
  const log = createStateOplog({ read: s.read, write: s.write, now: () => (t += 1000), rotateLines: 3 });
  for (let i = 0; i < 3; i++) await log.append({ writer: 'tab-a', tool: 'state.written', input: { rev: i } });
  eq(s.files.size, 1, 'under the threshold: one file'); const before = s.files.get(OPLOG_PATH);
  const r4 = await log.append({ writer: 'tab-b', tool: 'state.written', input: { rev: 3 } });
  assert(r4.rotated && /^\.anvil\/oplog\.2023-11-14T22-13-23-000Z\.jsonl$/.test(r4.rotated), 'the archive is named by its last line\'s ts: ' + r4.rotated);
  eq(s.files.size, 2); const archive = s.files.get(r4.rotated);
  eq(archive.split('\n').filter(Boolean).length, 3, 'the archive holds the three lines that were there');
  eq(archive, before, 'byte for byte: the archive IS the file that was there');
  const live = lines(s); eq(live.length, 2, 'the live log: the link line and the new write');
  const link = JSON.parse(live[0]); eq(link.tool, 'oplog.rotated'); eq(link.prev_hash, null, 'a new chain'); eq(link.input.archive, r4.rotated); eq(link.input.lines, 3); assert(/^sha256:/.test(link.input.head), 'it carries the archive\'s last hash');
  eq(JSON.parse(live[1]).input.rev, 3);
  // each file verifies alone
  assert((await replayStateLog(archive)).ok && (await replayStateLog(s.files.get(OPLOG_PATH))).ok);
  // and the lineage across them
  const all = await replayStateLogs([...s.files].map(([name, text]) => ({ name, text })));
  assert(all.ok, JSON.stringify(all.brokenAt)); eq(all.writes.length, 5, 'three archived writes + the link + the new write');
  eq(all.writes.map((w) => w.input.rev ?? w.tool).join(','), '0,1,2,oplog.rotated,3');
  eq(all.files.join(' '), r4.rotated + ' ' + OPLOG_PATH, 'archives first, the live log last');
  // a second rotation chains the archives
  for (let i = 4; i < 7; i++) await log.append({ writer: 'tab-a', tool: 'state.written', input: { rev: i } });
  eq(s.files.size, 3, 'a second archive'); const all2 = await replayStateLogs([...s.files].map(([name, text]) => ({ name, text }))); assert(all2.ok, JSON.stringify(all2.brokenAt)); eq(all2.writes.length, 9);
  eq(OPLOG_ROTATE_LINES, 2000, 'the default threshold');
});
await test('rotation: a torn tail at the threshold defers the rotation by one append, so the torn note rides into the archive it belongs to', async () => {
  const s = store(); let t = 1_700_000_000_000;
  const log = createStateOplog({ read: s.read, write: s.write, now: () => (t += 1000), rotateLines: 3 });
  for (let i = 0; i < 3; i++) await log.append({ writer: 'a', tool: 'state.written', input: { rev: i } });
  s.files.set(OPLOG_PATH, s.files.get(OPLOG_PATH) + '{"ts":1,"princ'); // a write that never finished
  const r = await log.append({ writer: 'a', tool: 'state.written', input: { rev: 3 } });
  eq(r.rotated, undefined, 'no rotation on the append that found the tear'); eq(s.files.size, 1);
  eq(lines(s).map((l) => JSON.parse(l).tool).join(','), 'state.written,state.written,state.written,oplog.torn,state.written', 'the note chains into the same file');
  const r2 = await log.append({ writer: 'a', tool: 'state.written', input: { rev: 4 } });
  assert(r2.rotated, 'the next append rotates'); eq(s.files.get(r2.rotated).split('\n').filter(Boolean).length, 5, 'the archive carries the torn note');
  const all = await replayStateLogs([...s.files].map(([name, text]) => ({ name, text }))); assert(all.ok, JSON.stringify(all.brokenAt)); eq(all.writes.length, 7);
});
await test('rotation: a doctored archive tail, a link to the wrong file, or a link with nothing before it breaks the lineage at the link — the archives still replay alone', async () => {
  const s = store(); let t = 1_700_000_000_000;
  const log = createStateOplog({ read: s.read, write: s.write, now: () => (t += 1000), rotateLines: 2 });
  for (let i = 0; i < 3; i++) await log.append({ writer: 'a', tool: 'state.written', input: { rev: i } });
  const [archiveName] = [...s.files.keys()].filter((n) => n !== OPLOG_PATH);
  const files = () => [...s.files].map(([name, text]) => ({ name, text }));
  assert((await replayStateLogs(files())).ok);
  // swap the archive's LAST line for a re-signed different write: the archive verifies alone, the link no longer matches
  const s2 = store(); const log2 = createStateOplog({ read: s2.read, write: s2.write, now: () => (t += 1000) });
  await log2.append({ writer: 'a', tool: 'state.written', input: { rev: 0 } }); await log2.append({ writer: 'a', tool: 'state.written', input: { rev: 99 } });
  const doctored = new Map(s.files); doctored.set(archiveName, s2.files.get(OPLOG_PATH));
  const renamed = new Map(); for (const [n, x] of s.files) renamed.set(n === archiveName ? '.anvil/oplog.0000.jsonl' : n, x);
  const wrong = await replayStateLogs([...renamed].map(([name, text]) => ({ name, text })));
  assert(!wrong.ok && wrong.brokenAt.file === OPLOG_PATH && wrong.brokenAt.index === 0, 'a link to the wrong file breaks at the link: ' + JSON.stringify(wrong.brokenAt));
  const empty = await replayStateLogs([{ name: archiveName, text: s.files.get(archiveName) }, { name: OPLOG_PATH, text: '' }]);
  assert(!empty.ok && /no trusted first line/.test(empty.brokenAt.why), JSON.stringify(empty.brokenAt));
  const r = await replayStateLogs([...doctored].map(([name, text]) => ({ name, text })));
  assert(!r.ok && r.brokenAt.file === OPLOG_PATH && r.brokenAt.index === 0, 'broken at the live log\'s link line: ' + JSON.stringify(r.brokenAt));
  eq(r.writes.length, 2, 'the archive\'s writes are still trusted (it verifies alone); nothing after the broken link is');
  // the live log alone, with its link and no archive
  const alone = await replayStateLogs([{ name: OPLOG_PATH, text: s.files.get(OPLOG_PATH) }]);
  assert(!alone.ok && /no archive before it/.test(alone.brokenAt.why), JSON.stringify(alone.brokenAt));
});

if (failures.length) {
  console.error(`state-oplog: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`state-oplog: ${passed}/${passed} passed — two writers, one chained log, replayable; doctored, tampered and torn lines are caught`);
