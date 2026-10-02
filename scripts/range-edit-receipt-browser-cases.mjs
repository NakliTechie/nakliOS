import {rangeEditRequest,rangeEditProposal,rangeEditRecord,retainRangeEditIdb,cancelRangeEditIdb,restoreRangeEditRecord,discardRangeEditIdb,compareRangeEditIdb,openRangeEditDatabase} from '../sys/ai/range-edit.mjs';
export async function runRangeEditReceiptCases(){
  const name='range-edit-receipt-'+crypto.randomUUID(),path='owned.js',rows=[];
  let db=await openRangeEditDatabase(name,'files',{version:2,journal:true});
  const check=(label,ok)=>{if(!ok)throw new Error(label);rows.push({label,pass:true})};
  const action=(store,mode,fn)=>new Promise((resolve,reject)=>{const t=db.transaction(store,mode),r=fn(t.objectStore(store));t.oncomplete=()=>resolve(r?.result);t.onabort=t.onerror=()=>reject(t.error)});
  const get=store=>action(store,'readonly',s=>s.get(path));
  const rejects=p=>p.then(()=>false,()=>true);
  const req=rangeEditRequest({path,project:'editor:browser',backend:'browser',before:'before\n',instruction:'Change to after',selection:{start:1,end:1}});
  const stage={proposal:rangeEditProposal(req,'after\n'),state:'staged',run:{task:'owned-task',project:'owned-project',sequence:1}},record=rangeEditRecord(stage,'owned-delivery');
  const retain=options=>retainRangeEditIdb(db,'range-edits',path,record,{filesStore:'files',...options});
  try{
    await action('files','readwrite',s=>s.put('external\n',path));
    check('Receipt rejects Browser source changed after handoff',await rejects(retain())&&await get('range-edits')===undefined&&await get('files')==='external\n');
    await action('files','readwrite',s=>s.put(req.before,path));
    const canceled=new AbortController();canceled.abort();
    check('Cancelled receipt stores no durable proposal',await rejects(retain({signal:canceled.signal}))&&await get('range-edits')===undefined);
    const original=IDBObjectStore.prototype.put,afterPut=new AbortController();
    IDBObjectStore.prototype.put=function(...args){const result=original.apply(this,args);if(this.name==='range-edits')afterPut.abort();return result};
    try{check('Cancel after journal put rolls back receipt',await rejects(retain({signal:afterPut.signal}))&&await get('range-edits')===undefined&&await get('files')===req.before)}
    finally{IDBObjectStore.prototype.put=original}
    await retain();
    await compareRangeEditIdb(db,'files',path,req.before,stage.proposal.after,{journal:{store:'range-edits',value:{...record,state:'applied'}}});
    check('Stale tab cannot discard another tab applied journal',await rejects(discardRangeEditIdb(db,'range-edits',path,record.id,'staged'))&&(await get('range-edits')).state==='applied'&&await get('files')===stage.proposal.after);
    await compareRangeEditIdb(db,'files',path,stage.proposal.after,req.before,{journal:{store:'range-edits',value:{...record,state:'reverted'}}});
    check('Stale tab cannot discard a changed lifecycle state',await rejects(discardRangeEditIdb(db,'range-edits',path,record.id,'staged'))&&(await get('range-edits')).state==='reverted');
    await discardRangeEditIdb(db,'range-edits',path,record.id,'reverted');
    check('Current reverted proposal discard preserves source',await get('range-edits')===undefined&&await get('files')===req.before);
    const blockedName=name+'-blocked';
    const old=await new Promise((resolve,reject)=>{const r=indexedDB.open(blockedName,1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    let blocked=false;
    try{await openRangeEditDatabase(blockedName,'files',{version:2,journal:true})}catch(e){blocked=e.code==='ELOCKED'}
    old.close();
    const retry=await openRangeEditDatabase(blockedName,'files',{version:2,journal:true});
    check('Blocked upgrade rejects and permits bounded retry',blocked&&retry.objectStoreNames.contains('range-edits'));retry.close();
    await new Promise(resolve=>{const r=indexedDB.deleteDatabase(blockedName);r.onsuccess=r.onerror=r.onblocked=resolve});
    return {passed:rows.length,rows};
  }finally{db.close();await new Promise(resolve=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=r.onerror=r.onblocked=resolve})}
}

export async function runStaleAppliedRangeEditCases(){
  const name='range-edit-stale-applied-'+crypto.randomUUID(),path='owned.js',rows=[],db=await openRangeEditDatabase(name,'files',{version:2,journal:true});
  const check=(label,ok)=>{if(!ok)throw new Error(label);rows.push({label,pass:true})};
  const action=(store,mode,fn)=>new Promise((resolve,reject)=>{const t=db.transaction(store,mode),r=fn(t.objectStore(store));t.oncomplete=()=>resolve(r?.result);t.onabort=t.onerror=()=>reject(t.error)});
  const get=store=>action(store,'readonly',s=>s.get(path));
  const request=rangeEditRequest({path,project:'editor:browser',backend:'browser',before:'before\n',instruction:'Change to after',selection:{start:1,end:1}});
  const stage={proposal:rangeEditProposal(request,'after\n'),state:'applied',run:{task:'owned-task',project:'owned-project',sequence:1}},record=rangeEditRecord(stage,'owned-delivery');
  try{
    await action('files','readwrite',s=>s.put(stage.proposal.after,path));await action('range-edits','readwrite',s=>s.put(record,path));
    const options={filesStore:'files',allowStaleApplied:true};
    let refused=false;try{await discardRangeEditIdb(db,'range-edits',path,record.id,'applied',options)}catch(e){refused=e.code==='ESTALE'}
    check('Matching applied bytes still require Revert before discard',refused&&(await get('range-edits')).state==='applied');
    await action('files','readwrite',s=>s.put('external\n',path));
    await discardRangeEditIdb(db,'range-edits',path,record.id,'applied',options);
    check('Explicit stale applied discard preserves external bytes',await get('range-edits')===undefined&&await get('files')==='external\n');
    const fresh=rangeEditRecord({...stage,state:'staged',proposal:rangeEditProposal({...request,before:'external\n',version:undefined},'fresh\n')},'fresh-delivery');
    await retainRangeEditIdb(db,'range-edits',path,fresh,{filesStore:'files'});
    check('Stale applied discard permits a new source-bound proposal',(await get('range-edits')).id==='fresh-delivery'&&await get('files')==='external\n');
    return {passed:rows.length,rows};
  }finally{db.close();await new Promise(resolve=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=r.onerror=r.onblocked=resolve})}
}

export async function runMissingSourceRangeEditCases(){
  const name='range-edit-missing-source-'+crypto.randomUUID(),path='owned.js',db=await openRangeEditDatabase(name,'files',{version:2,journal:true});
  const action=(store,mode,fn)=>new Promise((resolve,reject)=>{const t=db.transaction(store,mode),r=fn(t.objectStore(store));t.oncomplete=()=>resolve(r?.result);t.onabort=t.onerror=()=>reject(t.error)});
  try{
    const request=rangeEditRequest({path,project:'editor:browser',backend:'browser',before:'before\n',instruction:'change',selection:{start:1,end:1}});
    const record=rangeEditRecord({proposal:rangeEditProposal(request,'after\n'),state:'applied',run:{task:'owned-task',project:'owned-project',sequence:1}},'owned-delivery');
    await action('range-edits','readwrite',s=>s.put(record,path));
    await discardRangeEditIdb(db,'range-edits',path,record.id,'applied',{filesStore:'files',allowStaleApplied:true});
    if(await action('files','readonly',s=>s.get(path))!==undefined||await action('range-edits','readonly',s=>s.get(path))!==undefined)throw Error('Missing source cleanup changed source or retained journal');
    return {passed:1,rows:[{label:'Explicit stale applied discard preserves missing source',pass:true}]};
  }finally{db.close();await new Promise(resolve=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=r.onerror=r.onblocked=resolve})}
}

