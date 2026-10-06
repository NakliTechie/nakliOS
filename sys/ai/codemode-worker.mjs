// One disposable Worker contains one finite-heap guest VM. No application SDK enters it.
import {QuickJS,MAX_STACK_SIZE} from '../../vendor/quickjs-wasi/v3.6.2/dist/index.js';
import {utf8ByteLengthWithin,utf8Prefix} from './text-byte-bound.mjs';
let vm,api,promiseIdentity,completion=null,finished=false;
const unhandled=new Map();
const fail=error=>{if(finished)return;finished=true;postMessage({type:'done',ok:false,error:utf8Prefix(typeof error==='string'?error:String(error?.name||'Error')+': '+String(error?.message||error)+'\n'+String(error?.stack||''),2000)});};
const prelude=`(function(bridge,names,initial){
 'use strict';
 const parse=JSON.parse,encode=JSON.stringify,own=Object.prototype.hasOwnProperty;
 const pending=new Map(),values=Object.assign(Object.create(null),parse(initial));let seq=0,settled=false;
 function bounded(text,limit){if(typeof text!=='string'||text.length>limit)throw Error('Text byte limit');let n=0;for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c<128)n++;else if(c<2048)n+=2;else if(c>=55296&&c<=56319&&text.charCodeAt(i+1)>=56320&&text.charCodeAt(i+1)<=57343){n+=4;i++}else n+=3;if(n>limit)throw Error('Text byte limit')}return text;}
 const tools=Object.create(null);
 for(const name of parse(names))tools[name]=args=>{if(settled)throw Error('Script already settled');if(++seq>32||pending.size>=4)throw Error('Nested call limit');const body=bounded(encode(args===undefined?{}:args),32768);return new Promise((resolve,reject)=>{pending.set(seq,{resolve,reject});bridge('call',seq,name,body);});};
 Object.freeze(tools);
 const text=value=>bridge('text',0,'',bounded(typeof value==='string'?value:encode(value),65536));
 const store=(key,value)=>{if(typeof key!=='string'||!key||key.length>100||['__proto__','constructor','prototype'].includes(key))throw Error('Store key invalid');const json=bounded(encode(value),16384);const copy=Object.assign(Object.create(null),values);copy[key]=parse(json);if(Object.keys(copy).length>32)throw Error('Store key limit');bounded(encode(copy),65536);values[key]=parse(json);};
 const load=key=>own.call(values,key)?parse(encode(values[key])):undefined;
 return {run(fn){Promise.resolve().then(()=>fn(tools,text,store,load)).then(value=>{const output=value===undefined?'':bounded(typeof value==='string'?value:encode(value),65536);settled=true;bridge('done',0,output,bounded(encode(values),65536));},error=>{settled=true;bridge('error',0,'',bounded((String(error.name||'Error')+': '+String(error.message||error)+'\\n'+String(error.stack||'')).slice(0,2000),6000));});},
 settle(id,ok,body){const p=pending.get(id);if(!p)return;pending.delete(id);if(ok)p.resolve(parse(body));else p.reject(Error(body));},
 stalled(){if(!settled&&pending.size===0)throw Error('Unsettled promise has no pending tool call');}};
})`;
function drain(){
 vm.executePendingJobs();if(finished)return;
 if(unhandled.size){fail('Unhandled promise rejection: '+unhandled.values().next().value);return;}
 if(completion){finished=true;postMessage(completion);return;}
 vm.withScope(()=>vm.callFunction(api.getProp('stalled'),api).dispose());
}
self.onmessage=async event=>{
 try{
  const msg=event.data;
  if(msg.type==='start'){
   if(vm)throw Error('Worker already initialized');
   const response=await fetch(new URL('../../vendor/quickjs-wasi/v3.6.2/quickjs.wasm',import.meta.url));if(!response.ok)throw Error('Pinned runtime unavailable');
   const expectedSize=637242;
   const declared=response.headers.get('content-length');if(declared!==null&&Number(declared)>1024*1024){await response.body.cancel();throw Error('Runtime asset bound');}
   const reader=response.body.getReader(),chunks=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;if(size+part.value.byteLength>1024*1024)throw Error('Runtime asset bound');size+=part.value.byteLength;chunks.push(part.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const bytes=new Uint8Array(size);let position=0;for(const chunk of chunks){bytes.set(chunk,position);position+=chunk.byteLength;}
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
   if(hash!=='d4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9')throw Error('Pinned runtime integrity mismatch');
   vm=await QuickJS.create({wasm:bytes,memoryLimit:32*1024*1024,maxStackSize:Math.min(MAX_STACK_SIZE,512*1024),interruptHandler:()=>Date.now()>=msg.deadline,
    onUnhandledRejection(promise,reason,handled){
     if(!promiseIdentity)return;
     const id=vm.withScope(()=>vm.callFunction(promiseIdentity,vm.undefined,promise).toNumber());
     if(handled)unhandled.delete(id);
     else if(unhandled.size>=64)fail('Unhandled promise rejection limit');
     else unhandled.set(id,utf8Prefix(reason.toString(),2000));
    },
    wasi:memory=>({fd_write(_fd,ptr,count,written){if(count>1024)throw Error('Diagnostic vector bound');const view=new DataView(memory.buffer);let bytes=0;for(let i=0;i<count;i++)bytes+=view.getUint32(ptr+i*8+4,true);view.setUint32(written,bytes,true);return 0}})});
   promiseIdentity=vm.evalCode('(function(){const ids=new WeakMap(),has=ids.has.bind(ids),set=ids.set.bind(ids),get=ids.get.bind(ids);let next=0;return p=>{if(!has(p))set(p,++next);return get(p)}})()','promise-identity.js');
   const bridge=vm.newFunction('codemode_bridge',(kind,id,name,body)=>{
    const type=kind.toString(),a=name.toString(),b=body.toString();
    if(type==='call'){if(utf8ByteLengthWithin(a,100)===null||utf8ByteLengthWithin(b,32768)===null)throw Error('Bridge argument bound');postMessage({type:'call',id:id.toNumber(),name:a,args:b});}
    else if(type==='text'){if(utf8ByteLengthWithin(b,65536)===null)throw Error('Output bound');postMessage({type:'text',text:b});}
    else if(type==='done'){if(utf8ByteLengthWithin(a,65536)===null||utf8ByteLengthWithin(b,65536)===null)throw Error('Completion bound');completion={type:'done',ok:true,output:a,store:b};}
    else if(type==='error')fail(b);else throw Error('Unknown bridge operation');
    return vm.undefined;
   });
   api=vm.withScope(scope=>scope.escape(vm.callFunction(vm.evalCode(prelude,'codemode-prelude.js'),vm.undefined,bridge,vm.newString(JSON.stringify(msg.tools)),vm.newString(msg.store))));
   vm.withScope(()=>{const fn=vm.evalCode('(async (tools,text,store,load)=>{'+msg.code+'\n})','codemode.js');vm.callFunction(api.getProp('run'),api,fn).dispose();});drain();
  }else if(msg.type==='settle'&&vm&&!finished){
   if(typeof msg.body!=='string'||utf8ByteLengthWithin(msg.body,256*1024)===null)throw Error('Tool response bound');
   vm.withScope(()=>vm.callFunction(api.getProp('settle'),api,vm.newNumber(msg.id),msg.ok?vm.true:vm.false,vm.newString(msg.body)).dispose());drain();
  }
 }catch(error){fail(error)}
};
