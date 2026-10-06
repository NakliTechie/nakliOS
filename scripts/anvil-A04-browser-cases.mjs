const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const assert=(value,message)=>{if(!value)throw Error(message)};
async function until(fn,label){const end=Date.now()+240000;while(Date.now()<end){const result=await fn();if(result)return result;await wait(30);}throw Error('Timed out: '+label)}
const exportedRecords={};
const cached=win=>JSON.parse(win.localStorage.getItem('anvil-state-v1'));
async function frame(mode,{fresh=false}={}){
 if(fresh)localStorage.removeItem('anvil-state-v1');
 const node=document.createElement('iframe');node.src='/apps/anvil/index.html?anviltest&case='+mode;node.style='width:1280px;height:800px';document.body.append(node);
 await until(()=>node.contentWindow?.__anvilBoot?.ok,'unchanged full module boot');return node;
}
async function seed(win){for(const [path,text] of Object.entries(await (await fetch('/fixtures')).json())){if(!path.startsWith('comment-'))await win.__anvil.test.fs.write(path,text);}}
async function records(mode){
 const {createFileops}=await import('/sys/rig/fileops/index.mjs'),{createOpfsBackend}=await import('/sys/rig/fileops/opfs.mjs'),{loadRecord}=await import('/sys/history/run-record.mjs');
 const fs=createFileops({backend:await createOpfsBackend({path:'anvil/runs/a04-'+mode+'/a04-'+mode+'-task'})});const listed=await fs.list('',{recursive:false,maxEntries:100});assert(listed.ok&&!listed.truncated,'bounded private record inventory');
 const rows=[],dumps=[];let bytes=0;for(const entry of listed.entries){if(entry.type!=='file'||!entry.path.endsWith('.json'))continue;const read=await fs.read(entry.path,{encoding:'utf-8',maxBytes:8*1024*1024});assert(read.ok,'bounded private record read');bytes+=new TextEncoder().encode(read.data).length;assert(bytes<=2*1024*1024,'exported record bytes bound');const dump=JSON.parse(read.data);dumps.push({file:entry.path,dump});const record=loadRecord(dump);assert((await record.verify()).ok,'run chain verifies');rows.push(record);}
 assert(rows.length>0,'at least one durable run chain');exportedRecords[mode]=dumps;return rows;
}
async function facts(win){const listed=await win.__anvil.test.fs.list('.anvil/memory');if(!listed.ok)return [];const out=[];for(const row of listed.entries){if(row.type==='file'&&row.path.endsWith('.md')&&!row.path.endsWith('/hindsight.md')){const read=await win.__anvil.test.fs.read(row.path);assert(read.ok,'fact reads');out.push({path:row.path,text:read.data});}}return out;}
async function workspaceBytes(win){
 const result=await win.__anvil.test.fs.list('',{recursive:true});assert(result.ok&&!result.truncated&&result.entries.length<=100,'finite fixture workspace');const out={};
 for(const row of result.entries){if(row.type==='file'){const read=await win.__anvil.test.fs.read(row.path,{encoding:'utf-8',maxBytes:65536});assert(read.ok,'fixture file bound');out[row.path]=read.data;}}return out;
}
const primeFinished=win=>cached(win).projects[0].tasks[0].log.some(row=>row.text?.startsWith('Priming record '))&&win.document.getElementById('stop').hidden;
export async function runA04Cases(){
 const results={};
 const survey=await frame('survey',{fresh:true}),sw=survey.contentWindow;await seed(sw);
 const sourceBefore=(await sw.__anvil.test.fs.read('src/counter.js')).data;
 sw.document.getElementById('learn-btn').click();await until(()=>primeFinished(sw),'grounded survey completion');
 const proposed=await facts(sw);assert(proposed.length>0,'survey proposes grounded facts');
 for(const fact of proposed){assert(/status: hypothesis/.test(fact.text),'survey does not activate proposals');assert(fact.text.includes('Learning model:'),'model attribution persists');
  const line=fact.text.split('\n').find(row=>row.startsWith('Source spans (one-based inspected coordinates): '));assert(line,'inspectable source coordinates persist');
  for(const span of JSON.parse(line.split(': ').slice(1).join(': '))){const source=await sw.__anvil.test.fs.read(span.path);assert(source.ok,'citation resolves to its source');const quoted=source.data.split('\n').slice(span.startLine-1,span.endLine).join('\n');assert(quoted.includes(span.quote),'quoted evidence resolves at its recorded coordinates');}
 }
 assert((await sw.__anvil.test.fs.read('src/counter.js')).data===sourceBefore,'survey preserves source bytes');const surveyMetrics={...sw.__A04,release:undefined};await records('survey');survey.remove();
 const surveyReload=await frame('survey');assert((await facts(surveyReload.contentWindow)).length===proposed.length,'hypotheses survive full reload');surveyReload.remove();
 results.survey={facts:proposed.length,proposals:proposed,sourceBytesPreserved:true,hypothesesSurviveReload:true,chainVerified:true,providerCalls:surveyMetrics.providerCalls};
 const hindsight=await frame('hindsight',{fresh:true}),hw=hindsight.contentWindow;await seed(hw);await hw.__anvil.test.fs.write('.anvil/memory/hindsight.md','---\nstatus: hypothesis\n---\nUnobserved hindsight claim.\n');
 hw.document.getElementById('learn-btn').click();await until(()=>primeFinished(hw),'hindsight refusal');assert((await facts(hw)).length===0,'memory cannot cite itself as observed project evidence');assert(hw.document.body.textContent.includes('Insufficient evidence:'),'zero grounded facts reports insufficient evidence');await records('hindsight');hindsight.remove();results.hindsight={proposals:0,insufficientEvidence:true,chainVerified:true,providerCalls:0};
 const delayed=await frame('delay',{fresh:true}),dw=delayed.contentWindow;await seed(dw);dw.document.getElementById('learn-btn').click();await until(()=>dw.__A04.pending,'inference response held before remember execution');
 dw.document.getElementById('stop').click();dw.__A04.release();await until(()=>primeFinished(dw),'Stop settles learning');assert((await facts(dw)).length===0,'delayed response writes no fact after Stop');
 const delayedRecords=await records('delay');assert(delayedRecords.some(rec=>rec.events().some(event=>event.tool==='run.stopped'&&rec.resolve(event).output?.stop==='aborted')),'aborted stop survives verified chain');const delayedCalls=dw.__A04.providerCalls;delayed.remove();
 const delayReload=await frame('delay');assert((await facts(delayReload.contentWindow)).length===0,'reload cannot promote a late proposal');await records('delay');delayReload.remove();results.delayedStop={lateFactWrites:0,latePromotions:0,abortedChainSurvivesReload:true,providerCalls:delayedCalls};
 const initial=await frame('comments',{fresh:true}),iw=initial.contentWindow;
 const fixtures=await(await fetch('/fixtures')).json();await iw.__anvil.test.fs.write('comments.md',fixtures['comment-before.md']);
 const gate=iw.__anvil.test.setGate('test "$(grep -c \'^LIVE_CHECK_B01_20261001$\' comments.md)" = "1"');assert(gate.ok,'owner marker-count base gate sets');
 const {digest}=await import('/sys/ai/change-preimages.mjs'),{reviewVersion}=await import('/sys/ai/review-diff.mjs');
 const current=cached(iw),task=current.projects[0].tasks[0];task.runSeq=1;task.log=[{k:'change',file:'comments.md',pre:'# Comment fixture\n',postHash:digest(fixtures['comment-before.md']),run:1,observed:true},{k:'turn',run:1,files:1,state:'partial'}];
 const instruction=fixtures['comment-instruction.txt'];task.reviewDrafts=[{id:'a04-old-draft',run:1,project:current.activeProject,workspace:'Browser · A04 comments',file:'comments.md',version:reviewVersion(fixtures['comment-before.md']),anchorLine:3,kind:'add',text:'Old instruction; insert a blank line.'}];
 localStorage.setItem('anvil-state-v1',JSON.stringify(current));initial.remove();
 const comment=await frame('comments'),cw=comment.contentWindow,cd=cw.document;
 // Open the real run preview from its rendered turn, then replace the draft through normal UI.
 const turn=cd.querySelector('#log .change.turn');assert(turn,'recorded turn control');turn.click();
 await until(()=>cd.querySelector('.review-drafts'),'draft preview');const remove=[...cd.querySelectorAll('.review-drafts button')].find(button=>button.textContent==='Remove');remove.click();
 const anchor=cd.querySelector('button[title="Draft a comment at comments.md:3"]');assert(anchor,'one-based source anchor');anchor.click();await until(()=>cd.querySelector('.ask-scrim textarea'),'normal comment dialog');
 cd.querySelector('.ask-scrim textarea').value=instruction;[...cd.querySelectorAll('.ask-scrim button')].find(button=>button.textContent==='Save draft').click();await until(()=>cached(cw).projects[0].tasks[0].reviewDrafts?.[0]?.text===instruction,'latest instruction persists');comment.remove();
 const resumed=await frame('comments'),rw=resumed.contentWindow,rd=rw.document;const retained=cached(rw).projects[0].tasks[0].reviewDrafts[0];assert(retained.file==='comments.md'&&retained.anchorLine===3&&retained.version===reviewVersion(fixtures['comment-before.md'])&&retained.text===instruction,'draft path, coordinate, version and latest instruction survive reload');
 rd.querySelector('#log .change.turn').click();await until(()=>[...rd.querySelectorAll('.review-drafts button')].some(button=>button.textContent==='Apply this run’s comments'),'review continuation control');
 const budget=rw.__anvil.test.setRunBudget({maxSteps:18,tokens:90000,wallClockMs:180000});assert(budget.ok,'frozen continuation budget sets');
 const beforeFiles=await workspaceBytes(rw);
 [...rd.querySelectorAll('.review-drafts button')].find(button=>button.textContent==='Apply this run’s comments').click();await until(()=>cached(rw).projects[0].tasks[0].status==='done','base gate verified');
 const after=(await rw.__anvil.test.fs.read('comments.md')).data;
 const basePass=after.split('\n').filter(line=>line==='LIVE_CHECK_B01_20261001').length===1;
 const adjacencyPass=after===fixtures['comment-before.md'].replace('LIVE_CHECK_B01_20261001\n','LIVE_CHECK_B01_20261001\nLIVE_CHECK_B05_20261006\n');
 const afterFiles=await workspaceBytes(rw);const changed=[...new Set([...Object.keys(beforeFiles),...Object.keys(afterFiles)])].filter(path=>beforeFiles[path]!==afterFiles[path]);assert(JSON.stringify(changed)===JSON.stringify(['comments.md']),'only comment target bytes change');
 assert(basePass,'original marker-count criterion independently passes');assert(adjacencyPass,'latest comment exact adjacency and preservation criterion independently passes');await records('comments');
 assert(!cached(rw).projects[0].tasks[0].reviewDrafts.length,'dispatched draft clears only after continuation');results.comments={baseGatePass:basePass,onlyTargetChanged:true,adjacencyPass,draftCoordinatesSurviveReload:true,latestInstructionSurvivesReload:true,chainVerified:true,providerCalls:rw.__A04.providerCalls};resumed.remove();return {...results,records:exportedRecords};
}
