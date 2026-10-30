// Desktop commands and their manifest share these definitions. Credentials and
// permission changes stay in the person's existing dialogs, outside this grant.
import { createRegistry } from '../rig/registry/registry.mjs';
import { createGrant, createOpLog, createAgentFace, wireWindowRig } from '../rig/agent/index.mjs';
import { createFileops, MemoryBackend } from '../rig/fileops/index.mjs';

const str = { type:'string', minLength:1 };
export const HOST_COMMANDS = Object.freeze([
  ['apps.list','List available apps','apps','ui:read',{},[]],
  ['apps.open','Open an app','openApp','ui:write',{id:str},['id']],
  ['themes.list','List available themes','themes','ui:read',{},[]],
  ['themes.set','Change desktop theme','applyTheme','ui:write',{id:str},['id'],true],
  ['folders.list','List desktop folders','folders','ui:read',{},[]],
  ['folders.open','Open a desktop folder','openFolder','ui:write',{id:str},['id']],
  ['folders.close','Close the desktop folder','closeFolder','ui:write',{},[]],
  ['windows.list','List app windows','windows','ui:read',{},[]],
  ['windows.close','Close an app through its save barrier','closeWindow','ui:write',{id:str},['id'],true],
  ['windows.minimize','Minimize an app window','minimizeWindow','ui:write',{id:str},['id']],
  ['windows.focus','Focus an app window','focusWindow','ui:write',{id:str},['id']],
  ['windows.maximize','Maximize or restore an app window','maximizeWindow','ui:write',{id:str},['id']],
  ['search.open','Open app search','openSpotlight','ui:write',{},[]],
  ['settings.open','Open settings without changing permissions','openSettings','ui:write',{},[]],
  ['settings.close','Close settings','closeSettings','ui:write',{},[]],
  ['help.open','Open keyboard help','openCheatSheet','ui:write',{},[]],
  ['help.close','Close keyboard help','closeCheatSheet','ui:write',{},[]],
  ['mode.get','Read experience mode','getMode','ui:read',{},[]],
  ['mode.set','Change experience mode','setMode','ui:write',{id:{enum:['basic','immersive']}},['id'],true],
  ['pins.add','Pin an app or folder','pinItem','ui:write',{id:str},['id'],true],
  ['pins.remove','Unpin an app or folder','unpinItem','ui:write',{id:str},['id'],true],
  ['pins.has','Check whether an item is pinned','isPinned','ui:read',{id:str},['id']],
  ['apps.moveToDesktop','Move an app to the desktop','moveAppToDesktop','ui:write',{id:str},['id'],true],
  ['notes.add','Create a desktop sticky note','addSticky','ui:write',{x:{type:'number'},y:{type:'number'}},['x','y'],true],
  ['notes.update','Update a desktop sticky note','updateSticky','ui:write',{id:str,patch:{type:'object'}},['id','patch'],true],
  ['notes.delete','Delete a desktop sticky note','deleteSticky','ui:write',{id:str},['id'],true],
  ['diagnostics.read','Read content-free launch timings','diagnostics','ui:read',{},[]],
  ['fs.read','Read a file in the connected store','fsRead','fs:read',{path:str},['path']],
  ['fs.readBinary','Read binary bytes in the connected store','fsReadBinary','fs:read',{path:str},['path']],
  ['fs.list','List files in the connected store','fsList','fs:read',{path:{type:'string'}},['path']],
  ['fs.exists','Check a file in the connected store','fsExists','fs:read',{path:str},['path']],
  ['fs.write','Write a file in the connected store','fsWrite','fs:write',{path:str,data:{type:'string'}},['path','data'],true],
  ['fs.append','Append to a file in the connected store','fsAppend','fs:write',{path:str,data:{type:'string'}},['path','data'],true],
  ['fs.delete','Delete a file in the connected store','fsDelete','fs:remove',{path:str},['path'],true],
  ['assistant.open','Open the voice assistant','openAssistant','ui:write',{},[]],
  ['assistant.close','Close the voice assistant','closeAssistant','ui:write',{},[]],
  ['assistant.ask','Send a typed message to the voice assistant','askAssistant','ui:write',{text:str},['text']],
  ['assistant.listen','Open the microphone for one spoken turn','listenAssistant','ui:write',{},[]],
  ['assistant.endTurn','Close the microphone and send the spoken turn','stopListeningAssistant','ui:write',{},[]],
  ['assistant.stop','Stop the assistant reply and its audio','stopAssistant','ui:write',{},[]],
  ['assistant.handsFree','Turn hands-free listening on or off','setAssistantHandsFree','ui:write',{on:{type:'boolean'}},['on']],
  ['assistant.state','Read whether the assistant is open and its state','assistantState','ui:read',{},[]],
  ['assistant.model','Choose the assistant model (the first LFM3-Omni load downloads 2.1 GB)','chooseAssistantModel','ui:write',{id:{enum:['lfm3-omni-2b','stub']}},['id']],
].map(row => Object.freeze(row)));

