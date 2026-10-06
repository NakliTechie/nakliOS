// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from 'node:assert/strict';
import test from 'node:test';
import {Crate} from '../vendor/crate/813d079a2db2b810d231f04146626af20e053b42/crate.js';
import {signedGet} from '../vendor/crate/813d079a2db2b810d231f04146626af20e053b42/bucket.js';
import {boundedCiphertextSize,readResponseBounded} from '../vendor/crate/813d079a2db2b810d231f04146626af20e053b42/read-bound.js';
import * as c from '../vendor/crate/813d079a2db2b810d231f04146626af20e053b42/crypto.js';

function byteResponse(body,{headers={},status=200,chunkBytes=65536,counters={}}={}){
 let offset=0;
 const stream=new ReadableStream({type:'bytes',pull(controller){
  const request=controller.byobRequest;
  if(offset===body.length){controller.close();request?.respond(0);return;}
  const n=Math.min(request.view.byteLength,chunkBytes,body.length-offset);
  request.view.set(body.subarray(offset,offset+n));offset+=n;
  counters.delivered=(counters.delivered||0)+n;counters.maxRequest=Math.max(counters.maxRequest||0,request.view.byteLength);
  request.respond(n);
 },cancel(){counters.cancelled=true;}});
 const response=new Response(stream,{status,headers});
 response.arrayBuffer=async()=>{counters.arrayBufferCalls=(counters.arrayBufferCalls||0)+1;throw new Error('whole-response allocation is forbidden');};
 return response;
}
async function fixture(bytes,{v1=false,compression}={}){
 const masterKey=c.randomBytes(32),dataKey=c.randomDataKey(),uuid=c.newULID(),wrapped=await c.wrapDataKey(masterKey,dataKey,uuid);
 let sealed;
 if(v1){const {iv,ciphertext:ct}=await c.encrypt(dataKey,bytes,new TextEncoder().encode(uuid));const body=new Uint8Array(12+ct.length);body.set(iv);body.set(ct,12);sealed={body,contentIv:iv};}
 else sealed=await c.sealObject(dataKey,bytes,uuid,1024);
 const entry={uuid,size:bytes.length,data_key_iv:c.toBase64(wrapped.iv),data_key_ct:c.toBase64(wrapped.ciphertext),content_iv:c.toBase64(sealed.contentIv),chunk_size:sealed.chunkSize,compression};
 const crate=new Crate({bucketBase:'https://storage.invalid/',region:'auto',accessKey:'TEST_ONLY',secretKey:'TEST_ONLY',masterKey,manifest:{materialise:()=>new Map([['file',entry]])},salt:new Uint8Array(16)});
 return {crate,entry,body:sealed.body};
}

