// Execute the shipped SDK, real host message callback, registry, grants, and
// campaign harness. No provider, browser profile, or network request is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { extractFunction, instantiate } from './anvil-harness.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace, installWindowRig, wireWindowRig } from '../sys/rig/agent/index.mjs';
import { createHostRegistry, HOST_COMMANDS } from '../sys/host/agent.mjs';
import { newRootKey } from '../sys/identity/grant.mjs';
import { mintRole, guardedAccess } from '../sys/assay/roles.mjs';
import { createAssayLedger } from '../sys/assay/ledger.mjs';
import { makeCampaignExecutors } from '../sys/assay/executors.mjs';
import { createWorkspaceChecker } from '../sys/assay/checker.mjs';
import { verifyWall } from '../sys/assay/verify.mjs';

const sdk=await readFile(new URL('../sdk/naklios.js',import.meta.url),'utf8');
function sdkFrame({hosted=true,script=sdk}={}) {
  const sent=[];let receive;
  const parent={postMessage:(message,origin)=>sent.push({message,origin})};
  const window={location:{search:'?naklios'},parent,addEventListener:(type,fn)=>{if(type==='message')receive=fn;}};
  if(!hosted)window.parent=window;
  vm.runInNewContext(script,{window,document:{},URL,URLSearchParams,Map,Set,Promise,Date,Error,Object,
    setTimeout:()=>0,clearTimeout:()=>{}});
  return {api:window.naklios,sent,parent,send:(origin,data,source=window.parent)=>receive({origin,data,source})};
}
for(const origin of ['https://evil.example','null','https://naklios.dev.evil.example','https://naklios.dev:444']) {
  const app=sdkFrame();
  app.send(origin,{type:'naklios:capabilities',fs:true,ai:true,review:true});
  assert.equal(app.api.capabilities.fs,false,`untrusted first parent ${origin}`);
  app.api.title('private-title');
  assert.ok(!app.sent.some(x=>JSON.stringify(x).includes('private-title')),'no private title before verified parent');
  app.send('https://naklios.dev',{type:'naklios:capabilities',fs:true},{});
  assert.equal(app.api.capabilities.fs,false,'origin alone cannot impersonate parent');
  app.send('https://naklios.dev',{type:'naklios:capabilities',fs:true});
  assert.equal(app.api.capabilities.fs,true,'a rejected first message cannot poison the legitimate handshake');
  assert.equal(app.sent.find(x=>x.message.title==='private-title')?.origin,'https://naklios.dev','queued startup messages retain functionality without exposing data to an unknown parent');
  app.api.title('allowed-title');assert.equal(app.sent.at(-1).origin,'https://naklios.dev');
}
const mirrorManifest=JSON.parse(await readFile(new URL('../apps/manifest.json',import.meta.url),'utf8'));
let managedCopies=0;
for(const app of mirrorManifest.apps)for(const file of app.files.filter(f=>f.managedSdk)) {
  const text=await readFile(new URL(`../apps/${app.id}/${file.destination}`,import.meta.url),'utf8');
  const script=file.managedSdk==='file'?text:text.match(/\/\*\s*naklios-sdk:begin\b[^*]*\*\/([\s\S]*?)\/\*\s*naklios-sdk:end\s*\*\//)[1];
  const copy=sdkFrame({script});copy.send('https://evil.example',{type:'naklios:capabilities',fs:true});
  assert.equal(copy.api.capabilities.fs,false,`${app.id}: deployed SDK refuses forged first parent`);
  copy.send('https://naklios.dev',{type:'naklios:capabilities',fs:true});assert.equal(copy.api.capabilities.fs,true);
  managedCopies++;
}
assert.equal(managedCopies,7,'every declared hosted SDK copy is exercised');
const alone=sdkFrame({hosted:false});
alone.send('https://naklios.dev',{type:'naklios:capabilities',fs:true});
assert.equal(alone.api.capabilities.fs,false,'standalone query flags do not create host authority');
for(const origin of ['http://127.0.0.1:8947','https://nakli-dev.chirag-patnaik.workers.dev','https://version-nakli-dev.chirag-patnaik.workers.dev']) {
  const app=sdkFrame();app.send(origin,{type:'naklios:capabilities',fs:true});assert.equal(app.api.capabilities.fs,true,origin);
}

const host=await readFile(new URL('../index.html',import.meta.url),'utf8');
const apps=[{id:'anvil',kind:'system',embedUrl:'./apps/anvil/'},{id:'catalog',kind:'web',url:'https://naklios.dev/apps/catalog/'},
  {id:'external-system',kind:'system',url:'https://elsewhere.example/'},{id:'personal',kind:'system',thirdParty:true,embedUrl:'./apps/personal/'}];
const location={href:'https://naklios.dev/',origin:'https://naklios.dev',hostname:'naklios.dev'};
const gate=instantiate([extractFunction(host,'appExpectedOrigin'),extractFunction(host,'aiAppOwnsEgress')].join('\n'),
  'aiAppOwnsEgress',{APPS:apps,location,URL});
for(const id of ['catalog','external-system','personal','missing'])assert.equal(gate(id),false,id);
assert.equal(gate('anvil'),true);
const begin=host.indexOf("window.addEventListener('message', async e => {\n  if (!knownIframes.has(e.source)) return;");
const end=host.indexOf('\n});',begin);assert.ok(begin>0&&end>begin);
async function driveNet(id,origin='https://naklios.dev',expected=origin,type='naklios:net:fetch') {
  const sent=[];let listener,calls=0;
  const source={postMessage:(message,target)=>sent.push({message,target})};
  const win={dataset:{id},_expectedOrigin:expected};
  const iframe={contentWindow:source,closest:()=>win};
  const scope={window:{addEventListener:(_,fn)=>{listener=fn;}},knownIframes:new Set([source]),
    document:{querySelectorAll:()=>[iframe]},aiAppOwnsEgress:gate,egressConfigured:()=>true,
    egressBackendLabel:()=> 'worker',netHostFetch:async()=>{calls++;return {status:200};}};
  new Function(...Object.keys(scope),host.slice(begin,end+4))(...Object.values(scope));
  await listener({source,origin,data:{type,requestId:'request',url:'https://example.com'}});
  return {calls,sent};
}
for(const id of ['catalog','external-system','personal','missing']) {
  const result=await driveNet(id);assert.equal(result.calls,0,id);assert.match(result.sent[0].message.error,/same-origin system/);
  assert.match((await driveNet(id,undefined,undefined,'naklios:net:info')).sent[0].message.error,/same-origin system/);
}
assert.equal((await driveNet('anvil')).calls,1);
assert.equal((await driveNet('anvil','https://evil.example','https://naklios.dev')).sent.length,0);
assert.equal((await driveNet('anvil','https://naklios.dev',null)).sent.length,0,'missing origin is not a wildcard');

const fs=createFileops({backend:new MemoryBackend()});
await fs.write('keep.txt','keep');await fs.write('other.txt','other');
const registry=buildRigRegistry({fs});
const grant=createGrant({prefixes:[''],scopes:['fs:read','fs:write','fs:remove']});
const face=createAgentFace({registry,grant,opLog:createOpLog({fs:createFileops({backend:new MemoryBackend()})})});
const target={};installWindowRig({target,enabled:false,face});assert.equal(target.rig,undefined);
installWindowRig({target,enabled:true,face});assert.equal(target.rig.accept,undefined,'operator approval is not on the agent surface');
const input={path:'keep.txt'};const proposal=await target.rig.invoke('fs.remove',input);
assert.equal(proposal.staged,true);input.path='other.txt';
proposal.input.path='other.txt';
const displayed=face.proposal(proposal.proposalId);displayed.input.path='other.txt';
assert.equal(face.proposal(proposal.proposalId).input.path,'keep.txt','returned proposals and review details cannot mutate staged authority');
assert.equal((await fs.stat('keep.txt')).ok,true,'staging does not delete');
assert.equal((await target.rig.invoke('accept',{id:proposal.proposalId})).ok,false,'approval cannot be invoked as a command');
await face.accept(proposal.proposalId);
assert.equal((await fs.stat('other.txt')).ok,true,'caller mutation cannot retarget a staged operation');
const protectedGrant=createGrant({prefixes:[''],scopes:['fs:read','fs:write'],readOnlyPrefixes:['protected']});
const protectedFace=createAgentFace({registry,grant:protectedGrant,opLog:createOpLog({fs:createFileops({backend:new MemoryBackend()})})});
protectedFace.describeCommand('fs.copy').sourceParams.push('to');
assert.equal((await protectedFace.invoke('fs.copy',{from:'other.txt',to:'protected/stolen.txt'})).code,'EGRANT',
  'discovery metadata cannot change which paths the grant protects');

class Element {
  constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.style={};}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  addEventListener(type,handler){this.listeners[type]=handler;}
}
const document={body:new Element('body'),createElement:tag=>new Element(tag),createTextNode:text=>({text})};
const settings=new Map();const operatorWindow={document,addEventListener:()=>{},
  sessionStorage:{getItem:key=>settings.get(key),setItem:(key,value)=>settings.set(key,value)}};
