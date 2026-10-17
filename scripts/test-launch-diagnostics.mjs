import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractFunction, instantiate } from './anvil-harness.mjs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const constants=html.match(/const LAUNCH_DIAGNOSTIC_THRESHOLDS = Object\.freeze\(\{[\s\S]*?\}\);/)[0];
const windows={};
for(const [id,timing] of Object.entries({ready:{loaded:6000,ready:100},slowReady:{ready:9000},slowLoad:{loaded:4500},fallback:{timeout:15000},pending:{}})) {
  windows[id]={dataset:{id},_app:{id,name:id},_launchTiming:timing,
    querySelector:()=>({src:'https://naklios.dev/apps/example/?credential=PRIVATE#document',hasAttribute:()=>true})};
}
const snapshot=instantiate(constants+'\n'+extractFunction(html,'launchDiagnosticsSnapshot'),'launchDiagnosticsSnapshot',{
  openWindows:windows,APPS:[],URL,location:{origin:'https://naklios.dev',href:'https://naklios.dev/'},
});
const results=snapshot();
assert.deepEqual(Array.from(results,x=>x.status),['ready','slow-ready','slow-load','fallback','pending']);
assert.ok(Object.isFrozen(results));
for(const row of results) {
  assert.ok(Object.isFrozen(row));assert.equal(row.sandboxed,true);
  assert.equal(row.location,'https://naklios.dev/apps/example/');
}
assert.ok(!JSON.stringify(results).includes('PRIVATE'));
assert.ok(!JSON.stringify(results).includes('document'));
assert.equal(results[0].readyMs,100);
assert.equal(results[0].loadMs,6000,'a late load does not override an earlier usable ready signal');
console.log('launch-diagnostics: real snapshots classify startup states, redact URL details, and remain immutable');
