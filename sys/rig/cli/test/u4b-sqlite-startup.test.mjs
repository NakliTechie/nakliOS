import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createKiln } from '../../../kiln/kiln.mjs';
import { createMainThreadKiln } from '../../../kiln/main-thread-runtime.mjs';

// Runtime orchestration only. Separate host/browser suites execute actual SQL.
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function promptly(promise){let timer;try{return await Promise.race([promise,new Promise(resolve=>{timer=setTimeout(()=>resolve({status:'test-wait-expired'}),250);})]);}finally{clearTimeout(timer);}}
const privateOptions={interpreter:'sqlite',timeoutMs:0};
function setup(mode,{holdExecution=false}={}){
  const entered=deferred(),loaded=deferred(),started=deferred(),execution=deferred(),calls=[];
  let loads=0,writes=0,interrupts=0;
  const run=async code=>{calls.push(code);started.resolve();if(holdExecution)await execution.promise;return {stdout:'ok\n',stderr:''};};
  const runtime={runCode:run,listNames:()=>[],inspect:()=>null,reset(){},interrupt(){interrupts++;execution.resolve();}};
  const py={FS:{mkdirTree(){},readdir:()=>['.','..']},runPython(){},setStdout(){},setStderr(){},setStdin(){},runPythonAsync:run};
  const loader=async()=>{loads++;entered.resolve();await loaded.promise;return mode==='worker'?runtime:py;};
  const fs={list:async()=>({ok:true,entries:[]}),write:async()=>{writes++;return {ok:true};},remove:async()=>{writes++;return {ok:true};}};
  const kiln=mode==='worker'?createKiln({consent:()=>true,loadRuntime:loader}):createMainThreadKiln({fs,loadPyodide:loader});
  return {kiln,entered,loaded,started,execution,calls,get loads(){return loads;},get writes(){return writes;},get interrupts(){return interrupts;}};
}
const noListeners=signal=>assert.equal(getEventListeners(signal,'abort').length,0,'startup releases its abort listeners');

for(const mode of ['worker','main']){
  test(`SQLite ${mode} abort returns while its private loader never settles`,{timeout:2000},async()=>{
    const h=setup(mode),controller=new AbortController();
    const pending=h.kiln.exec('cancelled','must-not-run',{...privateOptions,signal:controller.signal});
    await h.entered.promise;controller.abort();
    const result=await promptly(pending);
    assert.equal(result.status,'interrupted','abort must not await the stalled loader');
    assert.deepEqual(h.calls,[]);assert.equal(h.writes,0);noListeners(controller.signal);
  });

  test(`SQLite ${mode} startup deadline returns unavailable while its loader never settles`,{timeout:2000},async()=>{
    const h=setup(mode),controller=new AbortController();
    const result=await promptly(h.kiln.exec('timeout','must-not-run',{...privateOptions,signal:controller.signal,loadTimeoutMs:10}));
    assert.equal(result.status,'unavailable','startup deadline must bound a stalled loader');
    assert.match(String(result.message||result.stderr),/load|initial|timeout|timed out/i);
    assert.deepEqual(h.calls,[]);assert.equal(h.writes,0);noListeners(controller.signal);
  });

  for(const reason of ['abort','timeout'])test(`SQLite ${mode} late startup after ${reason} never executes the abandoned cell and remains reusable`,{timeout:2000},async()=>{
    const h=setup(mode),controller=new AbortController();
    const pending=h.kiln.exec('abandoned','must-not-run',{...privateOptions,signal:controller.signal,loadTimeoutMs:reason==='timeout'?10:1000});
    await h.entered.promise;if(reason==='abort')controller.abort();
    const first=await promptly(pending);
    h.loaded.resolve();await delay(10);
    const staleCalls=[...h.calls],staleWrites=h.writes;
    const next=await promptly(h.kiln.exec('next','next-marker',{...privateOptions,loadTimeoutMs:10}));
    assert.equal(first.status,reason==='abort'?'interrupted':'unavailable');
    assert.deepEqual(staleCalls,[],'late initialization never executes an abandoned cell');assert.equal(staleWrites,0);
    assert.equal(next.status,'ok');assert.deepEqual(h.calls,['next-marker']);assert.equal(h.loads,1,'completed private runtime is reusable');
    noListeners(controller.signal);
  });

  test(`SQLite ${mode} startup deadline never races active owned execution`,{timeout:2000},async()=>{
    const h=setup(mode,{holdExecution:true}),controller=new AbortController();h.loaded.resolve();
    let settled=false;const pending=h.kiln.exec('owned','owned-marker',{...privateOptions,signal:controller.signal,loadTimeoutMs:10});
    pending.then(()=>{settled=true;});await h.started.promise;await delay(35);
    const settledBeforeRelease=settled;h.execution.resolve();const result=await pending;
    assert.equal(settledBeforeRelease,false,'load timeout ends when execution starts');assert.equal(result.status,'ok');
    assert.deepEqual(h.calls,['owned-marker']);assert.equal(h.interrupts,0);noListeners(controller.signal);
  });

  test(`SQLite ${mode} canceled startup releases its queue without executing stale cells`,{timeout:2000},async()=>{
    const h=setup(mode),controller=new AbortController();
    const first=h.kiln.exec('first','first-must-not-run',{...privateOptions,signal:controller.signal,loadTimeoutMs:1000});
    await h.entered.promise;
    const second=h.kiln.exec('second','second-must-not-run',{...privateOptions,loadTimeoutMs:10});controller.abort();
    const cancelled=await promptly(first),timedOut=await promptly(second);
    h.loaded.resolve();await delay(10);const staleCalls=[...h.calls];
    const next=await promptly(h.kiln.exec('third','third-marker',{...privateOptions,loadTimeoutMs:10}));
    assert.equal(cancelled.status,'interrupted');assert.equal(timedOut.status,'unavailable');assert.deepEqual(staleCalls,[]);
    assert.equal(next.status,'ok');assert.deepEqual(h.calls,['third-marker']);assert.equal(h.loads,1);assert.equal(h.writes,0);
    noListeners(controller.signal);
  });
}
