// Model-free dependency seams drive the production host and Anvil handlers.
// This is not evidence of a real provider run or native Folder atomic apply.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractFunction, evaluate } from './anvil-harness.mjs';
import * as rangeModule from '../sys/ai/range-edit.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';

const host=await readFile(new URL('../index.html',import.meta.url),'utf8');
const anvil=await readFile(new URL('../apps/anvil/index.html',import.meta.url),'utf8');
const editor=await readFile(new URL('../apps/editor/index.html',import.meta.url),'utf8');
const req=rangeModule.rangeEditRequest({path:'main.js',project:'editor:browser',backend:'browser',
  before:'const answer = 1;\n',instruction:'Change answer to 2.',selection:{start:1,end:1}});
function hostHarness({confirm=()=>true,backend='browser',clock=Date}={}){
  const sent=[],source={postMessage:msg=>sent.push({to:'editor',msg})},target={postMessage:msg=>sent.push({to:'anvil',msg})};
  const originalIdentity={};
  const ctx={setInterval,clearInterval,setTimeout,clearTimeout,fileGrants:new Map(),state:{appPermissions:{editor:{granted:true,backend}},fsHandle:originalIdentity},
    APPS:[{id:'editor',kind:'system'},{id:'anvil',kind:'system'}],
    openWindows:{editor:{querySelector:()=>({contentWindow:source})},anvil:{querySelector:()=>({contentWindow:target})}},
    BACKENDS:{fsa:{isConnected:()=>true,readBinary:async()=>new TextEncoder().encode(req.before)}},
    Date:clock,TextDecoder,FILE_GRANT_MAX_CHARS:2*1024*1024,rangeModule,source,target,sent,fsSafePath:(app,path)=>`apps/${app}/${path}`,
    _dlgEscape:String,nakliosConfirm:confirm,newFileGrantToken:()=>`token-${sent.length}-${Math.random()}`,
    openApp:()=>{},deliverPendingFileGrants:()=>{for(const g of ctx.fileGrants.values())g.targetSource=target}};
  const names=['fileGrantBackendIdentity','revokeFileGrant','assertRangeEditGrant','fileHostEditInAnvil','fileHostProposeEdit','fileHostEditAck','finishRangeEditAck','recheckRangeEditSource','fileHostHandle'];
  const code=names.map(n=>extractFunction(host,n)).join('\n')
    .replaceAll("await import('./sys/ai/range-edit.mjs')",'rangeModule');
  const api=evaluate(code+'\n;({fileHostEditInAnvil,fileHostProposeEdit,fileHostEditAck,fileHostHandle})',ctx);
  source.postMessage=msg=>{sent.push({to:'editor',msg});if(msg.proposal?.deliveryId)api.fileHostEditAck(source,msg.proposal,'editor')};
  return {...ctx,...api,originalIdentity};
}
{
  const h=hostHarness();
  await assert.rejects(()=>h.fileHostEditInAnvil(h.source,{request:req},'files'),/Only Editor/);
  const issued=await h.fileHostEditInAnvil(h.source,{request:req},'editor');
  assert.ok(issued.token);
  assert.equal(h.fileGrants.size,1);
  const file=await h.fileHostHandle(h.target,{token:issued.token},'anvil','read');
  assert.equal(file.data,req.before);
  assert.equal(file.kind,'range-edit');
  await assert.rejects(()=>h.fileHostHandle(h.target,{token:issued.token,data:'overwrite'},'anvil','write'),/only propose/);
  await assert.rejects(()=>h.fileHostHandle({}, {token:issued.token},'anvil','read'),/missing or expired/);
  await assert.rejects(()=>h.fileHostProposeEdit(h.target,{token:issued.token,after:'x'},'anvil'),/run identity/);
  assert.equal(h.sent.length,0,'invalid metadata emits no proposal');
  const result={token:issued.token,after:req.before.replace('1','2'),run:{task:'qa-task',project:'qa-project',sequence:1}};
  assert.equal(await h.fileHostProposeEdit(h.target,result,'anvil'),true);
  assert.equal(h.fileGrants.size,0);
  assert.equal(h.sent[0].msg.proposal.request.path,req.path);
  assert.equal(h.sent[0].msg.proposal.after,result.after);
  await assert.rejects(()=>h.fileHostProposeEdit(h.target,result,'anvil'),/No exact-file/);
}
{
  const h=hostHarness({confirm:()=>false});
  assert.equal(await h.fileHostEditInAnvil(h.source,{request:req},'editor'),null);
  assert.equal(h.fileGrants.size,0);
}
{
  const h=hostHarness({backend:'fsa',confirm:()=>{h.state.fsHandle={};return true}});
  await assert.rejects(()=>h.fileHostEditInAnvil(h.source,{request:{...req,backend:'fsa'}},'editor'),/Source storage changed/);
  assert.equal(h.fileGrants.size,0);
}
{
  const h=hostHarness({backend:'fsa',confirm:()=>{h.BACKENDS.fsa.readBinary=async()=>new TextEncoder().encode('external');return true}});
  await assert.rejects(()=>h.fileHostEditInAnvil(h.source,{request:{...req,backend:'fsa'}},'editor'),/Source changed during confirmation/);
  assert.equal(h.fileGrants.size,0);
}
for(const mutation of [h=>{h.fileGrants.values().next().value.expires=0},h=>{h.openWindows.editor.querySelector=()=>({contentWindow:{}})}]){
  const h=hostHarness(),issued=await h.fileHostEditInAnvil(h.source,{request:req},'editor');mutation(h);
  await assert.rejects(()=>h.fileHostHandle(h.target,{token:issued.token},'anvil','read'),/expired|closed/);
  assert.equal(h.fileGrants.size,0);
  assert.ok(h.sent.some(x=>x.msg.grant?.kind==='range-edit-cancelled'));
  assert.ok(h.sent.some(x=>x.msg.proposal?.cancelled));
}

