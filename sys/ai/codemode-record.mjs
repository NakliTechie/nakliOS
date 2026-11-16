import {validateCodemodeStore} from './codemode-runtime.mjs';
import {contentHash,eventHash} from '../history/ledger.mjs';
// Inside NakliOS a script also reaches other apps' commands (the common rail) through three JSON tools. The sentence
// is added only when they are on, so the schema of an unhosted run stays byte-stable for recorded replays.
const RAIL_NOTE=" Inside NakliOS, tools.rail_search({query}) lists other apps' commands, tools.rail_describe({name}) gives one command's input, and tools.rail_call({name,input}) runs one; each returns JSON. A call that needs the person's answer returns {ok:false,code:'ECONSENT'}: stop and use app_command outside the script.";
export const CODEMODE_RAIL_TOOL_NAMES=Object.freeze(['rail_search','rail_describe','rail_call']);
// The tools a script may call: the file tools in the run's toolset, plus the rail tools only when the caller says the
// run is hosted inside NakliOS (rail:true). app_command alone is no evidence: every code-mode toolset carries it.
export function codemodeScriptTools(toolsetNames,{rail=false}={}){const names=toolsetNames.filter(name=>CODEMODE_TOOL_NAMES.includes(name));return rail===true?names.concat(CODEMODE_RAIL_TOOL_NAMES):names;}
export function codemodeTool({rail=false}={}){return {type:'function',function:{name:'codemode',description:'Run one bounded JavaScript async body in an isolated guest. Only tools.<name>(args), text(value), store(key,value), and load(key) exist. Await calls. Completed calls remain real after errors; unfinished calls are cancelled. Successful scripts commit small JSON store values to the run record. Guest code has no network, filesystem, timers or module imports. Tools use normal grants, permission rules, protected paths and hooks.'+(rail?RAIL_NOTE:''),parameters:{type:'object',properties:{code:{type:'string',description:'JavaScript async function body, at most32KiB UTF-8.'}},required:['code']}}};}
export function codemodeCatalog(tools,{enabled=false,mode='code',selectedRange=false,rail=false}={}){
 return enabled===true&&mode==='code'&&!selectedRange?tools.concat(codemodeTool({rail:rail===true})):tools.slice();
}
export const CODEMODE_TOOL_NAMES=Object.freeze(['read','read_lines','write','edit','edit_lines','apply_patch','shell']);
// A proposal becomes store state only when its outer call returned successfully.
// Nested-call events remain separate from the model-visible transcript.
export function foldCodemodeStore(events,resolve,{throughIndex=null}={}){
 let latest={values:Object.create(null),invocation:null,index:null},proposal=null;
 if(throughIndex!==null&&(!Number.isSafeInteger(throughIndex)||throughIndex<0||throughIndex>=events.length))throw Error('Recorded store prefix is unavailable');
 for(let index=0;index<events.length;index++){const event=events[index];
  if(event.tool==='codemode.store.proposed'){
   const {input,output}=resolve(event);
   if(typeof input?.invocation!=='string'||input.invocation.length>200)throw Error('Invalid recorded script invocation');
   proposal={invocation:input.invocation,values:validateCodemodeStore(output?.values)};
  }else if(event.tool==='tool.responded'&&proposal){
   const {input,output}=resolve(event);
   if(input?.id===proposal.invocation){
    if(input.name==='codemode'&&typeof output?.result==='string'&&output.result.startsWith('Codemode completed\n'))latest={values:proposal.values,invocation:proposal.invocation,index};
    proposal=null;
   }
  }
  if(throughIndex===index)break;
 }
 return latest;
}
export async function verifiedCodemodeStore(record,reference){
 const events=record.events();if(!(await record.verify()).ok)throw Error('Store record chain failed verification');
 for(const event of events){const {input,output}=record.resolve(event);if(input===undefined||output===undefined||await contentHash(input)!==event.input_hash||await contentHash(output)!==event.output_hash)throw Error('Store record payload failed verification');if(event===events[reference.index])break;}
 const store=foldCodemodeStore(events,record.resolve,{throughIndex:reference.index});if(store.index!==reference.index||await eventHash(events[store.index])!==reference.hash||store.invocation!==reference.invocation)throw Error('Store reference does not name a committed transaction');return store.values;
}

// Replay serves recorded nested results; callers supply no application executor.
export async function createCodemodeReplay(record,invocation){
 const events=record.events();if(!(await record.verify()).ok)throw Error('Replay chain failed verification');
 let started=null;const calls=[],settled=new Map();
 for(const event of events){
  const row=record.resolve(event);if(row.input===undefined||row.output===undefined||await contentHash(row.input)!==event.input_hash||await contentHash(row.output)!==event.output_hash)throw Error('Replay payload failed verification');
  if(row.input?.invocation!==invocation)continue;
  if(event.tool==='codemode.started'){if(started)throw Error('Duplicate script start');started=row;}
  if(event.tool==='codemode.called'){if(calls.length>=32)throw Error('Replay call bound');calls.push(row.input);}
  if(event.tool==='codemode.settled'){if(settled.has(row.input.id))throw Error('Duplicate nested settlement');settled.set(row.input.id,row.output);}
 }
 if(!started)throw Error('Recorded script start unavailable');let cursor=0;
 return {code:started.input.code,tools:started.input.tools,store:validateCodemodeStore(started.output.initialStore),
  execute:async(name,args,{id})=>{const expected=calls[cursor++];if(!expected||expected.id!==id||expected.name!==name||await contentHash(expected.args)!==await contentHash(args))throw Error('Codemode replay call mismatch');const result=settled.get(id);if(!result||result.cancelled||result.late)throw Error('Recorded nested call has uncertain cancellation');if(result.error)throw Error(result.error);return result.result;},
  assertConsumed(){if(cursor!==calls.length)throw Error('Codemode replay omitted recorded calls');}};
}
