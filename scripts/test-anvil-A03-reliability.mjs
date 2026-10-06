import test from 'node:test';
import assert from 'node:assert/strict';
import {withCallIds,transcriptCallIds} from '../sys/ai/call-ids.mjs';
import {parseHooks,preToolDecision,hookCommand,HOOK_LIMITS} from '../sys/ai/hooks.mjs';
import {postHookNotes,loadHooks,preHookReply} from '../sys/ai/run-assembly.mjs';
import {inlineModule,extractFunction,instantiate} from './anvil-harness.mjs';

test('generated IDs reserve supplied sibling IDs and carried transcript IDs without changing originals',()=>{
 const supplied={id:'call_0_0',function:{name:'read',arguments:'{}'}};
 const carried=transcriptCallIds([{role:'tool',tool_call_id:'call_0_0_2'}]);
 const result=withCallIds([{function:{name:'read',arguments:'{}'}},supplied],0,carried);
 assert.equal(result[0].id,'call_0_0_3');assert.equal(result[1],supplied);
 assert.equal(withCallIds([{}],0,carried)[0].id,'call_0_0_4');
});
test('hook configuration fails closed on count, text and UTF-8 byte bounds',()=>{
 for(const cfg of ['{','null','[]','{"preTool":1}','{"preTool":[null]}',JSON.stringify({preTool:Array.from({length:17},()=>({block:'no'}))}),
   JSON.stringify({postTool:[{run:'x'.repeat(4097)}]}),'x'.repeat(65537),
   JSON.stringify({postTool:[{run:'ह'.repeat(1500)}]})]){
  const hooks=parseHooks(cfg);assert.equal(hooks.postTool.length,0);
  const decision=preToolDecision(hooks,'write',{});assert.equal(decision.blocked,true);assert.match(decision.message,/Project hooks refused/);
 }
 assert.throws(()=>hookCommand({run:'{file}'.repeat(32)},{path:'a'.repeat(1024)}),/expanded.*bound/);
 assert.throws(()=>hookCommand({run:'echo {file}'},{path:"'".repeat(4096)}),/substitution.*bound/);
});
test('hook reads request bounds and unavailable configuration prevents tool execution',async()=>{
 let options;
 const hooks=await loadHooks({read:async(path,opts)=>{options=opts;return {ok:false,code:'ENOTSUP'};}});
 assert.equal(options.maxBytes,HOOK_LIMITS.configBytes);assert.match(preHookReply(hooks,'write',{}),/unavailable.*ENOTSUP/);
});
test('hook errors and accumulated notes stay bounded while finite commands retain order',async()=>{
 const cfg=parseHooks(JSON.stringify({postTool:Array.from({length:16},(_,i)=>({run:'echo '+i}))}));
 const called=[];
 const notes=await postHookNotes(cfg,'write',{},()=>({feed:async command=>{called.push(command);throw new Error('x'.repeat(100000));}}));
 assert.equal(called.length,16);assert.deepEqual(called,Array.from({length:16},(_,i)=>'echo '+i));
 assert.ok(notes.length<=HOOK_LIMITS.notesChars);assert.ok(notes.includes('echo 0'));assert.ok(notes.includes('error:'));
});
test('one competing prompt answer resolves only its own approval',async()=>{
 const nodes=[],listeners=new Set();
 const document={activeElement:null,createElement:tag=>{
  const node={tag,children:[],appendChild(child){this.children.push(child);return child;},setAttribute(){},remove(){this.removed=true;},focus(){document.activeElement=this;},addEventListener(){},querySelector(){return this.children.find(c=>c.tag==='button')||this.children.flatMap(c=>c.children||[]).find(c=>c.tag==='button');}};
  nodes.push(node);return node;
 },addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn)};
 document.body={appendChild(){}};
 const source=await inlineModule();
 const ask=instantiate(extractFunction(source,'askChoice'),'askChoice',{document,choiceStack:[],requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout});
 let secondSettled=false;
 const first=ask({title:'A',choices:[{label:'Allow once A',value:'once'}]});
 const second=ask({title:'B',choices:[{label:'Allow once B',value:'once'}]}).then(value=>{secondSettled=true;return value;});
 nodes.find(n=>n.textContent==='Allow once A').onclick();assert.equal(await first,'once');
 assert.equal(secondSettled,false);assert.equal(listeners.size,1);
 nodes.find(n=>n.textContent==='Allow once B').onclick();assert.equal(await second,'once');assert.equal(listeners.size,0);
});