// Ordinary exact-file grants must preserve UTF-8 bytes and enforce the provider cap.
{
  const h=hostHarness({backend:'fsa'});const original='\ufeffcafé\r\n';let cap;
  h.BACKENDS.fsa.readBinary=async(path,maxBytes)=>{cap=maxBytes;assert.equal(path,'apps/editor/main.js');return new TextEncoder().encode(original)};
  h.fileGrants.set('exact',{targetSource:h.target,targetAppId:'editor',backendId:'fsa',backendIdentity:h.originalIdentity,safePath:'apps/editor/main.js',sourcePath:'main.js',name:'main.js'});
  assert.equal((await h.fileHostHandle(h.target,{token:'exact'},'editor','read')).data,original);assert.equal(cap,2*1024*1024);
  h.BACKENDS.fsa.readBinary=async()=>Uint8Array.of(255);
  await assert.rejects(h.fileHostHandle(h.target,{token:'exact'},'editor','read'),/encoded data|encoding/i);
  h.BACKENDS.fsa.readBinary=async()=>{throw Object.assign(new Error('oversized source'),{code:'EFBIG'})};
  await assert.rejects(h.fileHostHandle(h.target,{token:'exact'},'editor','read'),e=>e.code==='EFBIG');
}

// Drive the real acceptRangeEdit handler over the production closed backend.
for(const outcome of ['done','aborted','throw']){
  const old=new MemoryBackend();await old.write('old.txt',new TextEncoder().encode('unchanged'));
  const calls=[],project={id:'qa-project',tasks:[]};
  const ctx={...rangeModule,backend:old,fs:createFileops({backend:old}),wsRoot:'',workspaceLabel:'old',
    activeRangeEdit:null,cancelledRangeTokens:new Set(),running:false,priming:false,folderMode:true,kilnRef:null,
    state:{activeProject:'qa-project',activeTask:null,runsHeld:false,projects:[project]},project,calls,createFileops,old,assert,mountedProject:'qa-project',
    nak:{files:{read:async()=>({path:req.path,backend:req.backend,request:req,expires:Date.now()+900000}),
      experimental_proposeEdit:async(token,after,run)=>calls.push({token,after,run}),release:()=>{}}},
    id:(()=>{let n=0;return()=>`qa-${outcome}-${++n}`})(),save:()=>{},renderAll:()=>{},pushSystem:()=>{},agentShell:()=>({})};
  const glue=`function activeProject(){return state.projects.find(p=>p.id===state.activeProject)} function activeTask(){return state.projects.flatMap(p=>p.tasks).find(t=>t.id===state.activeTask)}
    function mountWorkspace(b,label,root=''){backend=b;workspaceLabel=label;wsRoot=root;fs=createFileops({backend:b,root})}
    async function runTask(t){
      if(${JSON.stringify(outcome)}==='throw')throw new Error('fixture failure');
      await assert.rejects(()=>fs.write('sibling.js','escape'),e=>e.code==='EACCES');
      await fs.write('main.js','const answer = 2;\\n');t.lastStop=${JSON.stringify(outcome)};t.runSeq=1;t.status='unclaimed';
    }`;
  const handler=evaluate(glue+extractFunction(anvil,'pruneRangeSnapshots')+'\n'+extractFunction(anvil,'acceptRangeEdit')+'\n;acceptRangeEdit',ctx);
  await handler({token:'qa-token'});
  assert.equal(calls.length,outcome==='done'?1:0,JSON.stringify(ctx.state.projects[1].tasks[0].log));
  assert.equal(new TextDecoder().decode(await old.readBinary('old.txt')),'unchanged');
  assert.equal(await old.exists('main.js'),false,'source workspace remains unchanged');
  assert.equal(ctx.state.projects[1].tasks[0].rangeEdit.state,outcome==='done'?'proposed':outcome==='aborted'?'cancelled':'failed');
  assert.equal(ctx.state.activeProject,'qa-project','the original Anvil project is restored');
}