export async function runCancelledReloadRangeEditCases(){
  const name='range-edit-cancelled-reload-'+crypto.randomUUID(),path='owned.js',rows=[],db=await openRangeEditDatabase(name,'files',{version:2,journal:true});
  const action=(store,mode,fn)=>new Promise((resolve,reject)=>{const t=db.transaction(store,mode),r=fn(t.objectStore(store));t.oncomplete=()=>resolve(r?.result);t.onabort=t.onerror=()=>reject(t.error)});
  const get=store=>action(store,'readonly',s=>s.get(path));
  const check=(label,ok)=>{if(!ok)throw Error(label);rows.push({label,pass:true})};
  try{
    const request=rangeEditRequest({path,project:'editor:browser',backend:'browser',before:'before\n',instruction:'change',selection:{start:1,end:1}});
    const record=rangeEditRecord({proposal:rangeEditProposal(request,'after\n'),state:'staged',run:{task:'owned-task',project:'owned-project',sequence:1}},'owned-delivery');
    await action('files','readwrite',s=>s.put(request.before,path));await action('range-edits','readwrite',s=>s.put(record,path));
    let refused=false;try{await cancelRangeEditIdb(db,'range-edits',path,'wrong-delivery')}catch(e){refused=e.code==='ESTALE'}
    check('Cancellation marker refuses a different retained identity',refused&&(await get('range-edits')).state==='staged');
    await cancelRangeEditIdb(db,'range-edits',path,record.id);
    const other=await openRangeEditDatabase(name,'files',{version:2,journal:true});
    try{
      refused=false;try{await compareRangeEditIdb(other,'files',path,request.before,record.after,{journal:{store:'range-edits',value:{...record,state:'applied'}}})}catch(e){refused=e.code==='ESTALE'}
      check('Another tab cannot apply a durably cancelled same-identity proposal',refused&&(await get('range-edits')).state==='cleanup'&&await get('files')===request.before);
    }finally{other.close()}
    const original=IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete=function(...args){if(this.name==='range-edits')throw Error('owned deletion failure');return original.apply(this,args)};
    let failed=false;try{await discardRangeEditIdb(db,'range-edits',path,record.id,'cleanup')}catch{failed=true}finally{IDBObjectStore.prototype.delete=original}
    const restored=restoreRangeEditRecord(await get('range-edits'),path,await get('files'));
    check('Failed cancellation deletion restores cleanup without staged authority',failed&&restored.state==='cleanup'&&await get('files')===request.before);
    await discardRangeEditIdb(db,'range-edits',path,record.id,'cleanup');
    check('Cancellation cleanup retry removes only its matching journal',await get('range-edits')===undefined&&await get('files')===request.before);
    await action('range-edits','readwrite',s=>s.put({...record,state:'applied'},path));
    refused=false;try{await cancelRangeEditIdb(db,'range-edits',path,record.id)}catch(e){refused=e.code==='ESTALE'}
    check('Cancellation marker cannot erase another tab applied undo state',refused&&(await get('range-edits')).state==='applied');
    return {passed:rows.length,rows};
  }finally{db.close();await new Promise(resolve=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=r.onerror=r.onblocked=resolve})}
}