test('failed follow-ups retain stable failure evidence across migration, hold, retry, and removal',async()=>{
 const {enqueue,failDispatch,nextDispatch,retryDispatch,migrateQueue,removeEntry}=await import('../sys/ai/followup-queue.mjs');
 let queue=enqueue([],'poison').queue;const id=queue[0].id;
 for(let i=1;i<=4;i++){
  queue=failDispatch(queue,id,'failure '+i);
  queue=migrateQueue(JSON.parse(JSON.stringify(queue))).queue;
  assert.equal(queue[0].id,id);assert.equal(queue[0].failedStarts,i);assert.equal(queue[0].failure,'failure '+i);
  assert.equal(nextDispatch(queue,{stop:'done'}).paused,true);
  const retry=retryDispatch(queue,id);assert.equal(retry.entry.id,id);assert.equal(retry.entry.state,'dispatching');queue=retry.queue;
 }
 assert.deepEqual(removeEntry(queue,id).queue,[]);
});
test('a witnessed write followed by interruption reconciles read-only differences and refuses automatic revert',async()=>{
 const {createFileops,MemoryBackend}=await import('../sys/rig/fileops/index.mjs');
 const {createWorkspaceCapture,recoverInterruptedCapture}=await import('../sys/ai/workspace-capture.mjs');
 const {createRunRecorder,loadRecord,foldRecovery}=await import('../sys/history/run-record.mjs');
 const {planRevert}=await import('../sys/ai/change-preimages.mjs');
 const fs=createFileops({backend:new MemoryBackend()});await fs.write('agent.txt','before');await fs.write('owner.txt','owner before');
 const capture=createWorkspaceCapture(fs,9);await capture.start();const checkpoint=capture.checkpoint();
 const rec=createRunRecorder({app:'anvil',principal:'test'});await rec.start({messages:[],tools:[]});
 rec.onEvent({type:'tool-call',id:'write-once',name:'write',args:{path:'agent.txt',content:'after'},step:0});await rec.settled();
 const interrupted=rec.export();await fs.write('agent.txt','after');
 // The tab dies before tool-result and capture.observe. A concurrent owner writes separately.
 await fs.write('owner.txt','owner after');
 const result=await recoverInterruptedCapture(fs,checkpoint,9);
 assert.deepEqual(result.rows.map(row=>row.file),['agent.txt','owner.txt']);
 assert.ok(result.rows.every(row=>row.observed&&row.interrupted&&row.captureIncomplete&&row.revertUnavailable));
 assert.equal(result.rows.find(row=>row.file==='agent.txt').pre,'before');
 assert.equal(planRevert(result.rows[0],'after').ok,false);
 assert.equal((await fs.read('owner.txt',{encoding:'utf-8'})).data,'owner after');
 const loaded=loadRecord(interrupted);assert.equal((await loaded.verify()).ok,true);
 assert.ok(loaded.events().some(event=>event.tool==='tool.called'));
 assert.ok(!loaded.events().some(event=>event.tool==='tool.responded'));
 assert.ok(foldRecovery(loaded.events(),loaded.resolve));
 await assert.rejects(recoverInterruptedCapture(fs,checkpoint,10),/invalid capture checkpoint/);
});

test('legacy external backend with proven absent hooks retains ordinary tools without downloading objects',async()=>{
 let listed=0;
 const hooks=await loadHooks({read:async()=>({ok:false,code:'ENOTSUP'}),list:async(path,options)=>{listed++;assert.equal(path,'.anvil');assert.equal(options.recursive,false);assert.equal(options.maxEntries,50);return {ok:true,entries:[],truncated:false,cursor:null,snapshotConsistent:true};}});
 assert.equal(listed,1);assert.equal(preHookReply(hooks,'write',{}),null);
 const present=await loadHooks({read:async()=>({ok:false,code:'ENOTSUP'}),list:async()=>({ok:true,entries:[{name:'hooks.json',path:'.anvil/hooks.json'}]})});
 assert.match(preHookReply(present,'write',{}),/unavailable/);
});

