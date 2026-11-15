// test-host-rpc-wait.mjs — a host prompt an app's call can open stops that call's 30 s clock.
//
// The SDK rejects a call after 30 s unless the host sends naklios:rpc:waiting. Storage prompts did; the
// Send to / Open with / Edit in Anvil confirms, network grants, on-device helper prompts and the semantic
// search prompt did not, so a person who took more than 30 s to answer got "naklios RPC timeout" while the
// host still carried out the action (Lorewell → Lectella, 2026-11-15). This runs the real registry from
// index.html, then checks every prompt site notifies before its dialog and every dispatch branch holds.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// 1. The registry itself, extracted and run.
const reg = host.match(/const rpcWaiters = new Map\(\);[\s\S]*?\nfunction rpcPromptOpens\(appId\)\{[\s\S]*?\n\}\n/);
assert.ok(reg, 'rpcHold and rpcPromptOpens found in index.html');
const { rpcHold, rpcPromptOpens, rpcWaiters } = new Function(`${reg[0]}; return { rpcHold, rpcPromptOpens, rpcWaiters };`)();
const heard = [];
const releaseA1 = rpcHold('lorewell', () => heard.push('a1'));
const releaseA2 = rpcHold('lorewell', () => heard.push('a2'));
const releaseB = rpcHold('pi', () => heard.push('b'));
rpcPromptOpens('lorewell');
assert.deepEqual(heard.sort(), ['a1', 'a2'], 'a prompt for one app tells only that app\'s calls');
releaseA1(); releaseA2();
heard.length = 0;
rpcPromptOpens('lorewell');
assert.deepEqual(heard, [], 'a finished call hears nothing');
assert.ok(!rpcWaiters.has('lorewell'), 'the app\'s entry is removed once its calls finish');
releaseB();
assert.equal(rpcWaiters.size, 0);
assert.doesNotThrow(() => rpcHold(null, () => {})(), 'a call with no app id holds nothing');
rpcHold('x', () => { throw new Error('closed frame'); });
assert.doesNotThrow(() => rpcPromptOpens('x'), 'a notice that throws does not stop the prompt');

// 2. Every prompt an app's call can reach notifies before its dialog.
function body(name) {
  const start = host.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start > 0, `${name} found`);
  const next = host.slice(start + 1).search(/\n(async )?function [A-Za-z0-9_]+\(/);
  return host.slice(start, start + 1 + next);
}
for (const name of ['fileHostSendTo', 'fileHostOpenWith', 'fileHostEditInAnvil', 'netEnsureGrant', 'aiAskLocal', 'ragEnsurePermission']) {
  const b = body(name);
  const notice = b.indexOf('rpcPromptOpens(');
  const dialog = b.indexOf('nakliosConfirm(');
  assert.ok(notice > 0 && dialog > notice, `${name} calls rpcPromptOpens before nakliosConfirm`);
}
assert.match(body('netEnsureGrant'), /if \(netPrompts\.has\(key\)\) \{ rpcPromptOpens\(appId\); return netPrompts\.get\(key\); \}/,
  'a call that joins a network prompt already open is told too');

// 3. Every dispatch branch that can reach those prompts holds its call's notice for its lifetime.
const holds = [
  [/releaseHold = rpcHold\(appId, msg\._onWait\);/, 'file handoff (Send to, Open with, Edit in Anvil)'],
  [/const releaseHold = rpcHold\(appId, fsWaitNotice\(source, msg\.requestId, replyTo\)\);\n\s*try \{ reply\.result = await \(msg\.type === 'naklios:ai:embed'/, 'on-device helpers'],
  [/const releaseHold = rpcHold\(appId, fsWaitNotice\(e\.source, msg\.requestId, replyTo\)\);\n\s*try \{ reply\.result = await netHostFetch/, 'net.fetch'],
  [/const releaseHold = rpcHold\(appId, fsWaitNotice\(e\.source, msg\.requestId, replyTo\)\);\n\s*try \{ reply\.result = msg\.type === 'naklios:web:search'/, 'web search and fetch'],
  [/const releaseHold = rpcHold\(appId, fsWaitNotice\(e\.source, msg\.requestId, replyTo\)\);\n\s*try \{ reply\.result = await ragHostSearch/, 'semantic search'],
];
for (const [re, what] of holds) assert.match(host, re, `${what} holds its call while a prompt may open`);
assert.match(host, /\} finally \{ releaseHold\(\); \}\n    if \(msg\.requestId\) \{\n      try \{ e\.source\.postMessage\(reply, replyTo\); \} catch\(_\)\{\}\n    \}\n  \} else if \(msg\.type === 'naklios:ai:embed'/,
  'the file branch releases its hold on every path');

console.log('host rpc wait: prompts for Send to, Open with, Edit in Anvil, network, on-device helpers and semantic search stop the calling app\'s 30 s clock — PASS');
