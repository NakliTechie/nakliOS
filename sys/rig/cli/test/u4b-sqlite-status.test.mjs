import test from 'node:test';
import assert from 'node:assert/strict';
import { createKiln } from '../../../kiln/kiln.mjs';

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const runtime=()=>({runCode:async()=>({stdout:'',stderr:''}),listNames:()=>[],inspect:()=>null,reset(){}});
const sql={interpreter:'sqlite'};
const privateStatus={purpose:'sqlite'};

test('SQLite readiness never reports ordinary Python ready before ordinary loading',async()=>{
  const loads=[],kiln=createKiln({consent:()=>true,loadRuntime:async options=>{loads.push(options?.purpose||'python');return runtime();}});
  assert.equal(kiln.status(),'unloaded');assert.equal(kiln.status(privateStatus),'unloaded');assert.deepEqual(loads,[]);
  assert.equal((await kiln.exec('sql','sql-marker',sql)).status,'ok');
  assert.equal(kiln.status(),'unloaded');assert.equal(kiln.status({purpose:'python'}),'unloaded');assert.equal(kiln.status(privateStatus),'ready');
  assert.deepEqual(loads,['sqlite']);
  assert.equal((await kiln.ensureReady()).ok,true);assert.equal(kiln.status(),'ready');assert.equal(kiln.status(privateStatus),'ready');
  assert.deepEqual(loads,['sqlite','python']);
});

test('SQLite loading and unavailable status never replace unloaded ordinary Python status',async()=>{
  const entered=deferred(),release=deferred(),kiln=createKiln({consent:()=>true,loadRuntime:async()=>{entered.resolve();await release.promise;throw new Error('private unavailable');}});
  const pending=kiln.exec('sql','sql-marker',sql);await entered.promise;
  const whileLoading={ordinary:kiln.status(),private:kiln.status(privateStatus)};
  release.resolve();assert.equal((await pending).status,'unavailable');
  assert.deepEqual(whileLoading,{ordinary:'unloaded',private:'loading'});
  assert.equal(kiln.status(),'unloaded');assert.equal(kiln.status(privateStatus),'unavailable');
});

test('SQLite explicit status stays private while ordinary Python loads or fails',async()=>{
  const entered=deferred(),release=deferred(),loads=[];
  const kiln=createKiln({consent:()=>true,loadRuntime:async options=>{
    loads.push(options?.purpose||'python');if(options?.purpose==='sqlite')return runtime();
    entered.resolve();await release.promise;throw new Error('ordinary unavailable');
  }});
  assert.equal((await kiln.exec('sql','sql-marker',sql)).status,'ok');
  const pending=kiln.ensureReady();await entered.promise;
  const whileLoading={ordinary:kiln.status(),private:kiln.status(privateStatus)};
  release.resolve();assert.equal((await pending).ok,false);
  assert.deepEqual(whileLoading,{ordinary:'loading',private:'ready'});
  assert.equal(kiln.status(),'unavailable');assert.equal(kiln.status(privateStatus),'ready');
  assert.deepEqual(loads,['sqlite','python']);
});
