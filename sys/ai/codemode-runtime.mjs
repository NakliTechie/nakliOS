import {codemodeJson as boundedJson} from './codemode-json.mjs';
import {utf8ByteLengthWithin,utf8Prefix} from './text-byte-bound.mjs';
export const CODEMODE_LIMITS=Object.freeze({codeBytes:32768,argumentBytes:32768,resultBytes:256*1024,totalResultBytes:1024*1024,outputBytes:65536,storeBytes:65536,storeValueBytes:16384,keys:32,calls:32,pending:4,deadlineMs:10000});
export function validateCodemodeStore(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.getPrototypeOf(input)!==Object.prototype&&Object.getPrototypeOf(input)!==null)throw Error('Store must be a JSON object');
 boundedJson(input,65536);const keys=Object.keys(input);if(keys.length>32)throw Error('Store key limit');
 const out=Object.create(null);
 for(const key of keys){if(!key||key.length>100||['__proto__','prototype','constructor'].includes(key))throw Error('Store key invalid');out[key]=JSON.parse(boundedJson(input[key],16384));}
 boundedJson(out,65536);return out;
}
// execute must be the owning application's ordinary authority-checked executor.
// The callback owns durable call evidence, including settlements after cancellation.
export async function runCodemode({code,tools,store={},signal,execute,onCall=async()=>{},onSettled=async()=>{},deadlineMs=10000,workerFactory=url=>new Worker(url,{type:'module'})}={}){
 if(utf8ByteLengthWithin(code,32768)===null)throw Error('Script exceeds32KiB UTF-8');
 if(!Array.isArray(tools)||tools.length>100||tools.some(name=>typeof name!=='string'||!name||name.length>100)||typeof execute!=='function')throw Error('Invalid codemode tool bridge');
 const names=[...new Set(tools)].filter(name=>name!=='codemode'),initial=validateCodemodeStore(store);
 if(signal?.aborted)return {ok:false,error:'Script aborted',output:'',pending:[],store:null};
 if(!Number.isFinite(deadlineMs)||deadlineMs<=0)throw Error('Invalid script deadline');
 const timeout=Math.min(10000,deadlineMs),worker=workerFactory(new URL('./codemode-worker.mjs',import.meta.url));
 const calls=new Map(),pending=new Map();let completed=false,output='',resultBytes=0,timer,finish;
 const result=new Promise(resolve=>finish=resolve);
 const stop=(value)=>{
  if(completed)return;completed=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
  worker.terminate();for(const call of pending.values())call.controller.abort();
  finish({...value,output:output+(value.output||''),pending:[...pending.keys()],store:value.ok?value.store:null});
 };
 const abort=()=>stop({ok:false,error:'Script aborted'});
 signal?.addEventListener('abort',abort,{once:true});
 timer=setTimeout(()=>stop({ok:false,error:'Script deadline exceeded'}),timeout);
 worker.onerror=event=>{event.preventDefault?.();stop({ok:false,error:utf8Prefix(String(event.message||'Worker failed'),2000)})};
 worker.onmessage=async event=>{
  const msg=event.data;
  try{
   if(completed)return;
   if(msg?.type==='text'){
    if(utf8ByteLengthWithin(msg.text,65536)===null||utf8ByteLengthWithin(output+msg.text,65536)===null)throw Error('Output byte limit');output+=msg.text;return;
   }
   if(msg?.type==='done'){
    if(typeof msg.ok!=='boolean')throw Error('Malformed script completion');
    if(!msg.ok){stop({ok:false,error:utf8Prefix(String(msg.error||'Script failed'),2000)});return;}
    if(utf8ByteLengthWithin(msg.output,65536)===null||utf8ByteLengthWithin(output+msg.output,65536)===null||utf8ByteLengthWithin(msg.store,65536)===null)throw Error('Completion byte limit');
    stop({ok:true,output:msg.output,store:validateCodemodeStore(JSON.parse(msg.store))});return;
   }
   if(msg?.type!=='call'||!Number.isSafeInteger(msg.id)||msg.id<1||calls.has(msg.id)||calls.size>=32||pending.size>=4||!names.includes(msg.name)||utf8ByteLengthWithin(msg.args,32768)===null)throw Error('Invalid or excessive nested call');
   const args=JSON.parse(msg.args),controller=new AbortController(),call={id:msg.id,name:msg.name,args,controller};
   calls.set(msg.id,call);pending.set(msg.id,call);
   await onCall({id:msg.id,name:msg.name,args});
   if(completed||controller.signal.aborted)throw Error('Nested call cancelled before execution');
   let value,error;
   try{value=await execute(msg.name,args,{id:msg.id,signal:controller.signal});}catch(e){error=utf8Prefix(String(e?.message||e),2000);}
   // Preserve full bounded results in the owning recorder, never only filtered guest output.
   let body;
   try{body=error||boundedJson(value===undefined?null:value,256*1024);const bytes=utf8ByteLengthWithin(body,256*1024);if(bytes===null||resultBytes+bytes>1024*1024)throw Error('Nested result byte limit');resultBytes+=bytes;}
   catch(e){error=utf8Prefix(String(e?.message||e),2000);body=error;value=null;}
   await onSettled({id:msg.id,name:msg.name,args,result:value??null,error:error||null,cancelled:controller.signal.aborted,late:completed});
   pending.delete(msg.id);
   if(!completed)worker.postMessage({type:'settle',id:msg.id,ok:!error,body});
  }catch(error){
   // A call that cannot be returned remains explicit uncertainty; it is never erased.
   stop({ok:false,error:utf8Prefix(String(error?.message||error),2000)});
  }
 };
 try{worker.postMessage({type:'start',code,tools:names,store:boundedJson(initial,65536),deadline:Date.now()+timeout});}catch(error){stop({ok:false,error:utf8Prefix(String(error),2000)})}
 return await result;
}