test('bounded Crate v1/v2 reads authenticate binary bytes without whole-response allocation',async()=>{
 for(const v1 of [true,false])for(const size of [0,1,4097]){
  const bytes=Uint8Array.from({length:size},(_,i)=>(i*31)&255),{crate,body}=await fixture(bytes,{v1});const counters={};let requests=0;
  const old=globalThis.fetch;globalThis.fetch=async()=>{requests++;return byteResponse(body,{counters});};
  try{assert.deepEqual(await crate.read('file',{maxBytes:size}),bytes);assert.equal(crate.supportsBoundedReads,true);assert.equal(requests,1);assert.equal(counters.arrayBufferCalls,undefined);assert.ok(counters.maxRequest<=65536);}
  finally{globalThis.fetch=old;crate.close();}
 }
});
test('oversized metadata, compressed objects, invalid limits, and hostile chunk counts refuse before GET',async()=>{
 const {crate,entry}=await fixture(new Uint8Array(10));let requests=0;const old=globalThis.fetch;globalThis.fetch=async()=>{requests++;throw new Error('unexpected GET');};
 try{
  await assert.rejects(crate.read('file',{maxBytes:9}),{code:'EFBIG'});
  for(const maxBytes of [-1,1.5,Infinity,2**30])await assert.rejects(crate.read('file',{maxBytes}),{code:'EINVAL'});
  entry.compression='deflate-raw';await assert.rejects(crate.read('file',{maxBytes:10}),{code:'ENOTSUP'});delete entry.compression;
  entry.size=65537;entry.chunk_size=1;await assert.rejects(crate.read('file',{maxBytes:65537}),{code:'ENOTSUP'});
  assert.equal(requests,0);
 }finally{globalThis.fetch=old;crate.close();}
});
test('bounded GET rejects excess length and streams, refuses non-BYOB, and bounds error responses',async()=>{
 const original=globalThis.fetch;const args={url:'https://storage.invalid/object',region:'auto',accessKey:'TEST_ONLY',secretKey:'TEST_ONLY',maxBytes:10};
 try{
  let counters={};globalThis.fetch=async()=>byteResponse(new Uint8Array(11),{headers:{'content-length':'11'},counters});
  await assert.rejects(signedGet(args),{code:'EFBIG'});assert.equal(counters.delivered,undefined);assert.equal(counters.cancelled,true);
  counters={};globalThis.fetch=async()=>byteResponse(new Uint8Array(1000000),{chunkBytes:3,counters});
  await assert.rejects(signedGet(args),{code:'EFBIG'});assert.equal(counters.delivered,11);assert.equal(counters.cancelled,true);assert.equal(counters.arrayBufferCalls,undefined);
  globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(10));controller.close();}}));
  await assert.rejects(signedGet(args),{code:'ENOTSUP'});
  counters={};globalThis.fetch=async()=>byteResponse(new Uint8Array(1000000),{status:403,counters});
  assert.equal((await signedGet(args)).code,'HTTP_403');assert.equal(counters.delivered,undefined);assert.equal(counters.cancelled,true);
  globalThis.fetch=async()=>{throw new Error('must validate before fetch');};await assert.rejects(signedGet({...args,maxBytes:-1}),{code:'EINVAL'});
 }finally{globalThis.fetch=original;}
});
test('bounded decryption retains rollback and chunk authentication checks',async()=>{
 const {crate,body,entry}=await fixture(new Uint8Array(4097));const old=globalThis.fetch;
 try{
  const changed=body.slice();changed[changed.length-1]^=1;globalThis.fetch=async()=>byteResponse(changed);
  await assert.rejects(crate.read('file',{maxBytes:4097}),/failed authentication/);
  entry.content_iv=c.toBase64(c.randomIV());globalThis.fetch=async()=>byteResponse(body);
  await assert.rejects(crate.read('file',{maxBytes:4097}),/rollback or tamper/);
 }finally{globalThis.fetch=old;crate.close();}
});
test('unbounded legacy read and compressed metadata keep their existing behavior',async()=>{
 const bytes=new TextEncoder().encode('legacy'),{crate,body}=await fixture(bytes);let fullReads=0;const old=globalThis.fetch;
 globalThis.fetch=async()=>{const response=new Response(body);const read=response.arrayBuffer.bind(response);response.arrayBuffer=()=>{fullReads++;return read();};return response;};
 try{assert.deepEqual(await crate.read('file'),bytes);assert.equal(fullReads,1);assert.equal(boundedCiphertextSize({size:0},0),28);}
 finally{globalThis.fetch=old;crate.close();}
});

// Also verify every delivered SDK blob against its immutable provenance record.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {CrateBackend,stringHostAdapter} from '../sys/rig/fileops/crate-backend.mjs';
test('immutable vendor closure retains exact hashes, license, and host pin',async()=>{
 const base=new URL('../vendor/crate/813d079a2db2b810d231f04146626af20e053b42/',import.meta.url);
 const manifest=JSON.parse(await readFile(new URL('source-manifest.json',base),'utf8'));
 assert.equal(manifest.commit,'813d079a2db2b810d231f04146626af20e053b42');assert.equal(manifest.license,'AGPL-3.0-or-later');
 for(const [name,hash] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(await readFile(new URL(name,base))).digest('hex'),hash,name);
 assert.match(await readFile(new URL('../index.html',import.meta.url),'utf8'),/CRATE_VENDOR_BASE = ['"]\.\/vendor\/crate\/813d079a2db2b810d231f04146626af20e053b42['"]/);
});
test('string host adapter preserves byte limits and refuses legacy fallback before reads',async()=>{
 let reads=0,seen;const host={supportsBoundedReads:true,stat:async()=>({type:'file',size:2}),read:async()=>{reads++;return 'unbounded'},readBinary:async(path,options)=>{seen={path,options};return Uint8Array.of(0,255)},write:async()=>{},delete:async()=>{},exists:async()=>true,list:async()=>[]};
 const adapter=stringHostAdapter(host),backend=new CrateBackend(adapter);
 assert.deepEqual(await backend.readBinary('file',{maxBytes:2}),Uint8Array.of(0,255));assert.deepEqual(seen,{path:'file',options:{maxBytes:2}});assert.equal(reads,0);
 host.supportsBoundedReads=false;assert.equal(backend.supportsBoundedReads,false);
 await assert.rejects(backend.readBinary('file',{maxBytes:2}),{code:'ENOTSUP'});
 const legacy=stringHostAdapter({...host,readBinary:undefined});await assert.rejects(legacy.readBinary('file',{maxBytes:2}),{code:'ENOTSUP'});assert.equal(reads,0);
});
