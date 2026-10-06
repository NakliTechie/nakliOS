import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {extractFunction,evaluate} from './anvil-harness.mjs';
import * as binaryModule from '../sys/storage/binary-read.mjs';
const host=await readFile(new URL('../index.html',import.meta.url),'utf8'),sdk=await readFile(new URL('../sdk/naklios.js',import.meta.url),'utf8');
const rows=[];
const test=async(label,fn)=>{await fn();rows.push({label,pass:true})};
const bytes=Uint8Array.from({length:64},(_,i)=>i),native=new Blob([bytes]);
let file=native,whole=0,slices=[],paths=[],allowed=true,bound='fsa',crateReads=0;
const observed={size:64,arrayBuffer:async()=>{whole++;return native.arrayBuffer()},slice:(a,b)=>{slices.push([a,b]);return native.slice(a,b)}};
file=observed;
const context={Uint8Array,TextDecoder,binaryModule,state:{fsHandle:{},crate:{read:async()=>{crateReads++;return bytes}}},
  fsGetDir:async path=>{paths.push(path);return {name:path.split('/').at(-1),dir:{getFileHandle:async()=>({getFile:async()=>file})}}},
  fsEnsurePermission:async()=>allowed?bound:null,aiAppOwnsSystemFs:id=>id==='anvil',capabilities:{fsBackend:'fsa',fsRangeReads:true},
  fsHostSerial:(_key,fn)=>fn(),
};
const backendStart=host.indexOf('const BACKENDS ='),backendEnd=host.indexOf('\n};',backendStart)+3;
assert.ok(backendStart>0&&backendEnd>backendStart);
const names=['fsReadBinary','fsSafePath','fsSysCleanPath','fsHostReadLimit','fsHostReadOffset','fsHostHandleNow','fsSysBackend','fsHostSysHandle'];
const code=names.map(n=>extractFunction(host,n)).join('\n').replace("await import('./sys/storage/binary-read.mjs')",'binaryModule');
const api=evaluate(code+'\n'+host.slice(backendStart,backendEnd)+'\n;({BACKENDS,fsReadBinary,fsHostHandleNow,fsHostSysHandle})',context);
const reads=[...sdk.matchAll(/readBinary:\s*(function\s*\(path, options\)\s*\{[^\n]+\})/g)];assert.equal(reads.length,2);
const sdkReads=reads.map((m,i)=>evaluate(extractFunction(sdk,'fsPayload')+'\n'+extractFunction(sdk,'fsBinaryRead')+'\n;('+m[1]+')',{
  capabilities:context.capabilities,rpc:(type,msg)=>i===0?api.fsHostHandleNow(msg,'readBinary','editor'):api.fsHostSysHandle(msg,'readBinary','anvil'),
}));
await test('App SDK byte range preserves exact offset, cap, backend and namespace',async()=>{
  assert.deepEqual(Array.from(await sdkReads[0]('owned.bin',{offset:16,maxBytes:8})),[16,17,18,19,20,21,22,23]);
  assert.equal(paths.at(-1),'apps/editor/owned.bin');assert.deepEqual(slices.at(-1),[16,24]);assert.equal(whole,0);
});
await test('System SDK byte range preserves exact offset and system path',async()=>{
  assert.deepEqual(Array.from(await sdkReads[1]('apps/anvil/owned.bin',{offset:60,maxBytes:8})),[60,61,62,63]);assert.equal(paths.at(-1),'apps/anvil/owned.bin');
});
await test('Whole-file cap still refuses oversized snapshots before allocation',async()=>{
  await assert.rejects(sdkReads[0]('owned.bin',{maxBytes:8}),/EFBIG/);assert.equal(whole,0);
});
await test('Unbounded and capped whole-file reads preserve legacy bytes',async()=>{
  assert.deepEqual(Array.from(await sdkReads[0]('owned.bin')),Array.from(bytes));
  assert.deepEqual(Array.from(await sdkReads[0]('owned.bin',{maxBytes:64})),Array.from(bytes));assert.equal(whole,2);
});
await test('Offset zero requests a prefix rather than a whole-file cap',async()=>{
  assert.deepEqual(Array.from(await sdkReads[0]('owned.bin',{offset:0,maxBytes:3})),[0,1,2]);assert.equal(whole,2);
});
await test('Zero-length and EOF ranges perform no byte allocation',async()=>{
  const count=slices.length;
  for(const opts of [{offset:16,maxBytes:0},{offset:64,maxBytes:8},{offset:1000,maxBytes:8},{offset:Number.MAX_SAFE_INTEGER,maxBytes:8}])assert.equal((await sdkReads[0]('owned.bin',opts)).length,0);
  assert.equal(slices.length,count);assert.equal(whole,2);
});
await test('Malformed ranges fail before filesystem traversal',async()=>{
  const count=paths.length;
  for(const offset of [-1,0.5,'16',null,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(sdkReads[0]('owned.bin',{offset,maxBytes:8}),/EINVAL/);
  await assert.rejects(sdkReads[0]('owned.bin',{offset:0}),/EINVAL/);
  for(const maxBytes of [-1,0.5,'8',NaN,Infinity])await assert.rejects(sdkReads[0]('owned.bin',{offset:0,maxBytes}),/EINVAL/);
  await assert.rejects(sdkReads[0]('owned.bin',{offset:0,maxBytes:binaryModule.MAX_BINARY_RANGE_BYTES+1}),/EFBIG/);assert.equal(paths.length,count);
});
await test('App traversal, system traversal, permission denial and backend drift refuse reads',async()=>{
  const count=paths.length;
  await assert.rejects(sdkReads[0]('../other.bin',{offset:0,maxBytes:8}),/Invalid path/);
  await assert.rejects(sdkReads[1]('apps/anvil/../secret',{offset:0,maxBytes:8}),/Invalid path/);
  allowed=false;await assert.rejects(sdkReads[0]('owned.bin',{offset:0,maxBytes:8}),/Permission denied/);allowed=true;
  context.capabilities.fsBackend='crate';await assert.rejects(sdkReads[0]('owned.bin',{offset:0,maxBytes:8}),/Storage backend changed/);context.capabilities.fsBackend='fsa';
  await assert.rejects(api.fsHostSysHandle({path:'owned.bin',offset:0,maxBytes:8},'readBinary','third-party'),/system apps only/);assert.equal(paths.length,count);
});
await test('Crate refuses both bounded and offset reads before provider I/O',async()=>{
  bound='crate';context.capabilities.fsBackend='crate';
  await assert.rejects(sdkReads[0]('owned.bin',{offset:0,maxBytes:8}),/ENOTSUP/);
  await assert.rejects(api.BACKENDS.crate.readBinary('owned.bin',undefined,0),/ENOTSUP/);
  await assert.rejects(sdkReads[0]('owned.bin',{maxBytes:8}),/ENOTSUP/);assert.equal(crateReads,0);
  assert.equal((await sdkReads[0]('owned.bin')).length,64);assert.equal(crateReads,1);
  bound='fsa';context.capabilities.fsBackend='fsa';
});
await test('Pinned Crate SDK receives whole-object caps while byte ranges remain unavailable',async()=>{
  bound='crate';context.capabilities.fsBackend='crate';context.state.crate.supportsBoundedReads=true;
  const previous=context.state.crate.read;const seen=[];
  context.state.crate.read=async(path,options)=>{seen.push({path,options});return bytes.slice(0,8)};
  try {
    assert.equal((await sdkReads[0]('owned.bin',{maxBytes:8})).length,8);
    assert.equal(seen.length,1);assert.equal(seen[0].path,'/apps/editor/owned.bin');assert.equal(seen[0].options.maxBytes,8);
    await assert.rejects(api.BACKENDS.crate.readBinary('owned.bin',8,0),/ENOTSUP/);assert.equal(seen.length,1);
  } finally {context.state.crate.read=previous;delete context.state.crate.supportsBoundedReads;bound='fsa';context.capabilities.fsBackend='fsa'}
});
await test('Large snapshots allocate only the requested native Blob slice',async()=>{
  const count=whole;file={size:2**31,arrayBuffer:async()=>{whole++;throw Error('whole read forbidden')},slice:(a,b)=>new Blob([Uint8Array.from({length:b-a},(_,i)=>(a+i)%256)])};
  assert.deepEqual(Array.from(await sdkReads[0]('large.bin',{offset:2**30+16,maxBytes:8})),[16,17,18,19,20,21,22,23]);assert.equal(whole,count);file=observed;
});
await test('Invalid metadata or missing slice capability fails closed',async()=>{
  for(const size of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])await assert.rejects(binaryModule.readFileBytes({size,slice(){}},{offset:0,maxBytes:8}),/ENOTSUP/);
  await assert.rejects(binaryModule.readFileBytes({size:64,arrayBuffer(){throw Error('whole read')}},{offset:0,maxBytes:8}),/ENOTSUP/);
});
await test('Malformed or oversized provider slices fail before buffer reads',async()=>{
  let allocations=0;
  for(const slice of [null,{size:64,arrayBuffer:async()=>{allocations++;return bytes.buffer}},{size:8}])await assert.rejects(binaryModule.readFileBytes({size:64,slice:()=>slice},{offset:16,maxBytes:8}),/ENOTSUP/);
  assert.equal(allocations,0);
});
await test('Unexpected slice byte lengths refuse instead of returning extra bytes',async()=>{
  for(const length of [7,9])await assert.rejects(binaryModule.readFileBytes({size:64,slice:()=>({size:8,arrayBuffer:async()=>new ArrayBuffer(length)})},{offset:16,maxBytes:8}),/EIO/);
});
// Load the complete production SDK and deliver actual capability/reply messages.
// An old host ignores offset; rejected mixed-version calls must never reach it.
const messages=[],listeners=new Map();let oldHost=true;
let win;
const parent={postMessage(msg,origin){
  if(!msg.requestId)return;
  messages.push({type:msg.type,path:msg.path,offset:msg.offset,maxBytes:msg.maxBytes,backend:msg.backend,origin});
  const result=oldHost?bytes.slice(0,8):bytes.slice(msg.offset||0,(msg.offset||0)+(msg.maxBytes??64));
  listeners.get('message')({source:parent,origin:'http://host.test',data:{type:'naklios:fs:reply',requestId:msg.requestId,result}});
}};
win={parent,addEventListener:(type,cb)=>listeners.set(type,cb),removeEventListener(){},
  location:{search:'?naklios',href:'http://host.test/apps/editor/',origin:'http://host.test'},
  document:{referrer:'',addEventListener(){},documentElement:{dataset:{},style:{}},querySelector(){return null}},
  navigator:{userAgent:''},setTimeout(){return 0},clearTimeout(){},console,URLSearchParams};
win.window=win;win.self=win;win.top=parent;win.globalThis=win;
vm.runInNewContext(sdk,win,{filename:'naklios.js'});
const announce=extra=>listeners.get('message')({source:parent,origin:'http://host.test',data:{type:'naklios:capabilities',fs:true,fsBackend:'fsa',fsBoundedReads:true,...extra}});
await test('Complete SDK defaults to refusing ranges before a handshake',async()=>{
  assert.equal(win.naklios.capabilities.fsRangeReads,false);
  await assert.rejects(win.naklios.fs.readBinary('owned.bin',{offset:16,maxBytes:8}),/ENOTSUP/);assert.equal(messages.length,0);
});
await test('Old host bounded-whole flag never authorizes app or system ranges',async()=>{
  announce({});
  assert.equal(win.naklios.capabilities.fsRangeReads,false);
  for(const api of [win.naklios.fs,win.naklios.sys.fs])await assert.rejects(api.readBinary('owned.bin',{offset:16,maxBytes:8}),/ENOTSUP/);
  assert.equal(messages.length,0);
});
await test('Missing or malformed range caps reject as promises before old-host RPC',async()=>{
  for(const api of [win.naklios.fs,win.naklios.sys.fs]){
    let promise;assert.doesNotThrow(()=>{promise=api.readBinary('owned.bin',{offset:16})});
    await assert.rejects(promise,/EINVAL/);
    await assert.rejects(api.readBinary('owned.bin',{offset:16,maxBytes:-1}),/EINVAL/);
    await assert.rejects(api.readBinary('owned.bin',{offset:16,maxBytes:16777217}),/EFBIG/);
  }
  assert.equal(messages.length,0);
});
await test('Non-boolean range advertisement fails closed',async()=>{
  for(const value of [false,0,1,'true',null]){announce({fsRangeReads:value});assert.equal(win.naklios.capabilities.fsRangeReads,false);await assert.rejects(win.naklios.fs.readBinary('owned.bin',{offset:16,maxBytes:8}),/ENOTSUP/)}
  assert.equal(messages.length,0);
});
await test('Legacy whole-file reads still reach a mixed-version host',async()=>{
  assert.equal((await win.naklios.fs.readBinary('owned.bin',{maxBytes:8})).length,8);
  assert.equal((await win.naklios.sys.fs.readBinary('owned.bin')).length,8);assert.equal(messages.length,2);
});
await test('Explicit range advertisement enables actual app and system SDK RPC',async()=>{
  oldHost=false;announce({fsRangeReads:true});
  for(const [api,type] of [[win.naklios.fs,'naklios:fs:readBinary'],[win.naklios.sys.fs,'naklios:sysfs:readBinary']]){
    assert.deepEqual(Array.from(await api.readBinary('owned.bin',{offset:16,maxBytes:8})),[16,17,18,19,20,21,22,23]);
    assert.deepEqual(messages.at(-1),{type,path:'owned.bin',offset:16,maxBytes:8,backend:'fsa',origin:'http://host.test'});
  }
});
await test('Backend update clears range advertisement rather than retaining a stale grant',async()=>{
  const count=messages.length;announce({fsBackend:'crate',fsBoundedReads:false});
  assert.equal(win.naklios.capabilities.fsRangeReads,false);
  await assert.rejects(win.naklios.fs.readBinary('owned.bin',{offset:16,maxBytes:8}),/ENOTSUP/);assert.equal(messages.length,count);
});
console.log(JSON.stringify({backend:'production SDK and host functions in native Node VM; native Blob slices and full SDK message transport fixture',providerCalls:0,passed:rows.length,rows}));
