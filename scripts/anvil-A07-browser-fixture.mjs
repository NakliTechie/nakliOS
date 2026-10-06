export function fixtureSDK(){return `(()=>{
 const task={id:'a07-task',title:'A07 fixture',status:'idle',mode:'code',convo:[],log:[],queued:[]};
 if(!localStorage.getItem('anvil-state-v1'))localStorage.setItem('anvil-state-v1',JSON.stringify({rev:1,activeProject:'a07-project',activeTask:task.id,projects:[{id:'a07-project',name:'A07 project',open:true,tasks:[task]}]}));
 const metrics=window.__A07={calls:0,code:'return 1;',offered:[]};
 window.naklios={capabilities:{fs:false,ai:true,aiModel:'offline-A07',aiProvider:'fixture'},ready(){},title(){},onCapabilitiesChange(){},ai:{chat:{completions:{async create(req){
  metrics.calls++;metrics.offered=(req.tools||[]).map(tool=>tool.function.name);
  const name=metrics.calls===1?'codemode':'task_done',args=metrics.calls===1?{code:metrics.code}:{};
  return {model:'offline-A07',choices:[{message:{content:'',tool_calls:[{id:'a07-'+metrics.calls,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,completion_tokens:20}};
 }}}}};
})();`}
