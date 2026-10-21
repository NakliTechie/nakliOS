import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../docs/experience-modes.md', import.meta.url), 'utf8');

const {extractFunction,instantiate}=await import('./anvil-harness.mjs');
const functions=['getDefaultMode','getMode','effectiveMode','setMode','openApp'];
const calls=[];const state={mode:null};const saved=new Map();
const mode=instantiate(functions.map(n=>extractFunction(html,n)).join('\n'),'({getMode,effectiveMode,setMode,openApp})',{
  state,LS_KEY:{mode:'mode'},localStorage:{setItem:(k,v)=>saved.set(k,v)},
  renderModePill:()=>{},fsScheduleStateWrite:()=>{},recordRecent:()=>{},openWindows:{},focusWindow:()=>{},
  spawnIframeWindow:app=>calls.push(['iframe',app.id]),spawnInlineWindow:app=>calls.push(['inline',app.id]),
  window:{open:url=>calls.push(['tab',url])},
});
assert.equal(mode.getMode(),'immersive');
mode.setMode('basic');assert.equal(saved.get('mode'),'basic');
mode.openApp({id:'system',kind:'system'});assert.deepEqual(calls.pop(),['iframe','system']);
mode.openApp({id:'catalog',kind:'web',url:'https://example.com'});assert.deepEqual(calls.pop(),['tab','https://example.com']);
mode.setMode('immersive');assert.equal(mode.effectiveMode({maxMode:'basic'}),'basic');assert.equal(mode.getMode(),'immersive');
mode.openApp({id:'compatible',kind:'web'});assert.deepEqual(calls.pop(),['iframe','compatible']);
mode.openApp({id:'legacy',kind:'classic'});assert.deepEqual(calls.pop(),['inline','legacy']);
mode.openApp({id:'blocked',iframeable:false,url:'https://example.com'});assert.deepEqual(calls.pop(),['tab','https://example.com']);

assert.match(readme, /\[`Experience mode policy`\]\(docs\/experience-modes\.md\)/);
assert.match(policy, /\*\*Keep Basic\.\*\*/);
assert.match(policy, /Switching modes does not migrate, copy, delete, or rebind app data/);
assert.match(policy, /mode switch never\s+grants same-origin privilege/);
assert.match(policy, /“Mode C” is not current product\s+terminology/);

console.log('NakliOS experience-mode compatibility policy: PASS');
