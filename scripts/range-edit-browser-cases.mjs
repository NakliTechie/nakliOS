import { compareRangeEditIdb } from '../sys/ai/range-edit.mjs';

// Real browser IndexedDB, two native connections, and production conditional writes.
export async function runNativeRangeEditCases() {
  const rows=[],name='range-edit-native-'+crypto.randomUUID(),key='owned';
  const check=(label,ok)=>{if(!ok)throw new Error(label);rows.push({label,pass:true})};
  const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const a=await open(),b=await open();
  const put=(db,value)=>new Promise((resolve,reject)=>{const t=db.transaction('files','readwrite');t.objectStore('files').put(value,key);t.oncomplete=resolve;t.onabort=()=>reject(t.error)});
  const get=db=>new Promise((resolve,reject)=>{const r=db.transaction('files').objectStore('files').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const rejects=p=>p.then(()=>false,()=>true);
  try {
    await put(a,'\ufeffbefore');await compareRangeEditIdb(a,'files',key,'\ufeffbefore','\ufeffafter');
    check('Apply preserves UTF-8 BOM text',await get(a)==='\ufeffafter');
    await compareRangeEditIdb(b,'files',key,'\ufeffafter','\ufeffbefore');
    check('Revert preserves original BOM text',await get(a)==='\ufeffbefore');
    await put(a,'before');
    const competing=await Promise.allSettled([compareRangeEditIdb(a,'files',key,'before','A'),compareRangeEditIdb(b,'files',key,'before','B')]);
    check('Concurrent native writers have exactly one winner',competing.filter(r=>r.status==='fulfilled').length===1&&competing.filter(r=>r.status==='rejected'&&r.reason.code==='ESTALE').length===1);
    await put(a,'before');const external=put(b,'external'),stale=rejects(compareRangeEditIdb(a,'files',key,'before','proposal'));await external;
    check('An earlier external writer prevents stale apply',await stale&&await get(a)==='external');
    check('Changed proposal bytes prevent revert',await rejects(compareRangeEditIdb(a,'files',key,'proposal','before'))&&await get(a)==='external');
    const originalPut=IDBObjectStore.prototype.put;let puts=0;
    IDBObjectStore.prototype.put=function(...args){puts++;return originalPut.apply(this,args)};
    try {
      check('Missing source refuses without a put',await rejects(compareRangeEditIdb(a,'files','missing','before','after'))&&puts===0);
      check('Stale text refuses without a put',await rejects(compareRangeEditIdb(a,'files',key,'before','after'))&&puts===0);
    } finally { IDBObjectStore.prototype.put=originalPut; }
    await put(a,{text:'before'});
    check('Non-string source refuses without replacement',await rejects(compareRangeEditIdb(a,'files',key,'before','after'))&&(await get(a)).text==='before');
    await put(a,'before');
    check('Revoked identity refuses mutation',await rejects(compareRangeEditIdb(a,'files',key,'before','after',{valid:()=>false}))&&await get(a)==='before');
    check('Throwing identity guard aborts mutation',await rejects(compareRangeEditIdb(a,'files',key,'before','after',{valid:()=>{throw new Error('owned fixture')}}))&&await get(a)==='before');
    const controller=new AbortController(),pending=compareRangeEditIdb(a,'files',key,'before','after',{signal:controller.signal});controller.abort();
    check('AbortSignal cancels an outstanding native transaction',await rejects(pending)&&await get(a)==='before');
    const afterPut=new AbortController();
    IDBObjectStore.prototype.put=function(...args){const result=originalPut.apply(this,args);afterPut.abort();return result};
    try {check('Aborting after put rolls back pending replacement',await rejects(compareRangeEditIdb(a,'files',key,'before','after',{signal:afterPut.signal}))&&await get(a)==='before');}
    finally { IDBObjectStore.prototype.put=originalPut; }
    return {passed:rows.length,rows};
  } finally {a.close();b.close();await new Promise(resolve=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=r.onerror=r.onblocked=resolve})}
}
