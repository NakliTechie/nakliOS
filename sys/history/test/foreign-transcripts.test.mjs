import assert from 'node:assert/strict';
import {
  FOREIGN_ADAPTERS, importForeignJsonl, normalizeForeignRow, detectForeignProvider, foreignSourceId, redactForeignText,
  sanitizeForeignValue, searchForeignRows, foreignSourceLabel, foreignBloom, foreignBloomMayContain, foreignStoredBytes,
} from '../foreign-transcripts.mjs';
import { createRunRecorder, searchRecords } from '../run-record.mjs';

async function* chunks(text, size) {
  const bytes = new TextEncoder().encode(text);
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function collect(text, provider, size = 7, limits) {
  const rows = [];
  const source = { name: 'selected.jsonl', size: new TextEncoder().encode(text).length, lastModified: 123 };
  const report = await importForeignJsonl(chunks(text, size), { provider, source, limits, onEntry: async row => rows.push(row) });
  return { rows, report };
}

const claude = [
  { type:'user', uuid:'u1', sessionId:'s1', cwd:'/work/naklios', timestamp:'2026-09-01T10:00:00Z', message:{ role:'user', content:'Find the key sk-proj-abcdefghijklmnopqrstuvwxyz and fix 🧪.' }, apiKey:'hidden-value' },
  { type:'assistant', uuid:'a1', parentUuid:'u1', sessionId:'s1', cwd:'/work/naklios', timestamp:'2026-09-01T10:01:00Z', message:{ role:'assistant', content:[{ type:'text', text:'The fix is in src/app.js.' },{ type:'tool_use', name:'Write', input:{ path:'src/app.js' } }] } },
  { type:'assistant', uuid:'a1', parentUuid:'u1', sessionId:'s1', cwd:'/work/naklios', timestamp:'2026-09-01T10:01:00Z', message:{ role:'assistant', content:[{ type:'text', text:'The fix is in src/app.js.' }] } },
  { type:'queue-operation', uuid:'q1', sessionId:'s1', timestamp:'2026-09-01T10:02:00Z', futureShape:{ accessToken:'hidden-value', kept:'visible' } },
].map(x => JSON.stringify(x)).join('\n') + '\n{bad json\n';

{
  const { rows, report } = await collect(claude, 'claude', 3);
  assert.equal(report.adapter, FOREIGN_ADAPTERS.claude);
  assert.equal(report.lines, 5);
  assert.equal(report.imported, 3);
  assert.equal(report.duplicate, 1);
  assert.equal(report.malformed, 1);
  assert.equal(rows[0].provenance, 'foreign-copy');
  assert.equal(rows[0].project, 'naklios');
  assert.equal(rows[0].toolOutcome, 'unknown');
  assert.equal(rows[0].text.includes('abcdefghijklmnopqrstuvwxyz'), false);
  assert.match(rows[0].text, /\[REDACTED\]/);
  assert.equal(rows[0].raw.includes('hidden-value'), false);
  assert.equal(rows[2].raw.includes('hidden-value'), false);
  assert.equal(rows[2].raw.includes('futureShape'), true);
  assert.equal(rows[1].parentEventId, 'u1');
  assert.equal(foreignSourceLabel(rows[1]), 'selected.jsonl:2');
  const native = createRunRecorder({ app:'anvil', principal:'fixture' });
  await native.start({ messages:[{ role:'user', content:'native-only evidence' }], tools:[] });
  await native.settled();
  assert.deepEqual(searchRecords([{ runId:'foreign', record:rows[0] },{ runId:'native', record:native }], { query:'native-only' }).map(h=>h.runId), ['native']);
  assert.deepEqual(searchRecords([{ runId:'foreign', record:rows[0] }], { query:'fix' }), []);
  assert.deepEqual(searchForeignRows(rows, { query:'fix', provider:'claude', project:'nak', from:'2026-09-01', to:'2026-09-01' }).map(r=>r.id), [rows[1].id,rows[0].id]);
  assert.equal(searchForeignRows(rows, { from:'2026-09-02' }).length, 0);
}

const codex = [
  { type:'session_meta', timestamp:'2026-09-02T11:00:00Z', payload:{ id:'thread-1', cwd:'/work/reel', cli_version:'1.2.3' } },
  { type:'response_item', timestamp:'2026-09-02T11:01:00Z', payload:{ type:'message', role:'user', content:[{ type:'input_text', text:'Repair the player.' }] } },
  { type:'response_item', timestamp:'2026-09-02T11:02:00Z', payload:{ type:'function_call', name:'shell_command', arguments:'{"cmd":"echo hi"}' } },
  { type:'response_item', timestamp:'2026-09-02T11:03:00Z', payload:{ type:'function_call_output', output:'command returned 1' } },
  { type:'future_event', timestamp:'2026-09-02T11:04:00Z', payload:{ future:'retained' } },
].map(x => JSON.stringify(x)).join('\n') + '\n';

{
  const { rows, report } = await collect(codex, 'codex', 5);
  assert.equal(report.metadata, 1);
  assert.equal(report.imported, 4);
  assert.equal(rows.every(r => r.threadId === 'thread-1' && r.project === 'reel' && r.version === '1.2.3'), true);
  assert.equal(rows[1].kind, 'tool-request');
  assert.equal(rows[2].kind, 'tool-observation');
  assert.equal(rows[2].toolOutcome, 'unknown');
  assert.equal(rows[3].kind, 'observation');
  assert.match(rows[3].raw, /future_event/);
  assert.equal(searchForeignRows(rows, { provider:'claude' }).length, 0);
}

{
  const { rows, report } = await collect('x'.repeat(200)+'\n'+JSON.stringify({ type:'user', uuid:'small', message:{content:'ok'} })+'\n', 'claude', 4, { lineChars:100 });
  assert.equal(report.oversized, 1);
  assert.equal(rows.length, 1);
  const bounded = await collect(claude, 'claude', 5, { sourceBytes:10 });
  assert.equal(bounded.report.truncated, true);
  assert.equal(bounded.report.truncationReason, 'file byte cap');
  assert.equal(bounded.rows.length, 0);
  const rejected = await importForeignJsonl(chunks(claude,13), { provider:'claude', source:{name:'stop.jsonl'}, onEntry:async()=> 'archive byte cap' });
  assert.equal(rejected.truncationReason, 'archive byte cap');
  assert.equal(rejected.imported, 0);
}

{
  assert.equal(redactForeignText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz').includes('abcdefghijklmnopqrstuvwxyz'), false);
  const odd = JSON.parse('{"__proto__":{"password":"unsafe"},"next":{"apiKey":"unsafe","tokenCount":123,"kept":"yes"}}');
  const safe = sanitizeForeignValue(odd);
  assert.equal(Object.getPrototypeOf(safe), null);
  assert.equal(safe.__proto__.password, '[REDACTED]');
  assert.equal(safe.next.apiKey, '[REDACTED]');
  assert.equal(safe.next.tokenCount, 123);
  assert.equal(safe.next.kept, 'yes');
  const env = sanitizeForeignValue({ GITHUB_TOKEN:'secret1', ANTHROPIC_API_KEY:'secret2', AWS_SECRET_ACCESS_KEY:'secret3', NPM_TOKEN:'secret4', inputTokens:12, max_tokens:50 });
  assert.equal(env.GITHUB_TOKEN, '[REDACTED]');
  assert.equal(env.ANTHROPIC_API_KEY, '[REDACTED]');
  assert.equal(env.AWS_SECRET_ACCESS_KEY, '[REDACTED]');
  assert.equal(env.NPM_TOKEN, '[REDACTED]');
  assert.equal(env.inputTokens, 12);
  assert.equal(env.max_tokens, 50);
  assert.equal(redactForeignText('GITHUB_TOKEN=do-not-show AWS_SECRET_ACCESS_KEY=also-hidden').includes('do-not-show'), false);
  assert.equal(redactForeignText('GITHUB_TOKEN=do-not-show AWS_SECRET_ACCESS_KEY=also-hidden').includes('also-hidden'), false);
  const camel = sanitizeForeignValue({sessionToken:'secret5',myApiKey:'secret6',userPassword:'secret7',awsSecret:'secret8'});
  assert.equal(Object.values(camel).every(v=>v==='[REDACTED]'),true);
  assert.equal(redactForeignText('sessionToken=secret5 myApiKey=secret6 userPassword=secret7 awsSecret=secret8').includes('secret8'),false);
  assert.equal(normalizeForeignRow(null, { provider:'claude', source:{name:'x'}, line:1 }), null);
  assert.equal(detectForeignProvider(claude), 'claude');
  assert.equal(detectForeignProvider(codex), 'codex');
  assert.equal(detectForeignProvider(''), null);
  assert.equal(detectForeignProvider('{bad json\n{}'), null);
  assert.equal(detectForeignProvider(claude+'\n'+codex), 'mixed');
  assert.notEqual(foreignSourceId('claude',{name:'same',size:10,lastModified:1,sampleDigest:'a'}),
    foreignSourceId('claude',{name:'same',size:10,lastModified:1,sampleDigest:'b'}));
  const text='Find Crate permissions in the selected transcript.';
  const bloom=foreignBloom(text);
  for(let at=0;at<text.length-2;at++) assert.equal(foreignBloomMayContain(bloom,text.slice(at,at+5)),true);
  assert.equal(foreignBloomMayContain(bloom,''),true);
  assert.equal(foreignBloomMayContain(bloom,'zyxwvuunrelatedword'),false);
  const longBloom=foreignBloom('a'.repeat(8000));
  assert.equal(foreignBloomMayContain(longBloom,'unrelatedsearchterm'),false);
  const original=normalizeForeignRow(JSON.parse(claude.split('\n')[0]),{provider:'claude',source:{name:'first.jsonl',size:10,lastModified:1},line:1});
  const second=normalizeForeignRow(JSON.parse(claude.split('\n')[0]),{provider:'claude',source:{name:'second.jsonl',size:10,lastModified:1},line:1});
  assert.notEqual(original.id,second.id);
  assert.equal(original.eventFingerprint,second.eventFingerprint);
  assert.equal(foreignStoredBytes(original)>original.raw.length*2+original.text.length*2,true);
}

console.log('foreign-transcripts: bounded Claude and Codex fixture lanes passed');