test('Escape dismisses only the most recent competing approval',async()=>{
 const listeners=new Set();let objects=0;
 const document={activeElement:null,body:{appendChild(){}},createElement:()=>{assert.ok(++objects<100);return {appendChild(){},setAttribute(){},remove(){},focus(){},addEventListener(){},querySelector(){return null}};},addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn)};
 const source=await inlineModule();const ask=instantiate(extractFunction(source,'askChoice'),'askChoice',{document,choiceStack:[],requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout});
 let firstSettled=false;const first=ask({title:'first'}).then(value=>{firstSettled=true;return value});const second=ask({title:'second'});
 const escape={key:'Escape',preventDefault(){},stopPropagation(){},stopImmediatePropagation(){this.immediate=true;}};
 for(const fn of [...listeners]){fn(escape);if(escape.immediate)break;}
 assert.equal(await second,null);assert.equal(firstSettled,false);assert.equal(listeners.size,1);
 for(const fn of [...listeners])fn({...escape,immediate:false});assert.equal(await first,null);assert.equal(listeners.size,0);
});

test('queue migration repairs duplicate IDs without deleting sibling work',async()=>{
 const {migrateQueue,removeEntry,enqueue}=await import('../sys/ai/followup-queue.mjs');
 const q=migrateQueue([{id:'same',text:'first'},{id:'same',text:'second'},'legacy',{id:'retained',text:'third'}],{now:1}).queue;
 assert.equal(q[0].id,'same');assert.equal(q[3].id,'retained');assert.equal(new Set(q.map(e=>e.id)).size,4);
 assert.deepEqual(removeEntry(q,q[1].id).queue.map(e=>e.text),['first','legacy','third']);
 const added=enqueue(q,'fourth',{now:1});assert.equal(new Set(added.queue.map(e=>e.id)).size,5);
});
test('post-hook deadline aborts the real shell and skips subsequent writes',async()=>{
 const {createFileops,MemoryBackend}=await import('../sys/rig/fileops/index.mjs');
 const {buildRigRegistry}=await import('../sys/rig/registry/index.mjs');
 const {createGrant,createOpLog,createAgentFace}=await import('../sys/rig/agent/index.mjs');
 const {createShell}=await import('../sys/rig/cli/shell.mjs');
 const fs=createFileops({backend:new MemoryBackend()});const registry=buildRigRegistry({fs});
 const grant=createGrant({prefixes:[''],scopes:['fs:read','fs:write','fs:remove']});
 const face=createAgentFace({registry,grant,opLog:createOpLog({fs:createFileops({backend:new MemoryBackend()})}),actor:'agent'});
 const hooks=parseHooks(JSON.stringify({postTool:[{run:'sleep 2'},{run:'echo late > late.txt'}]}));
 const started=Date.now();
 const notes=await postHookNotes(hooks,'write',{},({signal})=>createShell({registry,face,signal}),{commandMs:10});
 assert.match(notes,/execution deadline/);assert.match(notes,/remaining hooks skipped/);
 assert.ok(Date.now()-started<1000);assert.equal((await fs.read('late.txt')).ok,false);
});
test('post-hook deadline releases a backend that ignores cancellation with explicit uncertainty',async()=>{
 let calls=0,signal;
 const hooks=parseHooks(JSON.stringify({postTool:[{run:'ignored'},{run:'next'}]}));
 const notes=await postHookNotes(hooks,'write',{},options=>{signal=options.signal;return {feed(){calls++;return new Promise(()=>{});}};},{commandMs:10});
 assert.equal(calls,1);assert.equal(signal.aborted,true);assert.match(notes,/pending effects may remain uncertain/);
});