const control=wireWindowRig({target:operatorWindow,getFace:()=>face});
const option=control.panel.children.find(x=>x.tag==='label'),toggle=option.children[0];
toggle.checked=true;toggle.listeners.change({isTrusted:false});assert.equal(operatorWindow.rig,undefined);
toggle.checked=true;toggle.listeners.change({isTrusted:true});assert.ok(operatorWindow.rig);
await fs.write('review.txt','review');
await operatorWindow.rig.invoke('fs.remove',{path:'review.txt'});
const review=control.panel.children.find(x=>x.tag==='button');review.listeners.click();
const list=control.panel.children.at(-1),row=list.children[0];
const accept=row.children.find(x=>x.textContent==='Accept');
await accept.listeners.click({isTrusted:false});assert.equal((await fs.stat('review.txt')).ok,true);
await accept.listeners.click({isTrusted:true});assert.equal((await fs.stat('review.txt')).ok,false,'operator UI executes the staged request');
const actions=Object.fromEntries(HOST_COMMANDS.map(row=>[row[2],()=>null]));
const hostRegistry=createHostRegistry(actions);
assert.equal(hostRegistry.list().length,HOST_COMMANDS.length+8);
assert.deepEqual(hostRegistry.list().map(x=>x.name),hostRegistry.toolSchemas().map(x=>x.name),'manifest and bus parity');
assert.equal((await hostRegistry.invokeCommand('mode.set',{id:'unsafe'})).ok,false);
assert.equal((await hostRegistry.invokeCommand('credentials.configure',{})).ok,false);
assert.throws(()=>createHostRegistry({...actions,unlisted:()=>{}}),/Undeclared/,'an undeclared host action fails parity');