// Production Editor receiver keeps the retained source identity authoritative.
{
  const tab={id:'qa-tab',kind:'project',location:'browser',path:req.path,saved:req.before,content:req.before,dirty:false};
  const pendingRangeEdits=new Map([['qa-token',{tab,request:req}]]),messages=[];
  const ctx={AbortController,rangeEditProposal:rangeModule.rangeEditProposal,pendingRangeEdits,activeLocation:'browser',tabs:[tab],
    naklios:{capabilities:{}},persistAnvilEdit:async()=>true,renderRangeActions:()=>{},toast:m=>messages.push(m),tab};
  const receive=evaluate('function activeTab(){return tab}\n'+extractFunction(editor,'rangeSourceCurrent')
    +'\n'+extractFunction(editor,'receiveRangeEdit')+'\n;receiveRangeEdit',ctx);
  receive({token:'unknown',request:req,after:'attack'});assert.equal(tab.rangeEdit,undefined);
  receive({token:'qa-token',request:{...req,project:'other'},after:'attack'});
  assert.equal(tab.rangeEdit,undefined);assert.match(messages.at(-1),/does not match/);
  pendingRangeEdits.set('qa-token',{tab,request:req});
  receive({token:'qa-token',deliveryId:'qa-delivery',request:req,after:req.before.replace('1','2'),run:{task:'qa-task',project:'qa-project',sequence:1}});
  assert.equal(tab.rangeEdit.state,'staged');
  assert.equal(tab.saved,req.before,'receiving a proposal does not save the source');
  pendingRangeEdits.set('qa-token',{tab,request:req});tab.dirty=true;
  receive({token:'qa-token',request:req,after:'attack'});assert.match(messages.at(-1),/source changed/);
}

