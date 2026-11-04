// How NakliOS opens apps (docs/experience-modes.md). Basic mode was retired on 2026-11-04: one rule, run here
// against the real openApp, and no mode switch, mode pill, mode commands or saved mode left anywhere.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../docs/experience-modes.md', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../sys/host/agent.mjs', import.meta.url), 'utf8');

const { extractFunction, instantiate } = await import('./anvil-harness.mjs');
const calls = [];
const { openApp } = instantiate(extractFunction(html, 'openApp'), '({openApp})', {
  recordRecent: () => {}, openWindows: {}, focusWindow: () => {},
  spawnIframeWindow: app => calls.push(['window', app.id]), spawnInlineWindow: app => calls.push(['inline', app.id]),
  window: { open: url => calls.push(['tab', url]) },
});
openApp({ id: 'files', kind: 'system' }); assert.deepEqual(calls.pop(), ['window', 'files']);
openApp({ id: 'mines', kind: 'classic' }); assert.deepEqual(calls.pop(), ['inline', 'mines']);
openApp({ id: 'web', kind: 'web', url: 'https://example.com' }); assert.deepEqual(calls.pop(), ['window', 'web'], 'a web app opens in a window');
openApp({ id: 'fsa', url: 'https://fsa.example', opensInNewTab: true }); assert.deepEqual(calls.pop(), ['tab', 'https://fsa.example']);
openApp({ id: 'blocked', url: 'https://blocked.example', iframeable: false }); assert.deepEqual(calls.pop(), ['tab', 'https://blocked.example']);

for (const gone of ['function getMode', 'function setMode', 'function effectiveMode', 'id="mode-pill"', 'name="nw-mode"', "maxMode:'basic'", 'mode: state.mode'])
  assert.ok(!html.includes(gone), `retired: ${gone}`);
assert.match(html, /localStorage\.removeItem\(LS_KEY\.mode\)/, 'a saved Basic preference is dropped once');
assert.ok(!/'mode\.(get|set)'/.test(agent), 'the desktop offers no mode commands');

assert.match(readme, /\[how NakliOS opens apps\]\(docs\/experience-modes\.md\)/);
assert.match(policy, /Basic mode, which opened most web apps in browser tabs, was retired on\s+2026-11-04/);
assert.match(policy, /never migrates, copies, deletes, or rebinds app data/);
assert.match(policy, /Opening one never grants same-origin privilege/);

console.log('NakliOS app-opening policy (Basic mode retired): PASS');