const PERSON_ONLY = ['credentials.configure','storage.connect','storage.disconnect','apps.install','apps.uninstall','review.commit','review.discard','ai.select'];

export function createHostRegistry(actions) {
  const declared=new Set(HOST_COMMANDS.map(row=>row[2]));
  for(const name of Object.keys(actions))if(!declared.has(name))throw new Error(`Undeclared host action: ${name}`);
  const commands = HOST_COMMANDS.map(([name,summary,action,scope,properties,args,destructive=false]) => {
    if (typeof actions[action] !== 'function') throw new Error(`Missing host action: ${action}`);
    return {
      name, summary, description:summary, scope, destructive,
      inputSchema:{type:'object',properties,required:args,additionalProperties:false},
      returnSchema:{type:'object',required:['ok']}, annotations:{readOnlyHint:scope.endsWith(':read')},
      async run(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) return {ok:false,code:'EINVAL'};
        for (const key of Object.keys(input)) if (!Object.hasOwn(properties,key)) return {ok:false,code:'EINVAL'};
        for (const key of args) {
          const rule=properties[key], value=input[key];
          if (value === undefined || (rule.type && (typeof value !== rule.type || value === null)) ||
              (rule.type==='object' && Array.isArray(value)) || (rule.minLength && value.length<rule.minLength) ||
              (rule.enum && !rule.enum.includes(value))) return {ok:false,code:'EINVAL',message:`Invalid ${key}`};
        }
        try {
          const result=await actions[action](...args.map(k=>input[k]));
          // DOM nodes are not command results and cannot escape through discovery.
          return {ok:true,result:result?.nodeType ? null : result};
        } catch(error) { return {ok:false,code:error.code || 'EHOST',message:String(error.message || error)}; }
      },
    };
  });
  for (const name of PERSON_ONLY) commands.push({
    name,summary:'Person-only action; use the existing desktop dialog',description:'Not granted to the agent interface.',
    scope:'operator:only',destructive:true,inputSchema:{type:'object',additionalProperties:false},returnSchema:{type:'object'},
    annotations:{readOnlyHint:false},run:async()=>({ok:false,code:'EOPERATOR'}),
  });
  return createRegistry(commands);
}

export function attachHostAgent({target,actions,diagnosticsThresholds={}}) {
  const registry=createHostRegistry(actions);
  const grant=createGrant({prefixes:[''],scopes:['ui:read','ui:write','fs:read','fs:write','fs:remove']});
  const opLog=createOpLog({fs:createFileops({backend:new MemoryBackend()})});
  const face=createAgentFace({registry,grant,opLog,actor:'agent',caller:'desktop-developer'});
  // Public metadata is available while execution remains off by default.
  target.nakliOS=Object.freeze({manifest:()=>registry.list(),tools:()=>registry.toolSchemas(),
    launchDiagnostics:()=>actions.diagnostics(),launchDiagnosticThresholds:Object.freeze({...diagnosticsThresholds})});
  const control=wireWindowRig({target,getFace:()=>face});
  return {registry,face,opLog,control};
}