// Snapshot learning cannot use a later ambient workspace, even when its project is selected.
{
  const calls={reviews:0,writes:[]};
  const learn=evaluate(extractFunction(anvil,'learnThisRun')+'\n;learnThisRun',{
    nak:{capabilities:{ai:true}},state:{activeProject:'snapshot-project'},
    inferViaHost(){throw new Error('No provider calls in this fixture')},projectLedger:async()=>({}),
    runLearnReview:async({propose})=>{calls.reviews++;await propose({kind:'fact',note:'owned reviewer fixture'});return {staged:[],quarantined:[],dropped:[]}},
    recordFact:async(note)=>{calls.writes.push(note);return 'owned-note'},save(){},renderFiles(){},renderLog(){},
  });
  const rec={events:[],resolve(){}};
  const result=await learn({rangeEdit:{state:'proposed'}},rec,'snapshot-project');
  assert.equal(calls.reviews,0,'snapshot tasks never invoke the ambient reviewer');
  assert.deepEqual(calls.writes,[],'snapshot review never writes into a later workspace');
  assert.equal(result,null);
  await learn({log:[]},rec,'snapshot-project');
  assert.equal(calls.reviews,1,'an eligible ordinary task still reaches the reviewer');
  assert.deepEqual(calls.writes,['owned reviewer fixture']);
  assert.match(anvil,/if\(!t\.rangeEdit\)\{\s*if\(decide\(0\)\.review\)/);
}
// Project priming cannot read or write a later mount through an ended snapshot task.
{
  const messages=[],prime=evaluate(extractFunction(anvil,'primeProject')+'\n;primeProject',{
    activeTask:()=>({rangeEdit:{state:'proposed'}}),pushSystem:message=>messages.push(message),
  });
  await prime();assert.match(messages[0],/snapshot task has ended/);
}
// A delayed database commit must preserve a buffer changed after its final source comparison.
{
  const proposal=rangeModule.rangeEditProposal(req,req.before.replace('1','2'));
  const stage={proposal,state:'reviewed'},tab={kind:'project',location:'browser',path:req.path,
    content:req.before,saved:req.before,dirty:false,rangeEdit:stage};
  let release,committing;const atCompare=new Promise(resolve=>{committing=resolve});
  const elements=new Map(),ctx={AbortController,pendingRangeEdits:new Map(),activeTab:()=>tab,activeLocation:'browser',
    $:id=>{if(!elements.has(id))elements.set(id,{});return elements.get(id)},
    rangeEditRecord:stage=>rangeModule.rangeEditRecord({...stage,run:{task:'fixture-task',project:'fixture-project',sequence:1}},'fixture-id'),openDb:async()=>({close(){}}),compareRangeEditIdb:async(db,store,key,expected,replacement,{valid})=>{
      assert.equal(valid(),true);committing();await new Promise(resolve=>{release=resolve});
    },renderRangeActions(){},render(){},toast(){},setSave(){},reviewData:null};
  const commit=evaluate(extractFunction(editor,'commitRangeEdit')+'\n;commitRangeEdit',ctx);
  const pending=commit();await atCompare;
  tab.content='const answer = 3;\n';tab.dirty=true;release();await pending;
  assert.equal(tab.content,'const answer = 3;\n','a newer buffer survives database completion');
  assert.equal(tab.saved,proposal.after);assert.equal(tab.dirty,true);
  assert.equal(tab.rangeBusy,false);
}
// Every direct editing command refuses while compare-and-replace is in flight.
for(const name of ['replaceSelection','replaceAll','indent','formatJson']){
  const command=evaluate(extractFunction(editor,name)+'\n;'+name,{readerMode:'edit',activeTab:()=>({rangeBusy:true})});
  command(); // Any DOM access would throw: the busy guard must return first.
}
// Switching storage or closing the source tab must wait for transaction completion.
{
  const tab={rangeBusy:true},messages=[];
  const ctx={tabs:[tab],toast:message=>messages.push(message)};
  const activate=evaluate(extractFunction(editor,'activate')+'\n;activate',ctx);
  const close=evaluate(extractFunction(editor,'closeTab')+'\n;closeTab',ctx);
  await activate('fsa');await close(tab);
  assert.equal(messages.length,2);assert.ok(messages.every(message=>/operation to finish/.test(message)));
}

// Late confirmation cannot start an orphaned model run after the client timeout.
{
  let now=1000;const clock={now:()=>now};
  const h=hostHarness({clock,confirm:()=>{now+=30000;return true}});
  await assert.rejects(()=>h.fileHostEditInAnvil(h.source,{request:req},'editor'),/Confirmation expired/);
  assert.equal(h.fileGrants.size,0);
  assert.equal(h.sent.length,0);
}
// New range grants wait for this iframe's load before delivery, including ready-before-load order.
{
  const sent=[],frame={_fileGrantLoaded:false,contentDocument:{readyState:'loading'},contentWindow:{postMessage:m=>sent.push(m)}},
    grant={kind:'range-edit',targetAppId:'anvil',sourcePath:req.path},fileGrants=new Map([['owned-token',grant]]),
    win={_sdkReady:true,_pendingFileGrantTokens:['owned-token'],dataset:{id:'anvil'},querySelector:()=>frame};
  const deliver=evaluate(extractFunction(host,'deliverFileGrant')+'\n'+extractFunction(host,'deliverPendingFileGrants')+'\n;deliverPendingFileGrants',{fileGrants});
  deliver(win);assert.equal(sent.length,0);assert.equal(win._pendingFileGrantTokens.length,1);
  frame._fileGrantLoaded=true;frame.contentDocument.readyState='complete';deliver(win);
  assert.equal(sent.length,1);assert.equal(win._pendingFileGrantTokens.length,0);
  assert.equal(grant.targetSource,frame.contentWindow);
}
// The proposal's reversible state survives another attempted send.
{
  const messages=[],tab={id:'owned-tab',kind:'project',rangeEdit:{state:'applied'}};
  const send=evaluate(extractFunction(editor,'sendSelectionToAnvil')+'\n;sendSelectionToAnvil',{
    activeTab:()=>tab,toast:m=>messages.push(m),
  });
  await send();assert.match(messages[0],/Discard the current proposal/);
  const discard=evaluate(extractFunction(editor,'discardAnvilEdit')+'\n;discardAnvilEdit',{
    activeTab:()=>tab,toast:m=>messages.push(m),reviewData:null,render(){},
  });
  discard();assert.equal(tab.rangeEdit.state,'applied');assert.match(messages.at(-1),/Revert the applied edit/);
  tab.rangeEdit.state='reverted';discard();assert.equal(tab.rangeEdit,null);
}
// Closing aborts a pending apply and waits for its completion before acknowledging.
{
  const controller=new AbortController(),calls=[];let finish;
  const tab={rangeController:controller,rangeCommit:new Promise(resolve=>{finish=resolve})};
  const beforeClose=evaluate(extractFunction(editor,'beforeRangeClose')+'\n;beforeRangeClose',{
    tabs:[tab],pendingRangeEdits:new Map(),saveAll:async()=>calls.push('saved'),
  });
  const close=beforeClose();assert.equal(controller.signal.aborted,true);assert.equal(tab.rangeClosing,true);
  let settled=false;close.then(()=>{settled=true});await Promise.resolve();assert.equal(settled,false);finish();await close;assert.equal(settled,true);
}
// The actual SDK close callback cannot acknowledge before proposal persistence.
{
  const sdk=await readFile(new URL('../sdk/naklios.js',import.meta.url),'utf8'),sent=[];
  let finishPersist;
  const pendingRangeEdits=new Map([['owned-close-token',{persist:new Promise(resolve=>{finishPersist=resolve})}]]);
  const registration=editor.match(/naklios\.beforeClose\((.*?)\);/)[1];
  const branch=sdk.split("} else if (msg.type === 'naklios:beforeclose') {")[1]
    .split("} else if (msg.type === 'naklios:capabilities')")[0];
  const close=evaluate(extractFunction(editor,'saveAll')+'\nconst beforeCloseCb='+registration
    +';\nfunction sdkClose(){'+branch+'}\n;sdkClose',{
      tabs:[],pendingRangeEdits,saveTab:async()=>{},queueWorkspace:async()=>{},setSave(){},
      flushSavers:async()=>{},send:(type,data)=>sent.push({type,...data}),msg:{requestId:'owned-close-request'},
    });
  close();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.length,0,'SDK close waits for durable proposal retention');
  finishPersist(true);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(sent.length,1);assert.equal(sent[0].type,'naklios:beforeclose-ready');
  assert.equal(sent[0].requestId,'owned-close-request');
}

