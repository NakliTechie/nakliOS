// Local disposable host. Provider mode forwards unchanged OpenAI messages/tools.
export function fixtureSDK({provider=false}={}){return `(()=>{
 const mode=new URLSearchParams(location.search).get('case')||'survey';
 const task={id:'a04-'+mode+'-task',title:'A04 '+mode,status:'idle',mode:'code',convo:[],log:[],queued:[]};
 const state={rev:1,activeProject:'a04-'+mode,activeTask:task.id,projects:[{id:'a04-'+mode,name:'A04 '+mode,open:true,tasks:[task]}]};
 if(!localStorage.getItem('anvil-state-v1'))localStorage.setItem('anvil-state-v1',JSON.stringify(state));
 const metrics=window.__A04={inferenceCalls:0,providerCalls:0,pending:false,release:null,requests:[]};
 const call=(name,args)=>({model:'offline-A04',choices:[{message:{content:'',tool_calls:[{id:'a04-'+metrics.inferenceCalls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:20}});
 const done=()=>({model:'offline-A04',choices:[{message:{content:'Survey finished.'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10}});
 window.naklios={capabilities:{fs:false,ai:true,aiModel:${JSON.stringify(provider?'space-bunny-free':'offline-A04')},aiProvider:${JSON.stringify(provider?'opencode-zen':'fixture')}},ready(){},title(){},onCapabilitiesChange(){},ai:{chat:{completions:{async create(req){
  metrics.inferenceCalls++;metrics.requests.push({tools:(req.tools||[]).map(t=>t.function.name)});
  let response;
  if(${provider}&&mode!=='hindsight'){
   const {signal,agent,...body}=req;body.model='space-bunny-free';metrics.providerCalls++;
   const result=await fetch('/inference',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
   if(!result.ok)throw Error('Provider route refused: '+result.status+' '+(await result.text()).slice(0,500));response=await result.json();
  }else if(mode==='comments'){
   if(metrics.inferenceCalls===1)response=call('read',{path:'comments.md'});
   else if(metrics.inferenceCalls===2)response=call('edit',{path:'comments.md',old_string:'LIVE_CHECK_B01_20261001\\n',new_string:'LIVE_CHECK_B01_20261001\\nLIVE_CHECK_B05_20261006\\n'});
   else if(metrics.inferenceCalls===3)response=call('task_done',{});else response=done();
  }else{
   if(metrics.inferenceCalls===1)response=call('list',{path:''});
   else if(metrics.inferenceCalls===2)response=call('read',{path:'src/counter.js'});
   else if(metrics.inferenceCalls===3)response=call('remember',{note:'The counter advances by one.',sourcePaths:[mode==='hindsight'?'.anvil/memory/hindsight.md':'src/counter.js'],sourceSpans:[{path:mode==='hindsight'?'.anvil/memory/hindsight.md':'src/counter.js',startLine:2,endLine:2,quote:'return value + 1;'}]});
   else response=done();
  }
  if(mode==='delay'&&!metrics.pending&&(response.choices?.[0]?.message?.tool_calls||[]).some(c=>c.function?.name==='remember')){
   metrics.pending=true;await new Promise(resolve=>metrics.release=resolve);
  }
  return response;
 }}}}};
})();`}