test('record reservations serialize competing names and refuse exhausted collisions',async()=>{
 const {createFileops,MemoryBackend}=await import('../sys/rig/fileops/index.mjs');
 const store=createFileops({backend:new MemoryBackend()});let tail=Promise.resolve();
 const locks={request(name,options,work){const result=tail.then(work);tail=result.catch(()=>{});return result;}};
 const ids=['a','a','b'];const FixedDate=class extends Date{constructor(){super('2026-10-06T00:00:00Z')}};
 const allocate=instantiate(extractFunction(await inlineModule(),'allocateRunRecordName'),'allocateRunRecordName',{
  navigator:{locks},AbortSignal,Date:FixedDate,crypto:{randomUUID:()=>ids.shift()||'a'},createOpfsBackend:async()=>null,createFileops:()=>store,
 });
 const names=await Promise.all([allocate('p','t'),allocate('p','t')]);assert.notEqual(names[0],names[1]);
 assert.equal((await store.read(names[0],{encoding:'utf-8'})).data,'reserved');
 await assert.rejects(allocate('p','t'),/collision limit/);
});

test('approval cancellation dismisses only its own prompt',async()=>{
 const listeners=new Set();const document={activeElement:null,body:{appendChild(){}},createElement:()=>({appendChild(){},setAttribute(){},remove(){},focus(){},addEventListener(){},querySelector(){return null}}),addEventListener:(name,fn)=>listeners.add(fn),removeEventListener:(name,fn)=>listeners.delete(fn)};
 const ask=instantiate(extractFunction(await inlineModule(),'askChoice'),'askChoice',{document,choiceStack:[],requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout});
 const firstController=new AbortController(),secondController=new AbortController();let secondSettled=false;
 const first=ask({title:'first',signal:firstController.signal});const second=ask({title:'second',signal:secondController.signal}).then(value=>{secondSettled=true;return value});
 firstController.abort();assert.equal(await first,'__aborted__');assert.equal(secondSettled,false);assert.equal(listeners.size,1);
 secondController.abort();assert.equal(await second,'__aborted__');assert.equal(listeners.size,0);
});


test('workspace capture requests bounded immediate pages and traverses nested files without an unbounded fallback',async()=>{
 const {createFileops,MemoryBackend}=await import('../sys/rig/fileops/index.mjs');
 const {snapshotWorkspace}=await import('../sys/ai/workspace-capture.mjs');
 const fs=createFileops({backend:new MemoryBackend()});
 for(let i=0;i<600;i++)await fs.write('nested/item-'+String(i).padStart(3,'0'),'owner '+i);
 const calls=[];
 const guarded={...fs,list:async(path,options)=>{calls.push({path,options});assert.equal(options.recursive,false);assert.equal(options.maxEntries,256);return fs.list(path,options);}};
 const result=await snapshotWorkspace(guarded);
 assert.equal(result.complete,true,result.problems.join('; '));assert.equal(result.files.size,601);
 assert.equal(calls.filter(call=>call.path==='nested').length,3);
 assert.ok(calls.some(call=>typeof call.options.cursor==='string'));
 const limited=await snapshotWorkspace(guarded,{fileLimit:1});
 assert.equal(limited.listed,false);assert.equal(limited.files.size,1);
});
test('bounded listing cursors refuse concurrent mutation and live pages cannot certify absence',async()=>{
 const {createFileops,MemoryBackend}=await import('../sys/rig/fileops/index.mjs');
 const {snapshotWorkspace,compareSnapshots}=await import('../sys/ai/workspace-capture.mjs');
 const fs=createFileops({backend:new MemoryBackend()});
 for(let i=0;i<270;i++)await fs.write('item-'+i,'before');
 let calls=0;
 const changing={...fs,list:async(path,options)=>{const page=await fs.list(path,options);if(++calls===1)await fs.write('new-owner','owner');return page;}};
 const result=await snapshotWorkspace(changing);
 assert.equal(result.listed,false);assert.equal(result.complete,false);assert.equal(calls,2);
 const live=await snapshotWorkspace({list:async()=>({ok:true,entries:[{path:'known',type:'file'}],snapshotConsistent:false}),read:async()=>({ok:true,data:new TextEncoder().encode('known')})});
 assert.equal(live.listed,false);assert.equal(live.files.get('known').text,'known');
 const diff=compareSnapshots(live,{files:new Map([['unseen',{known:true,hash:'new'}]]),listed:true});
 assert.ok(diff.unknown.includes('unseen'));assert.ok(!diff.changed.some(row=>row.path==='unseen'));
});
test('workspace metadata and read responses refuse oversized or malformed input before checkpoint serialization',async()=>{
 const {snapshotWorkspace,captureTextWithinBound,decodeCaptureCheckpoint}=await import('../sys/ai/workspace-capture.mjs');
 let reads=0;
 for(const entry of [{path:'x'.repeat(4097),type:'file'},{path:'../outside',type:'file'},{path:'nested/deep',type:'file'},...['symlink',null].map(type=>({path:'bad',type}))]){
  const result=await snapshotWorkspace({list:async()=>({ok:true,entries:[entry],snapshotConsistent:true}),read:async()=>{reads++;throw new Error('unexpected');}});
  assert.equal(result.complete,false);assert.equal(result.files.size,0);
 }
 assert.equal(reads,0);
 const hugePage=await snapshotWorkspace({list:async()=>({ok:true,entries:Array(257).fill({path:'f',type:'file'}),snapshotConsistent:true})});
 assert.equal(hugePage.files.size,0);
 const excessRead=await snapshotWorkspace({list:async()=>({ok:true,entries:[{path:'small',type:'file'}],snapshotConsistent:true}),read:async()=>({ok:true,data:new Uint8Array(5)})},{readLimit:4});
 assert.equal(excessRead.files.get('small').known,false);
 assert.equal(captureTextWithinBound('ह'.repeat(3),8),false);assert.equal(captureTextWithinBound('ह'.repeat(3),9),true);
 assert.equal(captureTextWithinBound('😀',4),true);assert.equal(captureTextWithinBound('😀',3),false);
 assert.throws(()=>decodeCaptureCheckpoint('ह'.repeat(23000000),9),/exceeds bound/);
});