// Interactive snapshot projects remain bounded; durable recorder storage is separate.
{
  const normal={id:'normal'},selected={id:'selected',rangeSnapshot:true};
  const state={activeProject:'selected',projects:[normal,selected,...Array.from({length:12},(_,n)=>({id:'snapshot-'+n,rangeSnapshot:true}))]};
  const prune=evaluate(extractFunction(anvil,'pruneRangeSnapshots')+'\n;pruneRangeSnapshots',{state});
  prune();assert.equal(state.projects.filter(p=>p.rangeSnapshot).length,5);
  assert.ok(state.projects.includes(normal));assert.ok(state.projects.includes(selected));
  assert.equal(JSON.stringify(state.projects.filter(p=>p.id.startsWith('snapshot')).map(p=>p.id)),JSON.stringify(['snapshot-8','snapshot-9','snapshot-10','snapshot-11']));
}

// A failed initial token read always releases the grant and cannot create a task.
{
  const released=[],handler=evaluate(extractFunction(anvil,'acceptRangeEdit')+'\n;acceptRangeEdit',{
    running:false,priming:false,state:{runsHeld:false},activeRangeEdit:null,
    nak:{files:{experimental_proposeEdit(){throw new Error('No proposal allowed')},read:async()=>{throw new Error('owned read failure')},release:token=>released.push(token)}},
  });
  await assert.rejects(()=>handler({token:'owned-failed-token'}),/owned read failure/);
  assert.deepEqual(released,['owned-failed-token']);
}
// A selected snapshot refuses follow-ups before mutating the prompt or queue.
{
  const messages=[],tab={rangeEdit:{state:'snapshot'},queued:[]};
  const submit=evaluate(extractFunction(anvil,'submit')+'\n;submit',{
    activeTask:()=>tab,pushSystem:m=>messages.push(m),
  });
  assert.equal(submit(),false);assert.deepEqual(tab.queued,[]);assert.match(messages[0],/do not accept follow-ups/);
}
// A Folder edit must still match its source before the host stages the proposal.
{
  const h=hostHarness({backend:'fsa'}),issued=await h.fileHostEditInAnvil(h.source,{request:{...req,backend:'fsa'}},'editor');
  h.BACKENDS.fsa.readBinary=async()=>new TextEncoder().encode('external change');
  await assert.rejects(()=>h.fileHostProposeEdit(h.target,{token:issued.token,after:req.before.replace('1','2'),run:{task:'qa-task',project:'qa-project',sequence:1}},'anvil'),/Source changed during the Anvil run/);
  assert.equal(h.fileGrants.size,0);assert.ok(h.sent.some(x=>x.msg.proposal?.cancelled));
  assert.ok(!h.sent.some(x=>x.msg.proposal?.after));
}
console.log('range-edit handlers: confirmed grants, stale identities, one-shot proposals, cancellation, and unchanged sources pass');