const checkBackend=new MemoryBackend();
await checkBackend.write('answer.txt',new TextEncoder().encode('wrong\n'));
const actualChecker=createWorkspaceChecker({backend:checkBackend});
const isolated=await actualChecker({command:'echo changed > answer.txt; cat answer.txt'});
assert.equal(isolated.stdout,'changed\n');
assert.equal(new TextDecoder().decode(await checkBackend.readBinary('answer.txt')),'wrong\n','checker writes never alter the candidate');
const C='launch-proof',L=createAssayLedger(),key=newRootKey();
const roles={};for(const role of ['builder','checker','lead'])roles[role]=await mintRole(key,{campaign:C,role,principal:`actor:agent:${role}:${C}`,now:0});
assert.equal(verifyWall(L,{campaign:C,requireEnforcement:true}).ok,false,'an unexercised wall is not verified');
let modelMeasures=0;
const executors=makeCampaignExecutors({campaign:C,goal:'exact file contents',
  access:(role,resource,tool)=>guardedAccess(roles[role],key,{principal:roles[role].principal,tool,target:`assay:${C}:${resource}`,now:1},L,{campaign:C}),
  runRole:async({action,authorize})=>{
    if(action==='build-instrument')return {version:1,cases:[{id:'one',command:'cat answer.txt',expected:{exitCode:0,stdout:'correct\n'},weight:1}]};
    if(action==='measure'){modelMeasures++;return {pass_mass:1,clusters:[]};}
    if(action==='build-candidate'){await assert.rejects(authorize('instrument','read'),/denied/);return {git_ref:'c0',test_count:1,deleted:0};}
    return {};
  },
  runCheck:actualChecker,
});
await executors['build-instrument']({ledger:L,round:0});
await executors['build-candidate']({ledger:L,round:0});
assert.equal(verifyWall(L,{campaign:C,requireEnforcement:true}).ok,false,'real role denial records a breach');
const measured=await executors.measure({ledger:L,round:0});
assert.equal(measured[0].pass_mass,0,'the checker model cannot invent a passing score');
assert.equal(measured[0].provenance,'harness-executed');assert.equal(modelMeasures,0);
assert.equal(measured[0].cases_executed,1);
assert.equal(JSON.stringify(L.blocks).includes('correct\\n'),false,'the public ledger does not contain raw cases');
console.log('launch-blockers: SDK parent forgery, host egress authority, staged approval, manifest parity, enforced role wall, and execution-backed scoring passed');