test('workspace metadata budget stops traversal while preserving observed entries as incomplete',async()=>{
 const {snapshotWorkspace,createWorkspaceCapture}=await import('../sys/ai/workspace-capture.mjs');
 let calls=0;
 const fs={list:async(path,{cursor})=>{calls++;const start=cursor?Number(cursor):0;return {ok:true,entries:Array.from({length:256},(_,i)=>({path:String(start+i).padStart(4,'0')+'x'.repeat(1500),type:'file'})),truncated:true,cursor:String(start+256),snapshotConsistent:true};},read:async()=>({ok:true,data:new Uint8Array(0)})};
 const result=await snapshotWorkspace(fs);
 assert.equal(calls,1);assert.equal(result.listed,false);assert.ok(result.files.size>0&&result.files.size<256);
 assert.ok(result.problems.some(problem=>/metadata/.test(problem)));
 assert.throws(()=>createWorkspaceCapture(fs,'x'.repeat(100000)),/invalid capture run/);
});


test('interrupted recovery persists the full unknown report before publishing rows and retries a failed report',async()=>{
 const source=await inlineModule();
 const cap={status:'interrupted',run:2,browserProject:true,project:'p',workspace:'Browser · P',checkpoint:{id:'a'.repeat(32),hash:'b'.repeat(64)}};
 const task={changeCapture:cap,log:[]},state={activeProject:'p',projects:[{id:'p',tasks:[task]}]},fs={};
 const unknown=Array.from({length:180},(_,i)=>'unknown-'+i);let writes=0,allow=false,report;
 const store={read:async name=>({ok:true,data:name===cap.checkpoint.id+'.json'?'checkpoint':report.text}),write:async(name,text)=>{writes++;report={name,text};return {ok:allow};}};
 const ctx={state,fs,workspaceLabel:'Browser · P',recoveringCaptures:new WeakSet(),createFileops:()=>store,createOpfsBackend:async()=>({}),CAPTURE_CHECKPOINT_LIMIT:64*1024*1024,
  crypto:globalThis.crypto,captureCheckpointHash:async()=>cap.checkpoint.hash,recoverInterruptedCapture:async()=>({rows:[{k:'change',file:'known',revertUnavailable:true}],netUnknown:unknown,problems:['uncertain']}),prunePreimages:log=>({log}),save(){}};
 const recover=instantiate(extractFunction(source,'recoverInterruptedProject'),'recoverInterruptedProject',ctx);
 await recover();assert.equal(cap.status,'interrupted');assert.equal(cap.recoveryAttempted,false);assert.equal(cap.unknownReportPending,true);
 assert.equal(task.log.filter(row=>row.k==='change').length,0);assert.equal(cap.unknownPathReport,undefined);
 allow=true;await recover();assert.equal(writes,2);assert.equal(cap.status,'recovered');assert.equal(cap.unknownReportPending,false);
 assert.equal(task.log.filter(row=>row.k==='change').length,1);assert.equal(cap.unknownPathReport.count,180);
 assert.deepEqual(JSON.parse(report.text).paths,unknown);await recover();assert.equal(writes,2);
});
test('recovery report completion cannot publish into a switched workspace or duplicate a concurrent recovery',async()=>{
 const source=await inlineModule();
 const cap={status:'interrupted',run:2,browserProject:true,project:'p',workspace:'Browser · P',checkpoint:{id:'a'.repeat(32),hash:'b'.repeat(64)}};
 const task={changeCapture:cap,log:[]},state={activeProject:'p',projects:[{id:'p',tasks:[task]}]},fs={};
 let release,entered,reads=0;const reached=new Promise(resolve=>entered=resolve);
 let reportText;const store={read:async name=>{if(name===cap.checkpoint.id+'.json'){reads++;return {ok:true,data:'checkpoint'};}return {ok:true,data:reportText};},write:async(name,text)=>{reportText=text;entered();await new Promise(resolve=>release=resolve);return {ok:true};}};
 const ctx={state,fs,workspaceLabel:'Browser · P',recoveringCaptures:new WeakSet(),createFileops:()=>store,createOpfsBackend:async()=>({}),CAPTURE_CHECKPOINT_LIMIT:64*1024*1024,
  crypto:globalThis.crypto,captureCheckpointHash:async()=>cap.checkpoint.hash,recoverInterruptedCapture:async()=>({rows:[{k:'change',file:'known'}],netUnknown:['unknown'],problems:[]}),prunePreimages:log=>({log}),save(){}};
 const recover=instantiate(extractFunction(source,'recoverInterruptedProject'),'recoverInterruptedProject',ctx);
 const first=recover();await reached;await recover();assert.equal(reads,1);state.activeProject='other';release();await first;
 assert.equal(cap.status,'interrupted');assert.equal(task.log.length,0);assert.equal(ctx.recoveringCaptures.has(cap),false);
});

