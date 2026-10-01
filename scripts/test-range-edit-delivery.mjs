import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {extractFunction,evaluate} from './anvil-harness.mjs';
import * as rangeModule from '../sys/ai/range-edit.mjs';
const host=await readFile(new URL('../index.html',import.meta.url),'utf8'),sdk=await readFile(new URL('../sdk/naklios.js',import.meta.url),'utf8'),editor=await readFile(new URL('../apps/editor/index.html',import.meta.url),'utf8');
const request=rangeModule.rangeEditRequest({path:'owned.js',project:'editor:browser',backend:'browser',before:'before\n',instruction:'Change to after',selection:{start:1,end:1}});
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function harness(backend='browser'){
  let now=1000;const sent=[],timers=new Map(),source={postMessage:m=>sent.push(m)},target={postMessage(){}};
  const backendIdentity={},grant={token:'owned-token',kind:'range-edit',request,sourcePath:request.path,backendId:backend,backendIdentity,sourceSource:source,targetSource:target,expires:999999};
  const context={fileGrants:new Map([[grant.token,grant]]),openWindows:{editor:{querySelector:()=>({contentWindow:source})}},
    TextDecoder,state:{fsHandle:backendIdentity,appPermissions:{editor:{granted:true,backend}}},BACKENDS:{fsa:{isConnected:()=>true,readBinary:async()=>new TextEncoder().encode(request.before)}},fsSafePath:(app,path)=>path,
    Date:{now:()=>now},rangeModule,newFileGrantToken:()=> 'owned-delivery',setTimeout:()=>2,clearTimeout(){},setInterval:fn=>{timers.set(1,fn);return 1},clearInterval:id=>timers.delete(id)};
  const code=['fileGrantBackendIdentity','assertRangeEditGrant','revokeFileGrant','fileHostProposeEdit','fileHostEditAck','finishRangeEditAck','recheckRangeEditSource'].map(n=>extractFunction(host,n)).join('\n').replaceAll("await import('./sys/ai/range-edit.mjs')",'rangeModule');
  const api=evaluate(code+'\n;({fileHostProposeEdit,fileHostEditAck,revokeFileGrant})',context);
  return {...context,...api,source,target,grant,sent,timers,tick:()=>timers.get(1)?.(),setNow:n=>{now=n},msg:{token:grant.token,after:'after\n',run:{task:'owned-task',project:'owned-project',sequence:1}}};
}
{
  const h=harness();let settled=false;
  const pending=h.fileHostProposeEdit(h.target,h.msg,'anvil').then(v=>{settled=true;return v});await flush();
  assert.equal(h.sent.length,1);assert.equal(settled,false,'postMessage alone never proves delivery');
  assert.equal(h.fileGrants.size,1,'unacknowledged result remains retryable');
  assert.equal(h.fileHostEditAck({},h.sent[0].proposal,'editor'),false,'another source cannot acknowledge');
  assert.equal(h.fileHostEditAck(h.source,h.sent[0].proposal,'anvil'),false,'another app cannot acknowledge');
  assert.equal(h.fileHostEditAck(h.source,{...h.sent[0].proposal,deliveryId:'wrong'},'editor'),false,'wrong delivery identity cannot acknowledge');
  const replay=h.fileHostProposeEdit(h.target,h.msg,'anvil');await flush();assert.equal(h.sent.length,1);
  await assert.rejects(()=>h.fileHostProposeEdit(h.target,{...h.msg,after:'different'},'anvil'),/different proposal/);
  h.tick();assert.equal(h.sent.length,2,'a dropped delivery is retried');
  assert.equal(h.sent[1].proposal.deliveryId,h.sent[0].proposal.deliveryId,'retry preserves proposal identity');
  assert.equal(h.fileHostEditAck(h.source,h.sent[1].proposal,'editor'),true);
  assert.equal(await pending,true);assert.equal(await replay,true);assert.equal(h.timers.size,0);assert.equal(h.fileGrants.size,0);
  assert.equal(h.fileHostEditAck(h.source,h.sent[1].proposal,'editor'),false,'terminal acknowledgement is harmless');
}
{
  const h=harness(),pending=h.fileHostProposeEdit(h.target,h.msg,'anvil');await flush();
  h.setNow(14000);h.tick();await assert.rejects(()=>pending,/acknowledge/);assert.equal(h.timers.size,0);assert.equal(h.fileGrants.size,0);
}
{
  const h=harness(),pending=h.fileHostProposeEdit(h.target,h.msg,'anvil');await flush();
  h.revokeFileGrant(h.grant);await assert.rejects(()=>pending,/cancelled/);assert.equal(h.timers.size,0);
}
function sdkHarness(){
  const sent=[],context={fileEditListeners:new Set(),pendingFileEdits:[],acceptedFileEdits:new Map(),acceptingFileEdits:new Map(),send:(type,data)=>sent.push({type,...data})};
  const deliver=evaluate(extractFunction(sdk,'deliverFileEdit')+'\n;deliverFileEdit',context);
  return {...context,deliver,sent};
}
{
  const h=sdkHarness(),proposal={token:'owned-token',deliveryId:'owned-delivery'};
  let finish,calls=0;h.fileEditListeners.add(()=>{calls++;return new Promise(resolve=>{finish=resolve})});
  h.deliver(proposal);h.deliver(proposal);await flush();assert.equal(calls,1);assert.equal(h.sent.length,0,'receipt waits for durable receiver acceptance');
  finish(true);await flush();assert.equal(h.sent[0].type,'naklios:file:edit-ack');
  h.deliver(proposal);await flush();assert.equal(calls,1,'replay does not stage the proposal twice');assert.equal(h.sent.length,2,'replay re-acknowledges a dropped ack');
}
{
  const h=sdkHarness(),proposal={token:'owned-token',deliveryId:'owned-delivery'};
  h.deliver(proposal);h.deliver(proposal);assert.equal(h.pendingFileEdits.length,1,'queued retry is coalesced');assert.equal(h.sent.length,0);
  let calls=0;h.fileEditListeners.add(()=>{calls++;return false});h.pendingFileEdits.splice(0).forEach(h.deliver);await flush();
  assert.equal(h.sent.length,0,'refused receiver sends no success ack');h.deliver(proposal);await flush();assert.equal(calls,2,'refusal permits later retry');
  h.fileEditListeners.clear();for(let i=0;i<20;i++)h.deliver({token:'t'+i,deliveryId:'d'+i});assert.equal(h.pendingFileEdits.length,16);
}
// The actual host, SDK receiver and Editor handler share one message path.
for(const cancel of [false,true]){
  const h=harness(),bridge=sdkHarness(),tab={kind:'project',location:'browser',path:request.path,saved:request.before,content:request.before,dirty:false};
  const pendingRangeEdits=new Map([[h.grant.token,{tab,request}]]);
  let finish,retained=null,persists=0,cleanup=0;
  const context={AbortController,pendingRangeEdits,tabs:[tab],activeLocation:'browser',activeTab:()=>tab,
    rangeEditProposal:rangeModule.rangeEditProposal,naklios:{capabilities:{},files:{release:()=>h.revokeFileGrant(h.grant)}},
    renderRangeActions(){},toast(){},persistAnvilEdit:(_tab,stage)=>{persists++;return new Promise(resolve=>{finish=()=>{retained=stage;resolve(true)}})},
    removeCancelledReceipt:async()=>{cleanup++;retained=null}};
  const api=evaluate(['rangeSourceCurrent','receiveRangeEdit','cancelAnvilRequest'].map(n=>extractFunction(editor,n)).join('\n')+'\n;({receiveRangeEdit,cancelAnvilRequest})',context);
  bridge.fileEditListeners.add(api.receiveRangeEdit);
  h.source.postMessage=msg=>{h.sent.push(msg);if(msg.proposal)bridge.deliver(msg.proposal)};
  // SDK acknowledgement uses the real source-bound host handler.
  const send=evaluate(extractFunction(sdk,'deliverFileEdit')+'\n;deliverFileEdit',{
    ...bridge,send:(type,msg)=>{bridge.sent.push({type,...msg});h.fileHostEditAck(h.source,msg,'editor')},
  });
  h.source.postMessage=msg=>{h.sent.push(msg);if(msg.proposal)send(msg.proposal)};
  const run=h.fileHostProposeEdit(h.target,h.msg,'anvil').then(()=>true,()=>false);await flush();
  h.tick();assert.equal(persists,1,'actual delivery retry coalesces one Editor persistence');assert.equal(bridge.sent.length,0);
  if(cancel)api.cancelAnvilRequest();
  finish();await flush();
  assert.equal(await run,!cancel);
  assert.equal(bridge.sent.filter(m=>m.type==='naklios:file:edit-ack').length,cancel?0:1);
  assert.equal(cleanup,cancel?1:0,'late cancelled commit is removed before accepting receipt');
  assert.equal(retained===null,cancel);assert.equal(tab.rangeEdit==null,cancel);assert.equal(pendingRangeEdits.size,0);
}
for(const atAck of [false,true]){
  const h=harness('fsa');let current=request.before;
  h.BACKENDS.fsa.readBinary=async()=>new TextEncoder().encode(current);
  const run=h.fileHostProposeEdit(h.target,h.msg,'anvil').then(()=>true,()=>false);await flush();
  const proposal=h.sent[0].proposal;current='external\n';
  if(atAck)await assert.rejects(()=>h.fileHostEditAck(h.source,proposal,'editor'),/Source changed/);
  else await h.tick();
  assert.equal(await run,false,'Folder source changes reject successful delivery');
  assert.equal(h.fileGrants.size,0);assert.equal(current,'external\n');
}
{
  const h=harness('fsa'),run=h.fileHostProposeEdit(h.target,h.msg,'anvil');await flush();
  assert.equal(await h.fileHostEditAck(h.source,h.sent[0].proposal,'editor'),true,'unchanged Folder proposal acknowledges successfully');
  assert.equal(await run,true);
}
// Closing a tab awaits the same receipt the SDK acknowledges.
{
  let finish;const receipt=new Promise(resolve=>{finish=resolve}),tab={id:'owned-tab',kind:'project',dirty:false},pendingRangeEdits=new Map([['owned-token',{tab,persist:receipt}]]);
  const context={tab,tabs:[tab],activeId:tab.id,pendingRangeEdits,toast(){},renderRangeActions(){},render(){},queueWorkspace(){},naklios:{files:{release(){}}}};
  const api=evaluate(extractFunction(editor,'closeTab')+'\n;({closeTab,getTabs:()=>tabs})',context);
  Object.defineProperty(context,'tabs',{get:()=>api.getTabs()});
  const result=api.closeTab(tab);await flush();assert.equal(context.tabs.includes(tab),true,'closing tab preserves receipt context until persistence finishes');
  finish(true);await result;assert.equal(context.tabs.length,0);assert.equal(tab.rangeBusy,false);
}
console.log('Range-edit acknowledged delivery: host retries, bound acknowledgements, expiry, cancellation, async persistence, deduplication, refusal, integrated receipt, Folder freshness and tab close passed');

