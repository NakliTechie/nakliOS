const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
async function until(fn,label){const end=Date.now()+30000;while(Date.now()<end){const value=await fn();if(value)return value;await wait(30);}throw Error('Timed out: '+label)}
async function frame(query){const iframe=document.createElement('iframe');iframe.style='width:1280px;height:800px';iframe.src='/apps/anvil/index.html?anviltest&'+query;document.body.append(iframe);await until(()=>iframe.contentWindow?.__anvilBoot?.ok,'full module boot');return iframe;}
const state=win=>JSON.parse(win.localStorage.getItem('anvil-state-v1'));
function resetCase(permissionRules={allow:[],deny:[],ask:[]}){const snapshot=state(window),task=snapshot.projects[0].tasks[0];snapshot.activeProject=snapshot.projects[0].id;snapshot.activeTask=task.id;snapshot.permissionRules=permissionRules;task.status='idle';task.lastStop=null;task.log=[];task.convo=[];task.queued=[];delete task.changeCapture;localStorage.setItem('anvil-state-v1',JSON.stringify(snapshot));}
export async function runA03Cases(){
 const largeStart=performance.now(),large=await frame('measurement');const win=large.contentWindow,doc=win.document;
 const bootMs=performance.now()-largeStart;assert(win.__A03.fixtureBytes===10*1024*1024,'exact ten-megabyte fixture');
 const heapBefore=win.performance.memory?.usedJSHeapSize??null;
 const wrap=doc.querySelector('#log .wrap');assert(wrap?.children.length===600,'all fixture rows render');
 const opened=wrap.children[10];opened.open=true;await wait(50);
 const samples=[];
 for(let i=0;i<30;i++){const start=performance.now();win.__anvil.test.logRow(300,{k:'subagent',kind:'dispatch',label:'fleet',status:'running',steps:i,tools:1,age:i});samples.push(performance.now()-start);}
 assert(doc.querySelector('#log .wrap')===wrap,'fleet updates retain wrapper');assert(wrap.children[10]===opened&&opened.open,'open details survive fleet updates');
 const sorted=[...samples].sort((a,b)=>a-b);
 const rebuildSamples=[];
 const select=tid=>new Promise((resolve,reject)=>{
  const started=performance.now(),timer=setTimeout(()=>{observer.disconnect();reject(Error('task switch deadline'))},5000);
  const observer=new MutationObserver(()=>{
   if(doc.querySelector('.task.active')?.dataset.navkey!=='t:'+tid)return;
   const rendered=doc.querySelector('#log .wrap');if(tid==='a03-task'&&rendered?.children.length!==600)return;
   if(tid==='a03-other'&&rendered)return;
   clearTimeout(timer);observer.disconnect();resolve(performance.now()-started);
  });observer.observe(doc.body,{childList:true,subtree:true,attributes:true});
  doc.querySelector('[data-navkey="t:'+tid+'"]').click();
 });
 for(let i=0;i<30;i++){await select('a03-other');rebuildSamples.push(await select('a03-task'));}
 const rebuildSorted=[...rebuildSamples].sort((a,b)=>a-b);
 assert(doc.querySelector('#log .wrap').children[10].open,'open details also survive a full task-switch rebuild');
 // Compare the policy's built rows with the actual task-switch rebuild above.
 const keys=await import('/sys/ai/log-render-plan.mjs');
 const rowFixture=Array.from({length:600},(_,i)=>({k:'tool',name:'read',result:'result '+i}));
 const before=keys.rowKeys(rowFixture);rowFixture[300]={k:'subagent',steps:1};const changed=keys.rowKeys(rowFixture);
 const patch=keys.planLogUpdate(before,changed),rebuild=keys.planLogUpdate(null,changed);
 assert(patch.mode==='patch'&&patch.built===1&&rebuild.built===600,'measured row policy remains targeted');
 // The UI action uses the app's real save/debounce/host-state writer.
 doc.getElementById('mode-btn')?.click();
 await until(()=>win.__A03.stateWrites>0,'whole-state host save');
 const measurement={fixtureBytes:win.__A03.fixtureBytes,bootMs,patchMedianMs:sorted[15],patchMaxMs:sorted.at(-1),rebuildMedianMs:rebuildSorted[15],rebuildMaxMs:rebuildSorted.at(-1),patchRows:patch.built,rebuildRows:rebuild.built,
  heapBefore,heapAfter:win.performance.memory?.usedJSHeapSize??null,readBytes:win.__A03.readBytes,writeBytes:win.__A03.writeBytes,stateWrites:win.__A03.stateWrites,
  writeAmplification:win.__A03.writeBytes/win.__A03.fixtureBytes,platform:'native Chrome; offline finite host fixture',providerCalls:0};
 large.remove();
 // Clear only this disposable profile's fixture cache before the Browser-project leg.
 localStorage.removeItem('anvil-state-v1');
 const recovery=await frame('recovery'),rw=recovery.contentWindow;
 await rw.__anvil.test.fs.write('agent.txt','before');await rw.__anvil.test.fs.write('owner.txt','owner before');await rw.__anvil.test.fs.write('large.txt','z'.repeat(70000));
 rw.document.getElementById('prompt').value='Write agent.txt to after';rw.document.getElementById('send').click();
 await until(async()=>{const read=await rw.__anvil.test.fs.read('agent.txt');return read?.data==='after'},'real recorded tool write');
 const beforeDeath=state(rw),task=beforeDeath.projects[0].tasks[0];
 assert(task.status==='running','tab dies during unfinished run');assert(task.changeCapture.checkpoint&&task.changeCapture.record,'checkpoint and pending run prefix persist');
 await rw.__anvil.test.fs.write('owner.txt','owner after');
 recovery.remove();
 const parked=state(window);parked.projects.push({id:'inactive-boot',name:'Other project',open:true,tasks:[{id:'inactive-task',title:'Other task',status:'idle',log:[],queued:[],convo:[]}]});parked.activeProject='inactive-boot';parked.activeTask='inactive-task';localStorage.setItem('anvil-state-v1',JSON.stringify(parked));
 const reloaded=await frame('recovery');
 assert(state(reloaded.contentWindow).projects[0].tasks[0].changeCapture.status==='interrupted','inactive project stays interrupted before its mount');
 reloaded.contentWindow.document.querySelector('[data-navkey="t:a03-task"]').click();
 await until(()=>state(reloaded.contentWindow).projects[0].tasks[0].changeCapture.status==='recovered','non-active project recovers when mounted');
 const after=state(reloaded.contentWindow),restored=after.projects[0].tasks[0];
 assert(restored.changeCapture.status==='recovered','actual browser reload reconciles');
 assert(restored.changeCapture.netUnknownCount===1 && restored.changeCapture.netUnknown[0]==='large.txt','unknown path survives recovery metadata');
 assert(restored.log.some(row=>row.text?.includes('Unresolved interrupted paths (1): large.txt')),'unknown path remains visible');
 const rows=restored.log.filter(row=>row.k==='change'&&row.interrupted);
 assert(rows.some(row=>row.file==='agent.txt'&&row.pre==='before'),'agent difference retains preimage');
 assert(rows.some(row=>row.file==='owner.txt'),'owner difference remains observed');assert(rows.every(row=>row.captureIncomplete&&row.revertUnavailable),'recovery disables automatic revert');
 const owner=await reloaded.contentWindow.__anvil.test.fs.read('owner.txt');assert(owner.data==='owner after','recovery preserves concurrent owner bytes');
 assert(reloaded.contentWindow.__A03.inferenceCalls===0,'reload never replays inference');
 const {createOpfsBackend}=await import('/sys/rig/fileops/opfs.mjs');const {createFileops}=await import('/sys/rig/fileops/index.mjs');
 const {loadRecord}=await import('/sys/history/run-record.mjs');
 const store=createFileops({backend:await createOpfsBackend({path:'anvil/runs/a03-project/a03-task'})});
 const saved=await store.read(task.changeCapture.record.name,{encoding:'utf-8',maxBytes:1024*1024});assert(saved.ok,'pending record reads');
 const record=loadRecord(JSON.parse(saved.data));assert((await record.verify()).ok,'pending record chain verifies');assert(record.events().some(event=>event.tool==='tool.called'),'pending record contains witnessed invocation');
 const unknownStore=createFileops({backend:await createOpfsBackend({path:'anvil/captures'})});
 const unknown=await unknownStore.read(restored.changeCapture.unknownPathReport.name,{encoding:'utf-8',maxBytes:1024*1024});assert(unknown.ok&&JSON.parse(unknown.data).paths.includes('large.txt'),'full unknown-path report persists');
 const result={measurement,recovery:{rows:rows.map(row=>({file:row.file,pre:row.pre,revertUnavailable:row.revertUnavailable})),chainVerified:true,automaticReplay:false,ownerBytesPreserved:true,unknownPaths:['large.txt'],providerCalls:0,inactiveProjectRecovered:true}};
 reloaded.remove();
 resetCase();const failed=await frame('recovery&checkpoint-failure'),fw=failed.contentWindow;await fw.__anvil.test.fs.write('agent.txt','frozen');
 const originalGet=fw.FileSystemDirectoryHandle.prototype.getFileHandle;
 fw.FileSystemDirectoryHandle.prototype.getFileHandle=function(name,options){if(/^[a-f0-9]{32}\.json$/.test(name)&&options?.create)throw Error('synthetic checkpoint persistence denial');return originalGet.call(this,name,options);};
 fw.document.getElementById('prompt').value='Write agent.txt to after';fw.document.getElementById('send').click();
 await until(()=>fw.document.body.textContent.includes('Run startup refused: synthetic checkpoint persistence denial'),'failed checkpoint refuses actual tool');
 assert((await fw.__anvil.test.fs.read('agent.txt')).data==='frozen','checkpoint failure prevents workspace write');
 assert(fw.__A03.inferenceCalls===0 && fw.document.getElementById('stop').hidden && fw.document.getElementById('send').textContent==='Send','checkpoint failure prevents inference and resets run UI');
 result.checkpointFailure={toolRefused:true,bytesPreserved:true,inferenceCalls:0,runningCleared:true};failed.remove();
 resetCase();const denied=await frame('recovery&reservation-failure'),dw=denied.contentWindow;
 await dw.__anvil.test.fs.write('agent.txt','reservation frozen');
 const request=dw.navigator.locks.request.bind(dw.navigator.locks);
 dw.navigator.locks.request=(name,...args)=>String(name).startsWith('anvil-record-reservation:')?Promise.reject(Error('synthetic reservation denial')):request(name,...args);
 dw.document.getElementById('prompt').value='Write agent.txt to after';dw.document.getElementById('send').click();
 await until(()=>dw.document.body.textContent.includes('Run startup refused: synthetic reservation denial'),'reservation failure resets real run');
 assert(dw.document.getElementById('stop').hidden,'reservation failure clears Stop UI');
 assert(dw.document.getElementById('send').textContent==='Send','reservation failure clears running state');
 assert(state(dw).projects[0].tasks[0].status==='error','reservation failure persists task error');
 assert(dw.__A03.inferenceCalls===0,'reservation failure precedes inference');
 assert((await dw.__anvil.test.fs.read('agent.txt')).data==='reservation frozen','reservation failure preserves bytes');
 result.reservationFailure={runningCleared:true,providerCalls:0,bytesPreserved:true};denied.remove();
 resetCase({allow:[],deny:['Bash(echo:*)'],ask:[]});const hooked=await frame('recovery&hook-policy'),hw=hooked.contentWindow;
 const hooks=JSON.stringify({postTool:[{on:'write',run:'echo hook-effect > hook-effect.txt'}]});
 await hw.__anvil.test.fs.write('.anvil/hooks.json',hooks);await hw.__anvil.test.fs.remove('hook-effect.txt');
 hw.document.getElementById('prompt').value='Write agent.txt to after';hw.document.getElementById('send').click();
 await until(()=>hw.__A03.inferenceCalls>=2,'normal write completes its denied hook');
 assert((await hw.__anvil.test.fs.read('agent.txt')).data==='after','ordinary write succeeds');
 assert(!(await hw.__anvil.test.fs.read('hook-effect.txt')).ok,'owner deny rule also blocks hook shell');
 assert(hw.document.body.textContent.includes('a deny rule matches (Bash(echo:*))'),'hook reports the normal deny reason');
 hw.document.getElementById('stop').click();hooked.remove();
 resetCase();const refusal=await frame('recovery&hook-refusal'),pw=refusal.contentWindow;
 await pw.__anvil.test.fs.write('.anvil/hooks.json',hooks);await pw.__anvil.test.fs.remove('hook-effect.txt');
 pw.document.getElementById('prompt').value='Write the hook config';pw.document.getElementById('send').click();
 await until(()=>pw.__A03.inferenceCalls>=2,'agent hook-config write is refused');
 assert((await pw.__anvil.test.fs.read('.anvil/hooks.json')).data===hooks,'agent cannot overwrite owner hooks');
 assert(!(await pw.__anvil.test.fs.read('hook-effect.txt')).ok,'a refused write never launches post-hooks');
 pw.document.getElementById('stop').click();refusal.remove();
 result.hookAuthority={ownerRulesPreserved:true,agentConfigWriteRefused:true,postHooksSkippedAfterRefusal:true};return result;
}
