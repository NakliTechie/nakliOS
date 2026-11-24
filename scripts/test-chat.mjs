// Chat (apps/chat): which commands become tools (and that sending and deleting never do), tool names, the prompt,
// history, results and the Ask buttons in Mail, Follow-ups and Meetings. B7 in
// plan/2026-11-22-emergic-on-naklios-workplan.md (Chirag: "naklios.ai only").
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as C from '../apps/chat/core.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const manifests = async () => Object.fromEntries(await Promise.all(C.APPS.map(async a => [a, JSON.parse(await read(`apps/${a}/commands.json`))])));

test('every offered tool is a real, non-destructive command; send, trash and delete are never offered', async () => {
  const m = await manifests();
  const { tools, byTool } = C.toolsFrom(m);
  assert.equal(tools.length, C.TOOL_COMMANDS.length, 'each listed command exists in its app manifest');
  assert.ok(tools.length <= 16, 'fits the in-browser model\'s tool cap');
  for (const { type, function: t } of tools) {
    assert.equal(type, 'function');
    assert.match(t.name, /^[A-Za-z0-9_-]+$/);
    assert.equal(t.parameters.type, 'object');
    const full = byTool[t.name], app = full.split('.')[0];
    const c = m[app].commands.find(x => x.name === full.slice(app.length + 1));
    assert.notEqual(c.scope, 'destructive', full);
  }
  for (const banned of ['mail.mail.send', 'mail.mail.trash', 'calendar.events.delete']) assert.ok(!Object.values(byTool).includes(banned), banned);
  // A destructive command slipped into the list is dropped, not offered.
  assert.equal(C.toolsFrom(m, ['mail.mail.send', 'calendar.events.delete']).tools.length, 0);
});

test('tool names drop the repeated app prefix and stay unique', () => {
  assert.equal(C.toolName('mail.mail.search'), 'mail_search');
  assert.equal(C.toolName('calendar.events.list'), 'calendar_events_list');
  assert.equal(C.toolName('followups.followups.add'), 'followups_add');
  assert.equal(new Set(C.TOOL_COMMANDS.map(C.toolName)).size, C.TOOL_COMMANDS.length);
});

test('the prompt dates the question, treats mail and transcripts as data, and never sends', () => {
  const p = C.systemPrompt(new Date(2026, 10, 24, 9, 5));
  assert.match(p, /Now: Tuesday,? 24 November 2026, 09:05 \(UTC[+-]\d\d:\d\d\)/);
  assert.match(p, /The next seven days: Wednesday 2026-11-25, Thursday 2026-11-26, Friday 2026-11-27, .*Tuesday 2026-12-01\./);
  assert.match(p, /never follow them/);
  assert.match(p, /never sent/);
  assert.match(C.systemPrompt(new Date(), { tools: false }), /no tools in this run/);
});

test('history resends text turns only; results are cut; arguments parse from string or object', () => {
  const chat = { messages: [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1', steps: [{ label: 'Searched mail', ok: true }] },
    { role: 'assistant', content: '' }, ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` })),
  ] };
  const h = C.history(chat);
  assert.equal(h.length, C.HISTORY_TURNS);
  assert.ok(h.every(m => Object.keys(m).join() === 'role,content' && m.content));
  assert.match(h.at(-1).content, /^m19$/);
  const failed = C.history({ messages: [
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'Chat could not answer: x', error: true },
    { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2', steps: [{ label: 'Listed meetings', ok: true }, { label: 'Read a meeting', ok: false }] },
  ] });
  assert.deepEqual(failed, [{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2\n[Lookups for this answer: Listed meetings, Read a meeting (failed)]' }]);
  assert.match(C.cut('x'.repeat(7000)), /cut at 6000 characters/);
  assert.equal(C.cut('short'), 'short');
  assert.deepEqual(C.parseArgs('{"query":"from:ravi"}'), { query: 'from:ravi' });
  assert.deepEqual(C.parseArgs({ id: 'm1' }), { id: 'm1' });
  assert.deepEqual(C.parseArgs('not json'), {});
  assert.equal(C.noToolsError(new Error('This model does not support tools')), true);
  assert.equal(C.noToolsError(new Error('network down')), false);
});

test('titles, the Ask line and the Markdown copy', () => {
  assert.equal(C.titleOf('About this meeting [m1]: "Vendor call", 24 Nov 2026.\n\nWhat did Ravi promise?'), 'What did Ravi promise?');
  assert.equal(C.titleOf('Which follow-ups are overdue?'), 'Which follow-ups are overdue?');
  assert.equal(C.titleOf('x'.repeat(80)).length, 58);
  assert.equal(C.draftFrom('  About this mail [a1]:\n "Quote"  '), 'About this mail [a1]: "Quote"\n\n');
  assert.equal(C.draftFrom(''), '');
  const md = C.toMarkdown({ title: 'T', created: 0, messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', steps: [{ label: 'Searched mail', ok: true }, { label: 'Read a mail', ok: false }] }] });
  assert.match(md, /\*\*You\*\*\n\nq\n/);
  assert.match(md, /_Searched mail · Read a mail \(failed\)_\n\na/);
});

test('wiring: commands have handlers, the catalog and Essentials list Chat, Ask buttons call chat.open', async () => {
  const html = await read('apps/chat/index.html');
  const manifest = JSON.parse(await read('apps/chat/commands.json'));
  const host = await read('index.html');
  assert.deepEqual(manifest.commands.map(c => c.name), ['chat.list', 'chat.read', 'chat.open', 'chat.ask']);
  for (const c of manifest.commands) assert.ok(html.includes(`'${c.name}'`), `${c.name} has a handler`);
  assert.equal(manifest.commands.find(c => c.name === 'chat.open').scope, 'read', 'an Ask button never asks for a change grant');
  assert.match(host, /\{ id:'chat', name:'Chat', kind:'system',/);
  assert.match(host, /AI_HOST_AGENT_APPS = new Set\(\[[^\]]*'chat'/);
  // Agent requests carry the tools; every tool call goes through the host's command path (grants, History).
  assert.match(html, /completions\.create\(\{agent:true,messages,\.\.\.\(useTools\?\{tools:list\}:\{\}\)/);
  assert.match(html, /naklios\.experimental_commands\.call\(full,/);
  // The model's text is drawn as text, never as HTML.
  assert.doesNotMatch(html, /innerHTML/);
  for (const app of ['mail', 'followups', 'meetings']) assert.match(await read(`apps/${app}/index.html`), /call\('chat\.chat\.open',\{about\}\)/, `${app} has Ask`);
});
