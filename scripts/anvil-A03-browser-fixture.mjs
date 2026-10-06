// Finite offline host fixture. It never contacts a model or provider.
export function fixtureSDK(){return `(()=>{
 const recovery=location.search.includes('recovery');
 const task={id:'a03-task',title:'A03 fixture',status:'idle',mode:'code',convo:[],log:[],queued:[]};
 const state={rev:1,activeProject:'a03-project',activeTask:task.id,projects:[{id:'a03-project',name:'A03 fixture',open:true,tasks:[task]}]};
 const metrics=window.__A03={providerCalls:0,inferenceCalls:0,readBytes:0,writeBytes:0,writes:0,stateWrites:0};
 const enc=new TextEncoder();
 if(!recovery){
  task.log=Array.from({length:600},(_,i)=>({k:'tool',name:'read',detail:'file '+i,result:'result '+i,open:false}));
  state.projects[0].tasks.push({id:'a03-other',title:'Empty comparison task',status:'idle',mode:'code',convo:[],log:[],queued:[]});
  task.convo=[{role:'user',content:''}];
  const initial=JSON.stringify(state);task.convo[0].content='x'.repeat(10*1024*1024-enc.encode(initial).length);
 }
 let stateText=JSON.stringify(state);metrics.fixtureBytes=enc.encode(stateText).length;
 if(recovery && !localStorage.getItem('anvil-state-v1'))localStorage.setItem('anvil-state-v1',stateText);
 const objects=new Map();
 const fs={supportsBoundedReads:true,
  async read(path){const value=path==='state.json'?stateText:objects.get(path)||null;if(value)metrics.readBytes+=typeof value==='string'?enc.encode(value).length:value.length;return value;},
  async readBinary(path){const value=objects.get(path);return value?new Uint8Array(value):new Uint8Array();},
  async stat(path){const value=objects.get(path);return value?{type:'file',size:value.length,mtimeMs:1}:null;},
  async exists(path){return objects.has(path);},async list(prefix){return [...objects.keys()].filter(key=>key.startsWith(prefix));},
  async delete(path){objects.delete(path);},
  async write(path,value){const bytes=typeof value==='string'?enc.encode(value):new Uint8Array(value);if(bytes.length>16*1024*1024)throw Error('fixture object bound');metrics.writes++;metrics.writeBytes+=bytes.length;if(path==='state.json'){stateText=new TextDecoder().decode(bytes);metrics.stateWrites++;}else{if(objects.size>=1000&&!objects.has(path))throw Error('fixture object count bound');objects.set(path,bytes);}}
 };
 window.naklios={capabilities:{fs:!recovery,fsBackend:'folder',ai:recovery,aiModel:'offline-A03',aiProvider:'fixture'},fs,ready(){},title(){},onCapabilitiesChange(){},ai:{chat:{completions:{async create(req){
  metrics.inferenceCalls++;
  if(metrics.inferenceCalls===1)return {model:'offline-A03',choices:[{message:{content:'',tool_calls:[{id:'a03-write-once',type:'function',function:{name:'write',arguments:JSON.stringify({path:location.search.includes('hook-refusal')?'.anvil/hooks.json':'agent.txt',content:location.search.includes('hook-refusal')?'{}':'after'})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:10}};
  return new Promise((_,reject)=>req.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));
 }}}}};
})();`}