// A committed receipt whose cancellation cleanup fails remains actionable.
{
  const h=harness(),bridge=sdkHarness(),tab={kind:'project',location:'browser',path:request.path,saved:request.before,content:request.before,dirty:false};
  const pendingRangeEdits=new Map([[h.grant.token,{tab,request}]]),messages=[];
  let finish,retained;
  const context={AbortController,pendingRangeEdits,tabs:[tab],activeLocation:'browser',activeTab:()=>tab,
    rangeEditProposal:rangeModule.rangeEditProposal,naklios:{capabilities:{},files:{release:()=>h.revokeFileGrant(h.grant)}},
    renderRangeActions(){},render(){},toast:m=>messages.push(m),reviewData:null,readerMode:'edit',
    persistAnvilEdit:(_tab,stage)=>new Promise(resolve=>{finish=()=>{retained=stage;resolve(true)}}),
    removeCancelledReceipt:async()=>{throw new Error('owned cleanup failure')},openDb:async()=>({close(){}}),
    discardRangeEditIdb:async(_db,_store,path,id,state)=>{assert.equal(path,request.path);assert.equal(id,retained.id);assert.equal(state,'staged');retained=null},
  };
  const api=evaluate(['rangeSourceCurrent','receiveRangeEdit','cancelAnvilRequest','reviewAnvilEdit','discardAnvilEdit'].map(n=>extractFunction(editor,n)).join('\n')+'\n;({receiveRangeEdit,cancelAnvilRequest,reviewAnvilEdit,discardAnvilEdit})',context);
  bridge.fileEditListeners.add(api.receiveRangeEdit);
  const deliver=evaluate(extractFunction(sdk,'deliverFileEdit')+'\n;deliverFileEdit',{
    ...bridge,send:(type,msg)=>{bridge.sent.push({type,...msg});h.fileHostEditAck(h.source,msg,'editor')},
  });
  h.source.postMessage=msg=>{h.sent.push(msg);if(msg.proposal)deliver(msg.proposal)};
  const run=h.fileHostProposeEdit(h.target,h.msg,'anvil').then(()=>true,()=>false);await flush();
  api.cancelAnvilRequest();finish();await flush();assert.equal(await run,false);
  assert.equal(tab.rangeEdit.state,'cleanup','failed cancellation cleanup retains actionable context');
  assert.equal(tab.rangeEdit.id,retained.id);assert.equal(tab.rangeRecordConflict,true);
  assert.equal(bridge.sent.length,0,'failed cancellation cleanup never acknowledges delivery');
  assert.ok(messages.some(m=>m.startsWith('Cancellation cleanup failed:')));
  api.reviewAnvilEdit();assert.equal(tab.rangeEdit.state,'cleanup','cleanup state never gains apply authority');
  await api.discardAnvilEdit();assert.equal(retained,null);assert.equal(tab.rangeEdit,null);assert.equal(tab.rangeRecordConflict,false);
  assert.equal(tab.saved,request.before,'explicit cleanup retry preserves source');assert.equal(tab.content,request.before);
}

// A failed cancellation-marker write still tries exact-identity journal removal.
for(const deleteFails of [false,true]){
  let retained={id:'owned-cancel',state:'staged'},closed=0;
  const tab={path:'owned.js'},stage={id:retained.id};
  const remove=evaluate(extractFunction(editor,'removeCancelledReceipt')+'\n;removeCancelledReceipt',{
    openDb:async()=>({close(){closed++}}),
    cancelRangeEditIdb:async()=>{throw Error('owned marker failure')},
    discardRangeEditIdb:async(_db,_store,path,id,state)=>{
      assert.equal(path,tab.path);assert.equal(id,retained.id);assert.equal(state,'staged');
      if(deleteFails)throw Error('owned deletion failure');retained=null;
    },
  });
  if(deleteFails)await assert.rejects(remove(tab,stage),/owned deletion failure/);else await remove(tab,stage);
  assert.equal(retained===null,!deleteFails);assert.equal(closed,1);
}
