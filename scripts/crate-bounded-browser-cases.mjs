// SPDX-License-Identifier: MIT
import {Crate} from '../vendor/crate/813d079a2db2b810d231f04146626af20e053b42/crate.js';
import * as c from '../vendor/crate/813d079a2db2b810d231f04146626af20e053b42/crypto.js';
const assert=(value,message)=>{if(!value)throw new Error(message)};
export async function run(){
 const rows=[],nativeFetch=globalThis.fetch;
 for(const size of [0,1,4097])for(const v1 of [false,true]){
  const bytes=Uint8Array.from({length:size},(_,i)=>i%251),masterKey=c.randomBytes(32),key=c.randomDataKey(),uuid=c.newULID(),wrapped=await c.wrapDataKey(masterKey,key,uuid);
  let sealed;
  if(v1){const {iv,ciphertext:ct}=await c.encrypt(key,bytes,new TextEncoder().encode(uuid)),body=new Uint8Array(12+ct.length);body.set(iv);body.set(ct,12);sealed={body,contentIv:iv};}
  else sealed=await c.sealObject(key,bytes,uuid,1024);
  await nativeFetch('/fixture',{method:'POST',body:sealed.body});
  const entry={uuid,size,data_key_iv:c.toBase64(wrapped.iv),data_key_ct:c.toBase64(wrapped.ciphertext),content_iv:c.toBase64(sealed.contentIv),chunk_size:sealed.chunkSize};
  const crate=new Crate({bucketBase:location.origin+'/',region:'auto',accessKey:'TEST_ONLY',secretKey:'TEST_ONLY',masterKey,manifest:{materialise:()=>new Map([['file',entry]])},salt:new Uint8Array(16)});
  let requests=0,fullReads=0;
  globalThis.fetch=async(...args)=>{requests++;const response=await nativeFetch(...args);response.arrayBuffer=()=>{fullReads++;throw new Error('whole-response allocation')};return response};
  try{
   const got=await crate.read('file',{maxBytes:size});assert(got.length===size&&got.every((v,i)=>v===bytes[i]),'authenticated bytes differ');assert(fullReads===0,'whole-response allocation');assert(requests===1,'GET count');
   entry.size=size+1;let code;try{await crate.read('file',{maxBytes:size})}catch(e){code=e.code}assert(code==='EFBIG'&&requests===1,'oversized metadata must refuse before GET');
   rows.push({size,format:v1?'v1':'v2',pass:true,requests,fullReads});
  }finally{globalThis.fetch=nativeFetch;crate.close();c.zero(key)}
 }
 return {passed:rows.length,rows};
}