test('capture metadata uses a conservative JSON budget for escaped and multibyte paths',async()=>{
 const {snapshotWorkspace}=await import('../sys/ai/workspace-capture.mjs');
 for(const letter of ['"','ह']){
  const entries=Array.from({length:200},(_,i)=>({path:String(i).padStart(3,'0')+letter.repeat(1000),type:'file'}));
  const result=await snapshotWorkspace({list:async()=>({ok:true,entries,snapshotConsistent:true}),read:async()=>({ok:true,data:new Uint8Array(0)})});
  assert.equal(result.complete,false);assert.ok(result.files.size<200);assert.ok(result.problems.some(problem=>/metadata/.test(problem)));
 }
});

test('hook byte accounting precedes encoding and shell escaping while Unicode notes obey the byte limit',async()=>{
 const {utf8ByteLengthWithin,utf8Prefix}=await import('../sys/ai/text-byte-bound.mjs');
 assert.equal(utf8ByteLengthWithin('😀ह',7),7);assert.equal(utf8ByteLengthWithin('😀ह',6),null);assert.equal(utf8Prefix('😀ह',6),'😀');
 const original=globalThis.TextEncoder;
 try{
  globalThis.TextEncoder=class{encode(){throw new Error('unexpected encoded allocation');}};
  assert.equal(preToolDecision(parseHooks(JSON.stringify({postTool:[{run:'ह'.repeat(1500)}]})),'write',{}).blocked,true);
  assert.throws(()=>hookCommand({run:'echo {file}'},{path:"ह'".repeat(1000)}),/substitution.*bound/);
 }finally{globalThis.TextEncoder=original;}
 const cfg=parseHooks(JSON.stringify({postTool:Array.from({length:16},()=>({run:'echo ok'}))}));
 const notes=await postHookNotes(cfg,'write',{},()=>({feed:async()=>({output:'😀'.repeat(2000)})}));
 assert.ok(new TextEncoder().encode(notes).length<=HOOK_LIMITS.notesBytes);
});
test('queued Retry uses the same acknowledgement contract as Send before claiming the stable entry',async()=>{
 const {admitRun,retryDispatch}=await import('../sys/ai/followup-queue.mjs');
 const task={queued:[{id:'held',text:'follow-up',state:'pending',failedStarts:1}],lastStop:'error',status:'error'};let started=0;
 const ctx={activeTask:()=>task,running:false,priming:false,state:{runsHeld:false},pushSystem(){},save(){},renderLog(){},admitRun,retryDispatch,startQueuedEntry(t,e){assert.equal(e.id,'held');started++;}};
 const retry=instantiate(extractFunction(await inlineModule(),'retryQueuedEntry'),'retryQueuedEntry',ctx);
 retry(task,'held');assert.equal(started,0);assert.equal(task.queued[0].state,'pending');assert.equal(task.ackAfterBadRun,true);
 retry(task,'held');assert.equal(started,1);assert.equal(task.queued[0].state,'dispatching');assert.equal(task.ackAfterBadRun,false);
});
test('successful report write without matching readback leaves interrupted evidence retryable',async()=>{
 const source=await inlineModule();const cap={status:'interrupted',run:2,browserProject:true,project:'p',workspace:'Browser · P',checkpoint:{id:'a'.repeat(32),hash:'b'.repeat(64)}};
 const task={changeCapture:cap,log:[]},state={activeProject:'p',projects:[{id:'p',tasks:[task]}]},fs={};
 const store={read:async name=>({ok:true,data:name===cap.checkpoint.id+'.json'?'checkpoint':'stale report'}),write:async()=>({ok:true})};
 const ctx={state,fs,workspaceLabel:'Browser · P',recoveringCaptures:new WeakSet(),crypto:globalThis.crypto,createFileops:()=>store,createOpfsBackend:async()=>({}),CAPTURE_CHECKPOINT_LIMIT:64*1024*1024,captureCheckpointHash:async()=>cap.checkpoint.hash,
 recoverInterruptedCapture:async()=>({rows:[{k:'change',file:'known'}],netUnknown:['unknown'],problems:[]}),prunePreimages:log=>({log}),save(){}};
 await instantiate(extractFunction(source,'recoverInterruptedProject'),'recoverInterruptedProject',ctx)();
 assert.equal(cap.status,'interrupted');assert.equal(cap.recoveryAttempted,false);assert.equal(cap.unknownPathReport,undefined);assert.equal(task.log.some(row=>row.k==='change'),false);
});

test('hook absence cannot be inferred from truncated, live, malformed, or excessive bounded pages',async()=>{
 for(const listing of [
  {ok:true,entries:[],truncated:true,cursor:'hidden-next-page',snapshotConsistent:false},
  {ok:true,entries:[],truncated:false,cursor:null,snapshotConsistent:false},
  {ok:true,entries:[],truncated:false,cursor:'unexpected',snapshotConsistent:true},
  {ok:true,entries:[{path:'elsewhere',type:'file'}],truncated:false,cursor:null,snapshotConsistent:true},
  {ok:true,entries:Array(51).fill({path:'.anvil/other',type:'file'}),truncated:false,cursor:null,snapshotConsistent:true},
 ]){
  const hooks=await loadHooks({read:async()=>({ok:false,code:'ENOTSUP'}),list:async(path,options)=>{assert.equal(path,'.anvil');assert.equal(options.maxEntries,50);return listing;}});
  assert.match(preHookReply(hooks,'write',{}),/unavailable.*ENOTSUP/);
 }
});
