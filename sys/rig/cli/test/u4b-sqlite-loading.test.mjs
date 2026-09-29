import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainThreadKiln } from '../../../kiln/main-thread-runtime.mjs';

test('SQLite main-thread cancellation during private loading prevents execution', {timeout:3000}, async()=>{
  let entered,release,runs=0;
  const loading=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const py={FS:{mkdirTree(){},readdir:()=>['.','..']},runPython(){},setStdout(){},setStderr(){},setStdin(){},async runPythonAsync(){runs++;}};
  const fs={list:async()=>({ok:true,entries:[]}),write:async()=>({ok:true}),remove:async()=>({ok:true})};
  const kiln=createMainThreadKiln({fs,loadPyodide:async()=>{entered();await held;return py;}});
  const controller=new AbortController();
  const pending=kiln.exec('cancel-during-load','must-not-run',{interpreter:'sqlite',signal:controller.signal});
  await loading;controller.abort();release();
  const result=await pending;
  assert.equal(result.status,'interrupted');assert.equal(runs,0);
});
