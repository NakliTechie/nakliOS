import * as range from '../sys/ai/range-edit.mjs';
export async function runReceiptRaces(handlers){
  const rows=[],name='receipt-races-'+crypto.randomUUID(),path='owned.js';
  const db=await range.openRangeEditDatabase(name,'files',{version:2,journal:true});
  const action=(store,mode,fn)=>new Promise((resolve,reject)=>{const tx=db.transaction(store,mode),request=fn(tx.objectStore(store));tx.oncomplete=()=>resolve(request?.result);tx.onabort=tx.onerror=()=>reject(tx.error)});
  const get=store=>action(store,'readonly',s=>s.get(path));
  const check=(label,pass)=>rows.push({label,pass:!!pass});
  const rejects=p=>p.then(()=>false,error=>error.code==='ESTALE');
  try{
    const request=range.rangeEditRequest({path,project:'editor:browser',backend:'browser',before:'before\n',instruction:'Change to after',selection:{start:1,end:1}});
    await action('files','readwrite',s=>s.put(request.before,path));
    const tab={kind:'project',location:'browser',path,saved:request.before,content:request.before,dirty:false};
    const pendingRangeEdits=new Map([['owned-token',{tab,request}]]);
    const nodes=new Map(),messages=[];
    const context={...range,AbortController,pendingRangeEdits,tabs:[tab],activeLocation:'browser',activeTab:()=>tab,
      $:id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)},
      naklios:{capabilities:{},files:{release(){}}},toast:m=>messages.push(m),render(){},
      openDb:()=>range.openRangeEditDatabase(name,'files',{version:2,journal:true}),
      reviewData:null,readerMode:'read',removeCancelledReceipt(){throw Error('Cancellation is outside this case')}};
    const api=new Function('context','with(context){'+handlers+'\nreturn {receiveRangeEdit,discardAnvilEdit};}')(context);
    let discard,disabledAtPut;
    const put=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){
      const result=put.apply(this,args);
      if(this.name==='range-edits'){
        disabledAtPut=nodes.get('discard-anvil').disabled;
        discard=api.discardAnvilEdit();
      }
      return result;
    };
    let accepted;
    try{accepted=await api.receiveRangeEdit({token:'owned-token',deliveryId:'owned-delivery',request,after:'after\n',run:{project:'owned-project',task:'owned-task',sequence:1}});await discard}
    finally{IDBObjectStore.prototype.put=put}
    check('Discard control stays disabled between journal put and transaction completion',disabledAtPut===true);
    check('Pending Discard cannot remove an acknowledged durable receipt',accepted===true&&(await get('range-edits'))?.state==='staged'&&tab.rangeEdit?.id==='owned-delivery'&&pendingRangeEdits.size===0&&await get('files')===request.before);
    await api.discardAnvilEdit();
    check('Discard after receipt removes only its journal',await get('range-edits')===undefined&&await get('files')===request.before&&tab.rangeEdit===null);
    const record=range.rangeEditRecord({proposal:range.rangeEditProposal(request,'after\n'),state:'staged',run:{task:'owned-task',project:'owned-project',sequence:1}},'retry-delivery');
    const retain=options=>range.retainRangeEditIdb(db,'range-edits',path,record,{filesStore:'files',...options});
    await retain();
    check('Identical receipt retry accepts unchanged source and context',await retain()===true&&(await get('range-edits')).state==='staged');
    await action('files','readwrite',s=>s.put('external\n',path));
    check('Identical receipt retry refuses changed persisted source',await rejects(retain())&&await get('files')==='external\n'&&JSON.stringify(await get('range-edits'))===JSON.stringify(record));
    await action('files','readwrite',s=>s.put(request.before,path));
    check('Identical receipt retry refuses changed receiver context',await rejects(retain({valid:()=>false}))&&await get('files')===request.before&&JSON.stringify(await get('range-edits'))===JSON.stringify(record));
    await range.compareRangeEditIdb(db,'files',path,request.before,record.after,{journal:{store:'range-edits',value:{...record,state:'applied'}}});
    await range.compareRangeEditIdb(db,'files',path,record.after,request.before,{journal:{store:'range-edits',value:{...record,state:'reverted'}}});
    check('Validated identical retry preserves later journal state',await retain()===true&&(await get('range-edits')).state==='reverted');
    return {backend:'native Chrome IndexedDB',providerCalls:0,rows,passed:rows.filter(row=>row.pass).length};
  }finally{
    db.close();await new Promise(resolve=>{const r=indexedDB.deleteDatabase(name);r.onsuccess=r.onerror=r.onblocked=resolve});
  }
}
