import { rangeEditRequest,rangeEditProposal,rangeEditRecord,restoreRangeEditRecord,retainRangeEditIdb,compareRangeEditIdb } from '../sys/ai/range-edit.mjs';

export async function runRangeEditLifecycleCases(){
  const name='range-edit-lifecycle-'+crypto.randomUUID(),rows=[],path='owned.js';
  const check=(label,ok)=>{if(!ok)throw new Error(label);rows.push({label,pass:true})};
  const open=()=>new Promise((resolve,reject)=>{const r=indexedDB.open(name,2);r.onupgradeneeded=()=>{r.result.createObjectStore('files');r.result.createObjectStore('range-edits')};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  let db=await open();
  const action=(store,mode,fn)=>new Promise((resolve,reject)=>{const t=db.transaction(store,mode),r=fn(t.objectStore(store));t.oncomplete=()=>resolve(r?.result);t.onabort=t.onerror=()=>reject(t.error)});
  const get=store=>action(store,'readonly',s=>s.get(path));
  const rejects=p=>p.then(()=>false,()=>true);
  const request=rangeEditRequest({path,project:'editor:browser',backend:'browser',before:'before\n',instruction:'Change before to after',selection:{start:1,end:1}});
  const stage={proposal:rangeEditProposal(request,'after\n'),run:{task:'owned-task',project:'owned-project',sequence:1},state:'staged',id:'owned-delivery'};
  const record=rangeEditRecord(stage,stage.id);
  const commit=state=>compareRangeEditIdb(db,'files',path,state==='applied'?'before\n':'after\n',state==='applied'?'after\n':'before\n',
    {journal:{store:'range-edits',value:rangeEditRecord({...stage,state},stage.id)}});
  try{
    await action('files','readwrite',s=>s.put(request.before,path));await retainRangeEditIdb(db,'range-edits',path,record);
    db.close();db=await open();
    check('Staged proposal survives native database reopen',restoreRangeEditRecord(await get('range-edits'),path,await get('files')).state==='staged');
    await commit('applied');db.close();db=await open();
    check('Applied source and revert state survive restart together',restoreRangeEditRecord(await get('range-edits'),path,await get('files')).state==='applied');
    await retainRangeEditIdb(db,'range-edits',path,record);
    check('Delayed delivery cannot downgrade applied state',(await get('range-edits')).state==='applied'&&await get('files')==='after\n');
    await commit('reverted');db.close();db=await open();
    check('Guarded revert and its journal survive restart',restoreRangeEditRecord(await get('range-edits'),path,await get('files')).state==='reverted'&&await get('files')==='before\n');
    check('Retained data contains no host token',!JSON.stringify(await get('range-edits')).includes('token'));
    check('Another proposal cannot overwrite retained state',await rejects(retainRangeEditIdb(db,'range-edits',path,{...record,id:'different-delivery'}))&&(await get('range-edits')).id===stage.id);
    await action('files','readwrite',s=>s.put('external\n',path));
    let stale=false;try{restoreRangeEditRecord(await get('range-edits'),path,await get('files'))}catch(e){stale=e.code==='ESTALE'}
    check('Restart refuses proposal over externally changed bytes',stale&&await get('files')==='external\n');
    await action('files','readwrite',s=>s.put('before\n',path));
    await action('range-edits','readwrite',s=>s.put({...record,id:'new-owner'},path));
    check('Changed retained identity prevents source apply',await rejects(commit('applied'))&&await get('files')==='before\n');
    await action('range-edits','readwrite',s=>s.put(record,path));
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='range-edits')throw new Error('owned journal failure');return original.apply(this,args)};
    try{check('Journal failure rolls back source replacement',await rejects(commit('applied'))&&await get('files')==='before\n'&&(await get('range-edits')).state==='staged')}
    finally{IDBObjectStore.prototype.put=original}
    for(let i=1;i<16;i++){
      const p='owned-'+i+'.js',r=rangeEditRecord({...stage,proposal:rangeEditProposal({...request,path:p},'after\n')},'owned-'+i);
      await retainRangeEditIdb(db,'range-edits',p,r);
    }
    const overflow=rangeEditRecord({...stage,proposal:rangeEditProposal({...request,path:'overflow.js'},'after\n')},'overflow');
    check('Persistent proposal retention stops at sixteen paths',await rejects(retainRangeEditIdb(db,'range-edits','overflow.js',overflow)));
    const reviewed=rangeEditRecord({...stage,state:'reviewed'},stage.id);
    check('Restart requires review again before apply',restoreRangeEditRecord(reviewed,path,'before\n').state==='staged');
    return {passed:rows.length,rows};
  }finally{db.close();await new Promise(resolve=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=r.onerror=r.onblocked=resolve})}
}
