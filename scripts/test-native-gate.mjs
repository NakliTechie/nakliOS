// Native bridge contract. Portable checks run everywhere. The positive native
// execution and OS containment legs require macOS and its actual sandbox-exec.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import http from 'node:http';
import { workflowCommands, createNativeGateServer, sandboxProfile } from './native-gate-server.mjs';
import { createNativeGateClient, validateConnection } from '../sys/rig/native-gate/client.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createAgentFace, createOpLog } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { createGitCore } from '../sys/rig/git/git-core.mjs';
import { inlineModule, extractFunction, evaluate } from './anvil-harness.mjs';
import { syncWorkerSnapshot } from '../sys/kiln/worker-runtime.mjs';
import { reviewVersion, reviewPrompt } from '../sys/ai/review-diff.mjs';
const exec = promisify(execFile);

test('actual paired Anvil grant refuses every Git mutation through the real agent face', async () => {
  const source=await inlineModule();
  const declarations=['const AGENT_SCOPES =','const agentGrant ='].map(prefix=>source.split('\n').find(line=>line.trimStart().startsWith(prefix))).join('\n');
  const grant=vm.runInNewContext(declarations+'\nagentGrant();',{createGrant,nativeGateSession:{mutable:'sys/candidate.mjs'},activeRangeEdit:null,SKILLS_DIR:'.anvil/skills',GATE_DIR:'.anvil/gate',SEARCH_INDEX_PATH:'.anvil/search-index.json',HOOKS_FILE:'.anvil/hooks.json'});
  const fs=createFileops({backend:new MemoryBackend()});
  const git=createGitCore({fs,dir:'/'}), registry=buildRigRegistry({fs,git});
  const face=createAgentFace({registry,grant,opLog:createOpLog({fs:createFileops({backend:new MemoryBackend()})})});
  for(const [name,args] of [['git.init',{}],['git.add',{filepath:'sys/candidate.mjs'}],['git.commit',{message:'bypass'}],['git.checkout',{ref:'main'}],['git.clone',{url:'https://github.com/owned/fixture'}],['git.fetch',{remote:'origin'}],['git.push',{remote:'origin'}]]){
    const result=await face.invoke(name,args);
    assert.equal(result.ok,false,name);assert.equal(result.code,'EGRANT',name);
  }
  assert.equal(grant.allowsScope('git:read'),true);
  assert.equal(grant.allowsScope('native:gate'),true);
  assert.equal((await fs.stat('.git')).ok,false);
  assert.equal((await face.invoke('fs.write',{path:'sys/candidate.mjs',data:'approved'})).ok,true);
  assert.equal((await face.invoke('fs.write',{path:'unrelated',data:'refused'})).code,'EGRANT');
});

test('exact writable paths preserve read access while denying sibling, descendant, and ancestor mutations', () => {
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read','fs:write'], writePaths: ['sys/ai/context-budget.mjs'] });
  assert.equal(grant.allowsPath('sys/ai/test/criterion.mjs'), true);
  assert.equal(grant.isReadOnly('sys/ai/context-budget.mjs'), false);
  for (const name of ['sys/ai/other.mjs','sys/ai/context-budget.mjs/child','sys/ai','.anvil/gate/test.mjs','']) {
    assert.equal(grant.isReadOnly(name), true, name);
  }
  assert.equal(createGrant({prefixes:[''],writePaths:[]}).isReadOnly('anything'), true);
  assert.equal(createGrant({prefixes:['']}).isReadOnly('anything'), false);
});

test('native gate discovery is absent without pairing; grant and op-log govern its paired shell invocation', async () => {
  const fs = createFileops({backend:new MemoryBackend()}), opLog=createOpLog({fs});
  const unpaired=buildRigRegistry({fs});
  assert.equal(unpaired.describeCommand('native.gate'),null);
  let calls=0;
  const registry=buildRigRegistry({fs,nativeGate:{run:async(mode)=>{calls++;return {code:mode==='criterion'?7:0,output:'native '+mode};}}});
  const denied=createAgentFace({registry,grant:createGrant({prefixes:[''],scopes:['fs:read']}),opLog});
  const blocked=createShell({registry,face:denied});
  await blocked.feed('native-gate full');assert.equal(blocked.lastCode,1);assert.equal(calls,0);
  const grant=createGrant({prefixes:[''],scopes:['native:gate']});
  const shell=createShell({registry,face:createAgentFace({registry,grant,opLog})});
  assert.match((await shell.feed('native-gate full')).output,/native full/);assert.equal(shell.lastCode,0);
  await shell.feed('native-gate criterion');assert.equal(shell.lastCode,7);
  const prior=calls;await shell.feed('native-gate full arbitrary');assert.notEqual(shell.lastCode,0);assert.equal(calls,prior);
  grant.revoke();await shell.feed('native-gate full');assert.equal(calls,prior);
});

test('workflow extraction preserves flags and multi-file argv; refuses shell syntax and unsupported run steps', () => {
  const items=workflowCommands('jobs:\n  native:\n    steps:\n      - run: node --test a.test.mjs b.test.mjs\n      - run: node --experimental-vm-modules probe.mjs deadbeef\n');
  assert.deepEqual(items.map(x=>x.argv),[['--test','a.test.mjs','b.test.mjs'],['--experimental-vm-modules','probe.mjs','deadbeef']]);
  assert.deepEqual(workflowCommands('jobs:\n  native:\n    steps:\n      - run: node\t--test\ta.test.mjs\n')[0].argv,['--test','a.test.mjs']);
  for(const value of ['node a.mjs; echo hi','node a.mjs && node b.mjs','node --eval x','node ../a.mjs','npm test','|','node a.mjs "two words"',"node a.mjs 'two words'",'node a.mjs escaped\\ arg']) {
    assert.throws(()=>workflowCommands('jobs:\n  native:\n    steps:\n      - run: '+value));
  }
});

test('an aborted shell admits diagnostic reads but refuses native execution', async () => {
  const fs=createFileops({backend:new MemoryBackend()});
  let calls=0;
  const registry=buildRigRegistry({fs,nativeGate:{run:async()=>{calls++;return {code:0,output:'PASS'};}}});
  const face=createAgentFace({registry,grant:createGrant({prefixes:[''],scopes:['fs:read','native:gate']}),opLog:createOpLog({fs})});
  const controller=new AbortController();controller.abort();
  const shell=createShell({registry,face,signal:controller.signal});
  await shell.feed('pwd');assert.equal(shell.lastCode,0);
  await shell.feed('native-gate full');assert.equal(shell.lastCode,130);assert.equal(calls,0);
});

function descriptor(){return {version:1,endpoint:'http://127.0.0.1:9131/',token:'x'.repeat(43),binding:JSON.stringify({version:1,session:'s'.repeat(32),workflowSha256:'a'.repeat(64),mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs'}),expiresAt:Date.now()+60000};}
function reply(value,status=200){return new Response(JSON.stringify(value),{status});}
test('workflow extraction refuses omitted execution controls and unsupported actions', () => {
  const base='jobs:\n  native:\n    steps:\n      - run: node scripts/gate.mjs\n';
  for(const extra of ['    if: false\n','    env:\n      MODE: bypass\n','    working-directory: elsewhere\n','    strategy:\n      matrix: ignored\n','    needs: earlier\n','    container: arbitrary\n','    services:\n      remote: arbitrary\n','    defaults:\n      run: ignored\n','      - uses: arbitrary/action@v1\n','      - run: |\n        node scripts/gate.mjs\n','      - uses: actions/checkout@v5\n        with: {repository: other}\n']){
    assert.throws(()=>workflowCommands(base+extra),/Unsupported|outside/);
  }
  assert.equal(workflowCommands(base+'      - uses: actions/checkout@v5\n        with:\n          fetch-depth: 0\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n').length,1);
  for(const scalar of ['|','>','|-','|2']){
    const commands=workflowCommands('jobs:\n  native:\n    steps:\n      - name: '+scalar+'\n          run: node scripts/unintended.mjs\n        run: node scripts/gate.mjs\n');
    assert.deepEqual(commands.map(row=>row.argv),[['scripts/gate.mjs']]);
  }
  const quoted=workflowCommands('jobs:\n  native:\n    steps:\n      - name: "caption\n          run: node scripts/unintended.mjs\n          ending"\n        run: node scripts/gate.mjs\n');
  assert.deepEqual(quoted.map(row=>row.argv),[['scripts/gate.mjs']]);

});

test('the actual repository workflow preserves every literal Node command and quoted step caption', async () => {
  const source=await fs.readFile(new URL('../.github/workflows/test.yml',import.meta.url),'utf8');
  const expected=[...source.matchAll(/^[ \t]+(?:-[ \t]+)?run:[ \t]*(.+?)[ \t]*$/gm)].map(match=>match[1].trim());
  assert.ok(expected.length>200);
  const commands=workflowCommands(source);
  assert.deepEqual(commands.map(row=>row.command),expected);
  assert.deepEqual(commands.map(row=>row.argv),expected.map(command=>command.split(/\s+/).slice(1)));
});

test('workflow command summaries fit the bounded terminal protocol before execution', () => {
  const command='node scripts/gate.mjs '+ 'a'.repeat(32000);
  const workflow=count=>'jobs:\n  native:\n    steps:\n'+Array.from({length:count},()=> '      - run: '+command+'\n').join('');
  assert.equal(workflowCommands(workflow(2)).length,2);
  assert.throws(()=>workflowCommands(workflow(3)),/command metadata exceeds/);
});
test('connection validation denies URL credentials, remote origins, expiry, and alternate loopback names', () => {
  assert.equal(validateConnection(descriptor()).endpoint,'http://127.0.0.1:9131');
  for(const endpoint of ['https://example.com/','http://localhost:9131/','http://127.0.0.1:9131/path','http://secret@127.0.0.1:9131/']) {
    assert.throws(()=>validateConnection({...descriptor(),endpoint}));
  }
  assert.throws(()=>validateConnection({...descriptor(),expiresAt:0}));
});

test('client refuses workspace rebinding and oversized responses before reporting success', async () => {
  let binding='wrong',requests=0; const connection=descriptor();
  const client=createNativeGateClient({connection,readBinding:async()=>binding,fetch:async()=>{requests++;return reply({service:'naklios-native-gate',mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs',commandCount:1,expiresAt:connection.expiresAt});}});
  await assert.rejects(client.connect(),/another workspace/);assert.equal(requests,0);
  binding=connection.binding;await client.connect();assert.equal(requests,1);
  const oversized=createNativeGateClient({connection:descriptor(),readBinding:async()=>descriptor().binding,fetch:async()=>new Response('x'.repeat(1024*1024+1))});
  await assert.rejects(oversized.connect(),/byte bound/);
});

test('pairing metadata matches the owner binding before authority changes', async () => {
  const connection=descriptor();
  const good={service:'naklios-native-gate',mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs',commandCount:1,expiresAt:connection.expiresAt};
  for(const changed of [{}, {service:'other'}, {mutable:'sys/sibling.mjs'}, {criterion:'scripts/other.mjs'},
    {expiresAt:connection.expiresAt+1}, {commandCount:0}, {commandCount:501}, {commandCount:1.5}]){
    const data=Object.keys(changed).length?{...good,...changed}:{};
    const client=createNativeGateClient({connection,readBinding:async()=>connection.binding,fetch:async()=>reply(data)});
    await assert.rejects(client.connect(),/does not match/);
  }
  const client=createNativeGateClient({connection,readBinding:async()=>connection.binding,fetch:async()=>reply(good)});
  assert.deepEqual(await client.connect(),good);
});

test('Stop racing with a positive job reply requires a cancellation acknowledgement', async () => {
  const controller=new AbortController(),routes=[];
  let id;
  const client=createNativeGateClient({connection:descriptor(),readBinding:async()=>descriptor().binding,fetch:async(url,opts)=>{
    const route=new URL(url).pathname;routes.push(route);
    if(route==='/run'){id=JSON.parse(opts.body).id;return reply({id,state:'running'});}
    if(route==='/job'){controller.abort();return reply({id,state:'passed',code:0,output:'PASS'});}
    if(route==='/cancel')return reply({id,state:'cancelled',code:130,output:'cancelled',completedCommands:0,totalCommands:1,receipt:id+'/receipt.json'});
    throw new Error('unexpected route');
  }});
  const result=await client.run('full',{signal:controller.signal});
  assert.equal(result.code,130);assert.equal(result.state,'cancelled');assert.ok(routes.includes('/cancel'));
});

test('observing a job fails; client requests cancellation instead of claiming termination', async () => {
  const routes=[];let id;
  const client=createNativeGateClient({connection:descriptor(),readBinding:async()=>descriptor().binding,fetch:async(url,opts)=>{
    const route=new URL(url).pathname;routes.push(route);
    if(route==='/run'){id=JSON.parse(opts.body).id;return reply({id,state:'running'});}
    if(route==='/job')throw new Error('observation expired');
    return reply({id,state:'cancelled',code:130,output:'cancelled',completedCommands:0,totalCommands:1,receipt:id+'/receipt.json'});
  }});
  await assert.rejects(client.run('full'),/observation expired/);assert.deepEqual(routes,['/run','/job','/cancel']);
});

test('unconfirmed cancellation remains addressable until close receives the terminal acknowledgement', async () => {
  let acknowledged=false, cancellations=0, id;
  const client=createNativeGateClient({connection:descriptor(),readBinding:async()=>descriptor().binding,fetch:async(url,options)=>{
    const route=new URL(url).pathname;
    if(route==='/run'){id=JSON.parse(options.body).id;return reply({id,state:'running'});}
    if(route==='/job')throw new Error('observation failed');
    cancellations++;
    return reply({id,state:acknowledged?'cancelled':'running',code:acknowledged?130:null,output:'cancelled',completedCommands:0,totalCommands:1,receipt:id+'/receipt.json'});
  }});
  await assert.rejects(client.run('full'),/cancellation unconfirmed/);
  await assert.rejects(client.close(),/cancellation was not acknowledged/);
  assert.equal(cancellations,2);
  acknowledged=true;await client.close();assert.equal(cancellations,3);
});

test('job replies require matching identities and consistent exit states; cancellation retains unmatched jobs', async () => {
  for(const shape of ['wrong-running-id','wrong-terminal-id','failed-zero','passed-nonzero','cancelled-non130']){
    let id,cancels=0;
    const client=createNativeGateClient({connection:descriptor(),readBinding:async()=>descriptor().binding,fetch:async(url,options)=>{
      const route=new URL(url).pathname;
      if(route==='/run'){id=JSON.parse(options.body).id;return reply({id,state:'running'});}
      if(route==='/cancel'){cancels++;return reply({id,state:'cancelled',code:130,output:'cancelled',completedCommands:0,totalCommands:1,receipt:id+'/receipt.json'});}
      return reply({id:shape.startsWith('wrong')?'different-owned-job':id,
        state:shape==='wrong-running-id'?'running':shape==='failed-zero'?'failed':shape==='cancelled-non130'?'cancelled':'passed',
        code:shape==='wrong-running-id'?null:shape==='passed-nonzero'||shape==='cancelled-non130'?7:0,output:'invalid result'});
    }});
    await assert.rejects(client.run('full'),/job identity|Invalid native gate result/);assert.equal(cancels,1);
    await client.close();assert.equal(cancels,1);
  }
  let id,acknowledged=false,cancels=0;
  const client=createNativeGateClient({connection:descriptor(),readBinding:async()=>descriptor().binding,fetch:async(url,options)=>{
    const route=new URL(url).pathname;
    if(route==='/run'){id=JSON.parse(options.body).id;return reply({id,state:'running'});}
    if(route==='/job')throw new Error('observation failed');
    cancels++;return reply({id:acknowledged?id:'wrong-job',state:'cancelled',code:130,output:'cancelled',completedCommands:0,totalCommands:1,receipt:id+'/receipt.json'});
  }});
  await assert.rejects(client.run('full'),/cancellation unconfirmed/);
  await assert.rejects(client.close(),/not acknowledged/);assert.equal(cancels,2);
  acknowledged=true;await client.close();assert.equal(cancels,3);
});

test('terminal results require bounded command accounting and the persisted receipt for success', async () => {
  const shapes=['valid','no-receipt','wrong-receipt','incomplete','over-complete','fractional','negative','too-many','wrong-workflow-count','wrong-criterion-count','failed-without-receipt'];
  for(const shape of shapes){
    const connection=descriptor();let id,cancels=0;
    const client=createNativeGateClient({connection,readBinding:async()=>connection.binding,fetch:async(url,options)=>{
      const route=new URL(url).pathname;
      if(route==='/status')return reply({service:'naklios-native-gate',mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs',commandCount:2,expiresAt:connection.expiresAt});
      if(route==='/run'){id=JSON.parse(options.body).id;return reply({id,state:'running'});}
      if(route==='/cancel'){cancels++;return reply({id,state:'cancelled',code:130,output:'cancelled',completedCommands:0,totalCommands:shape==='wrong-criterion-count'?1:2,receipt:id+'/receipt.json'});}
      const result={id,state:'passed',code:0,output:'PASS',completedCommands:2,totalCommands:2,receipt:id+'/receipt.json'};
      if(shape==='no-receipt')result.receipt=null;
      if(shape==='wrong-receipt')result.receipt='another-job/receipt.json';
      if(shape==='incomplete')result.completedCommands=1;
      if(shape==='over-complete')result.completedCommands=3;
      if(shape==='fractional')result.completedCommands=1.5;
      if(shape==='negative')result.completedCommands=-1;
      if(shape==='too-many')result.completedCommands=result.totalCommands=501;
      if(shape==='wrong-workflow-count')result.completedCommands=result.totalCommands=1;
      if(shape==='failed-without-receipt'){result.state='failed';result.code=1;result.output='receipt persistence failed';result.receipt=null;}
      return reply(result);
    }});
    await client.connect();
    const pending=client.run(shape==='wrong-criterion-count'?'criterion':'full');
    if(shape==='valid'||shape==='failed-without-receipt'){
      const result=await pending;assert.equal(result.state,shape==='valid'?'passed':'failed');assert.equal(cancels,0);
    }else{
      await assert.rejects(pending,/Invalid native gate result/);assert.equal(cancels,1);
    }
    await client.close();
  }
});

test('Stop during final binding validation waits for cancellation instead of returning a positive result', async () => {
  const connection=descriptor(),controller=new AbortController();let id,reads=0,release,waiting;
  const entered=new Promise(resolve=>waiting=resolve);
  const client=createNativeGateClient({connection,readBinding:async()=>{
    reads++;if(reads===4){waiting();await new Promise(resolve=>release=resolve);}
    return connection.binding;
  },fetch:async(url,options)=>{
    const route=new URL(url).pathname;
    if(route==='/status')return reply({service:'naklios-native-gate',mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs',commandCount:1,expiresAt:connection.expiresAt});
    if(route==='/run'){id=JSON.parse(options.body).id;return reply({id,state:'running'});}
    const cancelled=route==='/cancel';return reply({id,state:cancelled?'cancelled':'passed',code:cancelled?130:0,output:cancelled?'cancelled':'PASS',completedCommands:1,totalCommands:1,receipt:id+'/receipt.json'});
  }});
  await client.connect();const pending=client.run('full',{signal:controller.signal});
  await entered;controller.abort();release();
  const result=await pending;assert.equal(result.state,'cancelled');assert.equal(result.code,130);await client.close();
});

test('cancellation uses the same terminal accounting, output, receipt, and workspace validation', async () => {
  for(const shape of ['missing-count','fractional','out-of-range','oversized-output','missing-receipt','wrong-receipt','workspace-changed']){
    const connection=descriptor();let id,acknowledged=false,binding=connection.binding;
    const client=createNativeGateClient({connection,readBinding:async()=>binding,fetch:async(url,options)=>{
      const route=new URL(url).pathname;
      if(route==='/run'){id=JSON.parse(options.body).id;return reply({id,state:'running'});}
      if(route==='/job')throw new Error('observation failed');
      const result={id,state:'cancelled',code:130,output:'cancelled',completedCommands:0,totalCommands:1,receipt:id+'/receipt.json'};
      if(!acknowledged){
        if(shape==='missing-count')delete result.totalCommands;
        if(shape==='fractional')result.completedCommands=0.5;
        if(shape==='out-of-range')result.totalCommands=501;
        if(shape==='oversized-output')result.output='x'.repeat(128001);
        if(shape==='missing-receipt')result.receipt=null;
        if(shape==='wrong-receipt')result.receipt='other/receipt.json';
        if(shape==='workspace-changed')binding='other owner';
      }
      return reply(result);
    }});
    await assert.rejects(client.run('full'),/cancellation unconfirmed/);
    await assert.rejects(client.close(),/not acknowledged/);
    acknowledged=true;binding=connection.binding;await client.close();
  }
});

test('concurrent Stop and close retain the full workflow mode for every cancellation reply', async () => {
  const connection=descriptor(),controller=new AbortController();let id,cancels=0,releaseFirst,releaseSecond,entered;
  const ready=new Promise(resolve=>entered=resolve);
  const client=createNativeGateClient({connection,readBinding:async()=>connection.binding,fetch:async(url,options)=>{
    const route=new URL(url).pathname;
    if(route==='/status')return reply({service:'naklios-native-gate',mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs',commandCount:2,expiresAt:connection.expiresAt});
    if(route==='/run'){id=JSON.parse(options.body).id;return reply({id,state:'running'});}
    if(route==='/job'){controller.abort();return reply({id,state:'running'});}
    const requestNumber=++cancels;
    if(requestNumber===1){entered();await new Promise(resolve=>releaseFirst=resolve);}
    if(requestNumber===2)await new Promise(resolve=>releaseSecond=resolve);
    return reply({id,state:'cancelled',code:130,output:'cancelled',completedCommands:0,totalCommands:requestNumber===2?1:2,receipt:id+'/receipt.json'});
  }});
  await client.connect();const pending=client.run('full',{signal:controller.signal});await ready;
  const closing=client.close();await Promise.resolve();
  releaseFirst();
  // The first request must remain valid even while the second request is in flight.
  const result=await pending;assert.equal(result.code,130);
  releaseSecond();await assert.rejects(closing,/not acknowledged/);
});

test('actual task switching awaits cancellation and retains the bound workspace after failure', async () => {
  const source=await inlineModule();
  const code=['nativeAuthorityTransition','disconnectNativeAuthority','selectTask'].map(name=>extractFunction(source,name)).join('\n');
  for(const fail of [false,true]){
    let resolve,reject,revoked=0;
    const close=new Promise((a,b)=>{resolve=a;reject=b;});
    const state={activeTask:'before',activeProject:'project',projects:[{id:'next-project',tasks:[{id:'after'}]}]};
    const context={state,backend:{},kilnRef:null,nativeGateSession:{client:{close:()=>close}},grant:{revoke:()=>revoked++},nativeGateTransition:false,nativeGateRecovery:null,workspaceLabel:'owned',wsRoot:'',workspaceOptions:{},
      activeRangeEdit:null,priming:false,folderMode:false,primeAbortController:null,mountedProject:'project',pushSystem(){},save(){},renderAll(){},mountProject:async()=>{}};
    const runtime=evaluate(code+'\n({selectTask,getSession:()=>nativeGateSession})',context);
    const pending=runtime.selectTask('after');await Promise.resolve();
    assert.equal(state.activeTask,'before');assert.equal(state.activeProject,'project');assert.equal(revoked,1);
    if(fail)reject(new Error('cancellation unconfirmed'));else resolve();
    await pending;
    assert.equal(state.activeTask,fail?'before':'after');
    assert.equal(!!runtime.getSession(),fail);
  }
});

test('disconnect serializes Send, task switching, and runtime restoration until acknowledgement', async () => {
  const source=await inlineModule();
  const code=['nativeAuthorityTransition','disconnectNativeAuthority','selectTask','runTask'].map(name=>extractFunction(source,name)).join('\n');
  let release,restores=0;
  const pendingClose=new Promise(resolve=>release=resolve);
  const context={state:{activeProject:'owned',activeTask:'before'},backend:{},nativeGateSession:{client:{close:()=>pendingClose}},
    nativeGateTransition:false,nativeGateRecovery:null,kilnRef:null,folderMode:false,mountedProject:'owned',grant:{revoke(){}},running:false,priming:false,workspaceLabel:'owned',wsRoot:'',workspaceOptions:{},
    pushSystem(){},mountWorkspace:async(...args)=>{restores++;assert.equal(args[4],true);},activeRangeEdit:null};
  const runtime=evaluate(code+'\n({disconnectNativeAuthority,selectTask,runTask,transition:()=>nativeGateTransition})',context);
  const disconnect=runtime.disconnectNativeAuthority({restoreRuntime:true});await Promise.resolve();
  assert.equal(runtime.transition(),true);
  await assert.rejects(runtime.disconnectNativeAuthority(),/transition is in progress/);
  await runtime.selectTask('after');assert.equal(context.state.activeTask,'before');
  const task={title:'Untitled task'};await runtime.runTask(task,'must remain blocked');assert.equal(task.title,'Untitled task');
  assert.equal(restores,0);release();await disconnect;assert.equal(restores,1);assert.equal(runtime.transition(),false);
});

test('failed disconnect restoration retains the captured mount and blocks work until explicit recovery succeeds', async () => {
  const source=await inlineModule();
  const code=['nativeAuthorityTransition','disconnectNativeAuthority','recoverNativePairing'].map(name=>extractFunction(source,name)).join('\n');
  let closes=0,mounts=0;
  const owned={},client={close:async()=>closes++};
  const context={state:{activeProject:'owned',activeTask:'task'},backend:owned,nativeGateSession:{client},nativeGateTransition:false,nativeGateRecovery:null,
    grant:{revoke(){}},kilnRef:null,folderMode:true,mountedProject:'owned',workspaceLabel:'folder',wsRoot:'root',workspaceOptions:{},running:false,priming:false,
    pushSystem(){},save(){},renderAll(){},mountWorkspace:async(...args)=>{mounts++;assert.equal(args[0],owned);assert.equal(args[4],true);if(mounts===1)throw new Error('mount unavailable');}};
  const runtime=evaluate(code+'\n({disconnectNativeAuthority,recoverNativePairing,transition:()=>nativeGateTransition,recovery:()=>nativeGateRecovery})',context);
  await assert.rejects(runtime.disconnectNativeAuthority({restoreRuntime:true}),/mount unavailable/);
  assert.equal(runtime.transition(),true);assert.equal(runtime.recovery().client,client);assert.equal(runtime.recovery().backend,owned);
  await assert.rejects(runtime.disconnectNativeAuthority({restoreRuntime:true}),/transition is in progress/);
  await runtime.recoverNativePairing();assert.equal(mounts,2);assert.equal(closes,2);assert.equal(runtime.transition(),false);assert.equal(runtime.recovery(),null);
});

test('native task switching keeps the lock across new project identity and asynchronous remount', async () => {
  const source=await inlineModule();
  const code=['nativeAuthorityTransition','disconnectNativeAuthority','selectTask'].map(name=>extractFunction(source,name)).join('\n');
  let release,entered;
  const ready=new Promise(resolve=>entered=resolve);
  const context={state:{activeTask:'before',activeProject:'old',projects:[{id:'next',tasks:[{id:'after'}]}]},backend:{},nativeGateSession:{client:{close:async()=>{}}},
    nativeGateTransition:false,nativeGateRecovery:null,kilnRef:null,folderMode:false,mountedProject:'old',grant:{revoke(){}},workspaceLabel:'old',wsRoot:'',workspaceOptions:{},running:false,priming:false,primeAbortController:null,activeRangeEdit:null,
    pushSystem(){},save(){},renderAll(){},mountProject:async(project,internal)=>{assert.equal(project,'next');assert.equal(internal,true);entered();await new Promise(resolve=>release=resolve);}};
  const runtime=evaluate(code+'\n({selectTask,transition:()=>nativeGateTransition})',context);
  const switching=runtime.selectTask('after');await ready;
  assert.equal(context.state.activeProject,'next');assert.equal(runtime.transition(),true);
  await runtime.selectTask('other');assert.equal(context.state.activeTask,'after');
  release();await switching;assert.equal(runtime.transition(),false);
});

test('Send preserves the composer while a workspace transition rejects submission', async () => {
  const source=await inlineModule(),prompt={value:'retain this request'};
  let starts=0;
  const submit=evaluate(extractFunction(source,'submit')+'\nsubmit',{nativeGateTransition:true,pushSystem(){},$:()=>prompt,
    activeTask:()=>({}),priming:false,running:false,autoGrow(){},admitRun:()=>({admit:true}),state:{},runTask:()=>starts++});
  assert.equal(submit(),false);assert.equal(prompt.value,'retain this request');assert.equal(starts,0);
});

test('review submission preserves drafts and composer when authority or input changes during validation', async () => {
  const source=await inlineModule();
  for(const changed of ['transition','priming','composer','backend','filesystem','none']){
    let release,entered,sends=0;
    const ready=new Promise(resolve=>entered=resolve),field={value:''};
    const draft={run:2,project:'owned',workspace:'folder',file:'a.mjs',version:reviewVersion('current'),anchorLine:1,text:'Keep this guard.'};
    const task={reviewDrafts:[draft]};
    const context={nativeGateTransition:false,running:false,priming:false,state:{activeProject:'owned'},workspaceLabel:'folder',backend:{},fs:{},
      activeTask:()=>task,$:()=>field,reviewVersion,reviewPrompt,autoGrow(){},save(){},renderPreview(){},pushSystem(){},
      submit(){sends++;field.value='';return true;},readReviewState:async()=>{entered();await new Promise(resolve=>release=resolve);return 'current';}};
    const runtime=evaluate(extractFunction(source,'submitReviewDrafts')+'\n({submitReviewDrafts,change:kind=>{if(kind===\'transition\')nativeGateTransition=true;if(kind===\'priming\')priming=true;if(kind===\'backend\')backend={};if(kind===\'filesystem\')fs={};}})',context);
    const pending=runtime.submitReviewDrafts(2);await ready;
    if(changed==='composer')field.value='owner typed while checking';else runtime.change(changed);
    release();await pending;
    assert.equal(sends,changed==='none'?1:0,changed);
    assert.equal(task.reviewDrafts.length,changed==='none'?0:1,changed);
    assert.equal(field.value,changed==='composer'?'owner typed while checking':'',changed);
  }
});

test('campaign preparation and execution exclude workspace transitions and recheck late authority', async () => {
  const source=await inlineModule();
  const code=['startCampaign','nativeAuthorityTransition'].map(name=>extractFunction(source,name)).join('\n');
  for(const changed of ['none','transition','backend','project','preparation-error','execution-error']){
    let releaseRole,roleEntered,releaseRun,runEntered,starts=0,renders=0;
    const roleReady=new Promise(resolve=>roleEntered=resolve),runReady=new Promise(resolve=>runEntered=resolve);
    let roles=0;
    const context={nativeGateTransition:false,nativeGateRecovery:null,nativeGateSession:null,campaignBusy:false,campaignRun:null,
      backend:{},state:{activeProject:'owned'},grant:{},nak:null,pushSystem(){},raise(){},id:()=>1,newRootKey:()=>({}),
      mintRole:async()=>{if(++roles===1){roleEntered();await new Promise(resolve=>releaseRole=resolve);}if(changed==='preparation-error')throw new Error('role refused');return {};},
      createAssayLedger:()=>({}),demoExecutors:()=>({}),renderCampaign:()=>renders++,runCampaign:async()=>{starts++;runEntered();await new Promise(resolve=>releaseRun=resolve);if(changed==='execution-error')throw new Error('execution failed');return {status:'done'};}};
    const runtime=evaluate(code+'\n({startCampaign,nativeAuthorityTransition,busy:()=>campaignBusy,change:kind=>{if(kind===\'transition\')nativeGateTransition=true;if(kind===\'backend\')backend={};if(kind===\'project\')state.activeProject=\'other\';},campaign:()=>campaignRun})',context);
    const pending=runtime.startCampaign('synthetic goal');await roleReady;
    assert.equal(runtime.busy(),true);
    await assert.rejects(runtime.nativeAuthorityTransition(async()=>{}),/campaign/);
    await runtime.startCampaign('second');assert.equal(roles,1,'no concurrent preparation');
    runtime.change(changed);releaseRole();
    if(changed==='preparation-error')await assert.rejects(pending,/role refused/);
    else if(changed==='none'||changed==='execution-error'){
      await runReady;assert.equal(runtime.busy(),true);
      await assert.rejects(runtime.nativeAuthorityTransition(async()=>{}),/campaign/);
      releaseRun();
      if(changed==='execution-error')await assert.rejects(pending,/execution failed/);else await pending;
    }else{await pending;assert.equal(renders,0);assert.equal(runtime.campaign(),null);}
    assert.equal(starts,changed==='none'||changed==='execution-error'?1:0,changed);
    assert.equal(runtime.busy(),false,changed);
  }
});

test('actual pairing revokes the old Kiln face and removes its runtime before granting the native shell', async () => {
  const source=await inlineModule(),fs=createFileops({backend:new MemoryBackend()});
  const git=createGitCore({fs,dir:'/'}),registry=buildRigRegistry({fs,git});
  const oldGrant=createGrant({prefixes:[''],scopes:['fs:read','fs:write']});
  const oldFace=createAgentFace({registry,grant:oldGrant,opLog:createOpLog({fs:createFileops({backend:new MemoryBackend()})})});
  assert.equal((await oldFace.invoke('fs.write',{path:'sibling',data:'before',createParents:true})).ok,true);
  let closes=0;
  const client={connect:async()=>({mutable:'sys/candidate.mjs',commandCount:1}),close:async()=>{},run:async()=>({code:0,output:'PASS'})};
  const declarations=['const AGENT_SCOPES =','const agentGrant =','const agentShell ='].map(prefix=>source.split('\n').find(line=>line.trimStart().startsWith(prefix))).join('\n');
  const start=source.indexOf('  nativeGatePicker.onchange=async()=>{'),end=source.indexOf('  // Test hooks:',start);
  const picker={files:[{size:100,text:async()=>JSON.stringify(descriptor())}],value:''};
  const context={createGrant,createAgentFace,createOpLog,createShell,buildRigRegistry,registry,fs,git,backend:{},state:{activeProject:'project'},grant:oldGrant,
    workspaceLabel:'owned',wsRoot:'',workspaceOptions:{},face:oldFace,opLog:createOpLog({fs:createFileops({backend:new MemoryBackend()})}),nativeGateSession:null,nativeGateTransition:false,nativeGateRecovery:null,
    nativeGatePicker:picker,campaignBusy:false,kilnRef:{close:async()=>closes++},jsHost:null,abortController:null,activeRangeEdit:null,running:false,priming:false,
    SKILLS_DIR:'.anvil/skills',GATE_DIR:'.anvil/gate',SEARCH_INDEX_PATH:'.anvil/search-index.json',HOOKS_FILE:'.anvil/hooks.json',NATIVE_BINDING_PATH:'.anvil/gate/native-binding.json',
    guardCriticalShellInvocation(){},createNativeGateClient:()=>client,syncMode(){},pushSystem(){}};
  const runtime=evaluate(declarations+'\n'+extractFunction(source,'rebuildNativeAuthority')+'\n'+source.slice(start,end)+'\n({pair:()=>nativeGatePicker.onchange(),currentKiln:()=>kilnRef,currentFace:()=>face})',context);
  await runtime.pair();assert.equal(closes,1);assert.equal(runtime.currentKiln(),null);
  const synced=await syncWorkerSnapshot({before:{dirs:[],files:[]},after:{dirs:[],files:[{path:'sibling',data:new Uint8Array([1])}]},face:oldFace});
  assert.equal(synced.writes.length,0);assert.equal(synced.errors[0].result.code,'EGRANT');
  assert.equal((await runtime.currentFace().invoke('fs.write',{path:'sys/candidate.mjs',data:'approved',createParents:true})).ok,true);
});

test('actual pairing failure retains unconfirmed Worker closure and restores the captured mount only after acknowledgement', async () => {
  const source=await inlineModule();
  const start=source.indexOf('  nativeGatePicker.onchange=async()=>{'),end=source.indexOf('  // Test hooks:',start);
  for(const phase of ['teardown','registry','unconfirmed']){
    let recovered=0,closed=0,revoked=0,kilnCloses=0,acknowledged=false;
    const backend={},options={exclusive:false};
    const context={fs:{},backend,workspaceLabel:'owned Folder',wsRoot:'selected',workspaceOptions:options,
      state:{activeProject:'project'},nativeGateSession:null,nativeGateTransition:false,nativeGateRecovery:null,campaignBusy:false,running:false,priming:false,activeRangeEdit:null,
      nativeGatePicker:{files:[{size:100,text:async()=>JSON.stringify(descriptor())}],value:''},
      grant:{revoke:()=>revoked++},kilnRef:{close:async()=>{kilnCloses++;if((phase==='teardown'&&kilnCloses===1)||(phase==='unconfirmed'&&!acknowledged))throw new Error('teardown failure');}},
      createNativeGateClient:()=>({connect:async()=>({mutable:'sys/candidate.mjs',commandCount:1}),close:async()=>closed++}),
      rebuildNativeAuthority:async()=>{throw new Error('registry failure');},
      mountWorkspace:async(b,label,root,opts,recovery)=>{
        assert.equal(b,backend);assert.equal(label,'owned Folder');assert.equal(root,'selected');assert.equal(opts,options);assert.equal(recovery,true);recovered++;
      },pushSystem(){},NATIVE_BINDING_PATH:'.anvil/gate/native-binding.json'};
    const runtime=evaluate(extractFunction(source,'recoverNativePairing')+'\n'+source.slice(start,end)+'\n({pair:()=>nativeGatePicker.onchange(),recover:()=>recoverNativePairing(),session:()=>nativeGateSession,transition:()=>nativeGateTransition,pending:()=>nativeGateRecovery})',context);
    await runtime.pair();assert.equal(revoked,2);assert.equal(closed,1);
    if(phase==='unconfirmed'){
      assert.equal(recovered,0);assert.equal(runtime.transition(),true);assert.equal(runtime.pending().kiln,context.kilnRef);
      acknowledged=true;await runtime.recover();assert.equal(closed,2);assert.equal(recovered,1);
    }else assert.equal(recovered,1);
    assert.equal(runtime.session(),null);assert.equal(runtime.transition(),false);
    assert.equal(runtime.pending(),null);
  }
});

test('native profile denies by default and confines writable files to the copied view', () => {
  const profile=sandboxProfile({view:'/private/tmp/owned/view',nodePath:'/usr/local/bin/node'});
  assert.match(profile,/\(deny default\)/);assert.match(profile,/\(deny file-write\* \(subpath "\/private\/tmp\/owned\/view\/\.git"\)\)/);
  assert.doesNotMatch(profile,/\(allow default\)/);assert.doesNotMatch(profile,/\(allow network\*\)/);
});

test('real native full/criterion gates, source pinning, containment, and cancellation', {skip:process.platform!=='darwin',timeout:60000}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-gate-contract-'));
  const checkout=path.join(root,'checkout');await fs.mkdir(checkout);
  let server,client;
  try{
    await exec('/usr/bin/git',['init',checkout]);
    await fs.mkdir(path.join(checkout,'scripts'));await fs.mkdir(path.join(checkout,'sys'));
    await fs.mkdir(path.join(checkout,'.github/workflows'),{recursive:true});
    const sentinel=path.join(root,'outside-sentinel.txt');await fs.writeFile(sentinel,'PRIVATE SYNTHETIC SENTINEL');
    const gate=`import assert from 'node:assert/strict';\nimport fs from 'node:fs/promises';\nimport {execFileSync} from 'node:child_process';\nimport { value } from '../sys/candidate.mjs';\nassert.match(execFileSync('git',['rev-parse','--verify','HEAD'],{encoding:'utf-8'}).trim(),/^[a-f0-9]{40}$/);\nassert.equal(execFileSync('python3',['-I','-c','import sqlite3; assert hasattr(sqlite3.Connection, "serialize"); assert hasattr(sqlite3.Connection, "deserialize"); print("sqlite runtime PASS")'],{encoding:'utf-8'}).trim(),'sqlite runtime PASS');\nassert.equal(value===42||value==='slow',true);\nawait assert.rejects(fs.readFile(${JSON.stringify(sentinel)}),e=>e.code==='EPERM'||e.code==='EACCES');\nawait assert.rejects(fs.writeFile(${JSON.stringify(sentinel)},'changed'),e=>e.code==='EPERM'||e.code==='EACCES');\nawait assert.rejects(fs.writeFile('scripts/gate.mjs','weakened assertion'),e=>e.code==='EPERM'||e.code==='EACCES');\nawait fs.writeFile('.tmp/gate-work.txt','private view only');\nif(value==='slow')await new Promise(r=>setTimeout(r,45000));\nconsole.log('native contract PASS');\n`;
    await fs.writeFile(path.join(checkout,'scripts/gate.mjs'),gate);
    await fs.writeFile(path.join(checkout,'sys/candidate.mjs'),'export const value=41;\n');
    await fs.writeFile(path.join(checkout,'.github/workflows/test.yml'),'jobs:\n  native:\n    steps:\n      - run: node scripts/gate.mjs\n');
    await exec('/usr/bin/git',['-C',checkout,'add','.']);
    await exec('/usr/bin/git',['-C',checkout,'-c','user.name=Native QA','-c','user.email=native-qa@example.invalid','commit','-m','Frozen native fixture']);
    await fs.writeFile(path.join(checkout,'sys/untracked-input.mjs'),'export const frozen=1;\n');
    const origin='http://127.0.0.1:8948';
    await assert.rejects(createNativeGateServer({checkout,mutable:'.github/workflows/test.yml',criterion:'scripts/gate.mjs',origin,runtimeParent:root}),/production file/);
    server=await createNativeGateServer({checkout,mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs',origin,runtimeParent:root});
    const connection=JSON.parse(await fs.readFile(server.connectionFile,'utf8'));
    const fetchWithOrigin=(url,opts)=>fetch(url,{...opts,headers:{...opts.headers,Origin:origin}});
    client=createNativeGateClient({connection,readBinding:()=>fs.readFile(path.join(checkout,'.anvil/gate/native-binding.json'),'utf8'),fetch:fetchWithOrigin});
    assert.equal((await client.connect()).commandCount,1);
    const unauth=await fetchWithOrigin(connection.endpoint+'status',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(unauth.status,401);
    const foreign=await fetch(connection.endpoint+'status',{method:'POST',headers:{Origin:'https://foreign.invalid'},body:'{}'});assert.equal(foreign.status,403);
    const injection=await fetchWithOrigin(connection.endpoint+'run',{method:'POST',headers:{Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify({mode:'full',command:'touch /tmp/escape'})});assert.equal(injection.status,400);
    const before=await client.run('criterion');assert.equal(before.state,'failed');assert.notEqual(before.code,0);
    await fs.writeFile(path.join(checkout,'sys/candidate.mjs'),'export const value=42;\n');
    const after=await client.run('full');assert.equal(after.state,'passed',after.output);assert.equal(after.code,0);
    assert.equal(await fs.readFile(sentinel,'utf8'),'PRIVATE SYNTHETIC SENTINEL');
    await assert.rejects(fs.stat(path.join(checkout,'.tmp/gate-work.txt')),e=>e.code==='ENOENT');
    const passedReceipt=JSON.parse(await fs.readFile(path.join(server.runtime,after.receipt),'utf8'));
    assert.ok(passedReceipt.sourceFiles['sys/untracked-input.mjs']);
    await fs.writeFile(path.join(checkout,'sys/untracked-input.mjs'),'export const frozen=2;\n');
    const untrackedTamper=await client.run('full');assert.equal(untrackedTamper.state,'failed');assert.match(untrackedTamper.output,/Frozen source changed/);
    await fs.writeFile(path.join(checkout,'sys/untracked-input.mjs'),'export const frozen=1;\n');
    await fs.writeFile(path.join(checkout,'scripts/gate.mjs'),gate+'console.log("tampered");\n');
    const tampered=await client.run('full');assert.equal(tampered.state,'failed');assert.match(tampered.output,/Frozen source changed/);
    await fs.writeFile(path.join(checkout,'scripts/gate.mjs'),gate);
    await fs.writeFile(path.join(checkout,'sys/candidate.mjs'),"export const value='slow';\n");
    const stop=new AbortController();const pending=client.run('full',{signal:stop.signal});
    setTimeout(()=>stop.abort(),500);const cancelled=await pending;assert.equal(cancelled.code,130);assert.equal(cancelled.state,'cancelled');
    const receipt=JSON.parse(await fs.readFile(path.join(server.runtime,cancelled.receipt),'utf8'));assert.equal(receipt.code,130);
    const owner=JSON.parse(await fs.readFile(server.connectionFile,'utf8'));
    const cancel=()=>fetch(new URL('cancel',server.endpoint),{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+owner.token,'Content-Type':'application/json'},body:JSON.stringify({id:cancelled.id})}).then(r=>r.json());
    const repeated=await Promise.all(Array.from({length:8},cancel));
    assert.ok(repeated.every(r=>r.state==='cancelled'&&r.code===130));
    const finalReceipt=JSON.parse(await fs.readFile(path.join(server.runtime,cancelled.receipt),'utf8'));
    assert.equal(finalReceipt.state,'cancelled');assert.equal(finalReceipt.code,130);
    assert.ok(!(await fs.readdir(path.dirname(path.join(server.runtime,cancelled.receipt)))).some(name=>name.endsWith('.tmp')));
    assert.equal(await fs.readFile(sentinel,'utf8'),'PRIVATE SYNTHETIC SENTINEL');
  }finally{if(client)await client.close();if(server)await server.close();await fs.rm(root,{recursive:true,force:true});}
});

test('pairing refuses ignored symlink ancestors without creating markers outside the checkout', {skip:process.platform!=='darwin',timeout:30000}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-pairing-ancestry-'));
  const checkout=path.join(root,'checkout'),outside=path.join(root,'outside');
  let server;
  try{
    await fs.mkdir(path.join(checkout,'scripts'),{recursive:true});await fs.mkdir(path.join(checkout,'sys'));
    await fs.mkdir(path.join(checkout,'.github/workflows'),{recursive:true});await fs.mkdir(outside);
    await fs.writeFile(path.join(checkout,'.gitignore'),'.anvil\n');
    await fs.writeFile(path.join(checkout,'sys/candidate.mjs'),'export const value=42;\n');
    await fs.writeFile(path.join(checkout,'scripts/gate.mjs'),'console.log("owner criterion PASS");\n');
    await fs.writeFile(path.join(checkout,'.github/workflows/test.yml'),'jobs:\n  native:\n    steps:\n      - run: node scripts/gate.mjs\n');
    await exec('/usr/bin/git',['init',checkout]);await exec('/usr/bin/git',['-C',checkout,'add','.']);
    await exec('/usr/bin/git',['-C',checkout,'-c','user.name=Native QA','-c','user.email=native-qa@example.invalid','commit','-m','Pairing ancestry fixture']);
    const options={checkout,mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs',origin:'http://127.0.0.1:8948',runtimeParent:root};
    const inside=path.join(checkout,'empty-owned-directory');await fs.mkdir(inside);
    for(const [level,target] of [['.anvil',outside],['.anvil/gate',outside],['.anvil',inside]]){
      await fs.rm(path.join(checkout,'.anvil'),{recursive:true,force:true});
      if(level.includes('/'))await fs.mkdir(path.join(checkout,'.anvil'));
      await fs.symlink(target,path.join(checkout,level));
      await assert.rejects(createNativeGateServer(options),/Pairing directory/);
      assert.deepEqual(await fs.readdir(outside),[],'no outside marker or gate directory');
      assert.deepEqual(await fs.readdir(inside),[],'no marker through an inside-root symlink');
      assert.deepEqual((await fs.readdir(root)).filter(name=>name.startsWith('naklios-native-gate-')),[]);
    }
    await fs.rm(path.join(checkout,'.anvil'),{recursive:true,force:true});
    await fs.mkdir(path.join(checkout,'.anvil/gate'),{recursive:true});
    const criterion='.anvil/gate/cap-handoff.mjs';
    await fs.writeFile(path.join(checkout,criterion),'console.log("frozen .anvil criterion PASS");\n');
    server=await createNativeGateServer({...options,criterion});
    const connection=JSON.parse(await fs.readFile(server.connectionFile,'utf8'));
    const client=createNativeGateClient({connection,readBinding:()=>fs.readFile(path.join(checkout,'.anvil/gate/native-binding.json'),'utf8'),
      fetch:(url,opts)=>fetch(url,{...opts,headers:{...opts.headers,Origin:options.origin}})});
    assert.equal((await client.connect()).criterion,criterion);
    assert.equal((await client.run('criterion')).state,'passed');
    await client.close();
  }finally{if(server)await server.close();await fs.rm(root,{recursive:true,force:true});}
});

test('failed native startup removes only its own binding; receipt failure never exposes success', {skip:process.platform!=='darwin',timeout:30000}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'native-gate-persistence-'));
  const checkout=path.join(root,'checkout'),origin='http://127.0.0.1:8948';
  const occupied=http.createServer();let server;
  try{
    await fs.mkdir(path.join(checkout,'scripts'),{recursive:true});await fs.mkdir(path.join(checkout,'sys'));
    await fs.mkdir(path.join(checkout,'.github/workflows'),{recursive:true});
    await fs.writeFile(path.join(checkout,'sys/candidate.mjs'),'export const value=42;\n');
    const gate=`import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {value} from '../sys/candidate.mjs';assert.equal(value,42);console.log('receipt proof READY');let released=false;for(let i=0;i<1000;i++){try{await fs.readFile('.tmp/release');released=true;break;}catch{await new Promise(r=>setTimeout(r,5));}}assert.equal(released,true);console.log('receipt proof PASS');\n`;
    await fs.writeFile(path.join(checkout,'scripts/gate.mjs'),gate);
    await fs.writeFile(path.join(checkout,'.github/workflows/test.yml'),'jobs:\n  native:\n    steps:\n      - run: node scripts/gate.mjs\n');
    await exec('/usr/bin/git',['init',checkout]);await exec('/usr/bin/git',['-C',checkout,'add','.']);
    await exec('/usr/bin/git',['-C',checkout,'-c','user.name=Native QA','-c','user.email=native-qa@example.invalid','commit','-m','Frozen persistence fixture']);
    const options={checkout,mutable:'sys/candidate.mjs',criterion:'scripts/gate.mjs',origin,runtimeParent:root};
    const marker=path.join(checkout,'.anvil/gate/native-binding.json');
    await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
    await assert.rejects(createNativeGateServer({...options,port:occupied.address().port}),error=>error.code==='EADDRINUSE');
    await assert.rejects(fs.stat(marker),error=>error.code==='ENOENT');
    assert.deepEqual((await fs.readdir(root)).filter(name=>name.startsWith('naklios-native-gate-')),[]);
    await fs.writeFile(marker,'FOREIGN OWNER BINDING');
    await assert.rejects(createNativeGateServer(options),error=>error.code==='EEXIST');
    assert.equal(await fs.readFile(marker,'utf8'),'FOREIGN OWNER BINDING');await fs.unlink(marker);
    server=await createNativeGateServer(options);
    const connection=JSON.parse(await fs.readFile(server.connectionFile,'utf8'));
    const request=async(route,body)=>{
      const response=await fetch(connection.endpoint+route,{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+connection.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
      assert.equal(response.ok,true);return response.json();
    };
    const id='receipt-fault-owned-0001';await request('run',{id,mode:'full'});
    const directory=path.join(server.runtime,id);
    let ready=false;
    for(let i=0;i<1000;i++){
      try{ready=(await fs.readFile(path.join(directory,'output.log'),'utf8')).includes('receipt proof READY');}catch{}
      if(ready)break;await new Promise(r=>setTimeout(r,5));
    }
    assert.equal(ready,true,'actual native gate reaches its positive fixture before receipt I/O fails');
    await fs.mkdir(path.join(directory,'receipt.json'));
    await fs.writeFile(path.join(directory,'view/.tmp/release'),'owner releases fixed gate');
    let result;
    for(let i=0;i<1000;i++){
      result=await request('job',{id});if(result.state!=='running')break;
      await new Promise(r=>setTimeout(r,5));
    }
    assert.equal(result.state,'failed');assert.equal(result.code,1);assert.equal(result.completedCommands,1);
    assert.equal(result.receipt,null);assert.match(result.output,/receipt persistence failed/);
    assert.match(await fs.readFile(path.join(directory,'output.log'),'utf8'),/receipt proof PASS/);
  }finally{
    if(server)await server.close();
    if(occupied.listening)await new Promise(resolve=>occupied.close(resolve));
    await fs.rm(root,{recursive:true,force:true});
  }
});
