import test from 'node:test';
import assert from 'node:assert/strict';
import { createKiln } from '../../../kiln/kiln.mjs';
import { createMainThreadKiln } from '../../../kiln/main-thread-runtime.mjs';
import { fresh, decode } from './u3-harness.mjs';
import { hostPython } from './u4b-sqlite-host.mjs';

// Orchestration-only regressions. These mocks do not interpret SQL. Actual SQL
// and interpreter-poisoning evidence comes from the independent browser checks.
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise,resolve}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function runtime(name, hold = false) {
  const started = deferred(), release = deferred(), calls = [];
  const value = {
    name, calls, started, release, interrupts: 0, closes: 0,
    async runCode(code) { calls.push(code); started.resolve(); if (hold) await release.promise; return {stdout:name+'\n',stderr:'',interrupted:value.interrupts>0}; },
    interrupt() { value.interrupts++; release.resolve(); },
    close() { value.closes++; }, listNames: () => [], inspect: () => null, reset() {},
  };
  return value;
}
const sqlite = {interpreter:'sqlite',timeoutMs:0};

test('SQLite public command requests the private interpreter for real SQL', async t => {
  const kiln=hostPython(t),ctx=fresh({kiln});
  const result=await ctx.run("sqlite3 :memory: 'SELECT 6*7'");
  assert.equal(result.code,0,decode(result.stderr));assert.equal(decode(result.stdout),'42\n');
  assert.equal(kiln.calls.length,1);assert.equal(kiln.calls[0].options.interpreter,'sqlite');
  assert.ok(kiln.calls[0].options.signal instanceof AbortSignal,'SQL transports its owned cancellation signal');
});

test('SQLite private loading remains behind consent for either interpreter', async () => {
  const loads = [], kiln = createKiln({consent:()=>false,loadRuntime:async options=>{loads.push(options);return runtime('must-not-load');}});
  for (const options of [{},sqlite]) {
    const r = await kiln.exec('not-run','marker',options);
    assert.equal(r.status,'unavailable'); assert.equal(r.reason,'consent-withheld');
  }
  assert.deepEqual(loads,[]);
});

for (const first of ['python','sqlite']) test(`SQLite and ordinary Python use distinct runtime instances when ${first} loads first`, async () => {
  const channels = {python:runtime('python'),sqlite:runtime('sqlite')}, loads = [];
  const kiln = createKiln({consent:()=>true,loadRuntime:async options=>{const name=options?.purpose||'python';loads.push(name);return channels[name];}});
  const order = first === 'python' ? ['python','sqlite'] : ['sqlite','python'];
  for (const name of order) assert.equal((await kiln.exec(name+'-cell',name+'-marker',name==='sqlite'?sqlite:{})).stdout,name+'\n');
  assert.deepEqual(loads,order); assert.deepEqual(channels.python.calls,['python-marker']); assert.deepEqual(channels.sqlite.calls,['sqlite-marker']);
  await kiln.close(); assert.equal(channels.python.closes,1); assert.equal(channels.sqlite.closes,1);
});

test('SQLite failed private loading never falls back to the ordinary interpreter', async () => {
  const ordinary=runtime('python'),loads=[];
  const kiln=createKiln({consent:()=>true,loadRuntime:async options=>{loads.push(options?.purpose||'python');if(options?.purpose==='sqlite')throw new Error('private unavailable');return ordinary;}});
  assert.equal((await kiln.exec('before','ordinary-before')).status,'ok');
  const r=await kiln.exec('sql','sql-marker',sqlite); assert.equal(r.status,'unavailable'); assert.match(r.message,/private unavailable/);
  assert.equal((await kiln.exec('after','ordinary-after')).status,'ok');
  assert.deepEqual(loads,['python','sqlite']); assert.deepEqual(ordinary.calls,['ordinary-before','ordinary-after']);
});

for(const first of ['python','sqlite']) test(`SQLite refuses reused runtime identity when ${first} loads first`,async()=>{
  const reused=runtime('shared'),kiln=createKiln({consent:()=>true,loadRuntime:async()=>reused});
  const initial=first==='sqlite'?sqlite:{},later=first==='sqlite'?{}:sqlite;
  assert.equal((await kiln.exec('first','first-marker',initial)).status,'ok');
  const r=await kiln.exec('second','must-not-run',later); assert.equal(r.status,'unavailable'); assert.match(r.message,/distinct|private|separate/i);
  assert.deepEqual(reused.calls,['first-marker']);
});

test('SQLite interrupt targets only its matching cell while ordinary Python runs', {timeout:3000}, async()=>{
  const ordinary=runtime('python',true),privateRuntime=runtime('sqlite',true);
  const kiln=createKiln({consent:()=>true,loadRuntime:async options=>options?.purpose==='sqlite'?privateRuntime:ordinary});
  const pythonRun=kiln.exec('python-cell','ordinary',{timeoutMs:0}),sqlRun=kiln.exec('sqlite-cell','sql',sqlite);
  await Promise.all([ordinary.started.promise,privateRuntime.started.promise]);
  assert.equal(kiln.interrupt('unknown-cell').ok,false); assert.equal(ordinary.interrupts,0); assert.equal(privateRuntime.interrupts,0);
  assert.equal(kiln.interrupt('sqlite-cell').ok,true); assert.equal(privateRuntime.interrupts,1); assert.equal(ordinary.interrupts,0);
  assert.equal((await sqlRun).status,'interrupted');
  assert.equal(kiln.interrupt('python-cell').ok,true); assert.equal(ordinary.interrupts,1); assert.equal((await pythonRun).status,'interrupted');
});

test('SQLite canceled queued calls never execute or interrupt the active cell', {timeout:3000}, async()=>{
  const started=deferred(),release=deferred(),calls=[],controller=new AbortController();let interrupts=0;
  const privateRuntime={...runtime('sqlite'),runCode:async code=>{calls.push(code);if(code==='first'){started.resolve();await release.promise;}return {stdout:'',stderr:''};},interrupt(){interrupts++;}};
  const kiln=createKiln({consent:()=>true,loadRuntime:async()=>privateRuntime});
  const active=kiln.exec('active','first',sqlite);await started.promise;
  const queued=kiln.exec('queued','must-not-run',{...sqlite,signal:controller.signal});await tick();controller.abort();
  assert.equal(kiln.interrupt('queued').ok,false);assert.equal(interrupts,0);assert.deepEqual(calls,['first']);
  release.resolve();assert.equal((await active).status,'ok');assert.equal((await queued).status,'interrupted');assert.deepEqual(calls,['first']);
  assert.equal((await kiln.exec('recovered','third',sqlite)).status,'ok');assert.deepEqual(calls,['first','third']);
});

test('SQLite cancellation before private load prevents downloads',async()=>{
  let loads=0;const controller=new AbortController();controller.abort();
  const kiln=createKiln({consent:()=>true,loadRuntime:async()=>{loads++;return runtime('sqlite');}});
  assert.equal((await kiln.exec('cancelled','must-not-run',{...sqlite,signal:controller.signal})).status,'interrupted');assert.equal(loads,0);
});

test('SQLite cancellation during private loading prevents the pending cell from running', {timeout:3000},async()=>{
  const entered=deferred(),release=deferred(),controller=new AbortController(),privateRuntime=runtime('sqlite');
  const kiln=createKiln({consent:()=>true,loadRuntime:async()=>{entered.resolve();await release.promise;return privateRuntime;}});
  const running=kiln.exec('cancelled','must-not-run',{...sqlite,signal:controller.signal});await entered.promise;controller.abort();release.resolve();
  assert.equal((await running).status,'interrupted');assert.deepEqual(privateRuntime.calls,[]);
});

function fakePy(name,{hold}={}){
  const calls=[],started=deferred(),release=deferred();let stdout;
  return {name,calls,started,release,FS:{mkdirTree(){},readdir:()=>['.','..']},runPython(){return null;},setStdout(value){stdout=value?.write;},setStderr(){},setStdin(){},
    async runPythonAsync(code){calls.push(code);started.resolve();if(hold&&code==='first')await release.promise;stdout?.(new TextEncoder().encode(name+'\n'));}};
}
const emptyFs=()=>({list:async()=>({ok:true,entries:[]}),write:async()=>({ok:true}),remove:async()=>({ok:true})});

test('SQLite main-thread execution gets a distinct interpreter and no workspace snapshot',async()=>{
  const ordinary=fakePy('ordinary'),privatePy=fakePy('private');let loads=0,workspaceLists=0;
  const fs={...emptyFs(),list:async()=>{workspaceLists++;return {ok:true,entries:[]};}};
  const kiln=createMainThreadKiln({fs,loadPyodide:async()=>++loads===1?privatePy:ordinary});
  assert.equal((await kiln.exec('sql','sql-marker',sqlite)).stdout,'private\n');assert.equal(workspaceLists,0);
  assert.equal((await kiln.exec('python','python-marker')).stdout,'ordinary\n');assert.equal(workspaceLists,1);
  assert.deepEqual(privatePy.calls,['sql-marker']);assert.deepEqual(ordinary.calls,['python-marker']);assert.equal(loads,2);
});

test('SQLite main-thread private-load failure cannot use ordinary Python',async()=>{
  const ordinary=fakePy('ordinary');let loads=0;
  const kiln=createMainThreadKiln({fs:emptyFs(),loadPyodide:async()=>{if(++loads===1)return ordinary;throw new Error('private unavailable');}});
  assert.equal((await kiln.exec('python','ordinary-marker')).status,'ok');
  const r=await kiln.exec('sql','must-not-run',sqlite);assert.equal(r.status,'unavailable');assert.match(r.message,/private unavailable/);assert.deepEqual(ordinary.calls,['ordinary-marker']);
});

for(const first of ['python','sqlite'])test(`SQLite main-thread rejects reused Pyodide identity when ${first} loads first`,async()=>{
  const reused=fakePy('shared'),kiln=createMainThreadKiln({fs:emptyFs(),loadPyodide:async()=>reused});
  assert.equal((await kiln.exec('first','first-marker',first==='sqlite'?sqlite:{})).status,'ok');
  const r=await kiln.exec('second','must-not-run',first==='sqlite'?{}:sqlite);assert.equal(r.status,'unavailable');assert.match(r.message,/distinct|private|separate/i);assert.deepEqual(reused.calls,['first-marker']);
});

test('SQLite main-thread canceled queued calls never reach runPythonAsync', {timeout:3000},async()=>{
  const py=fakePy('private',{hold:true}),controller=new AbortController(),kiln=createMainThreadKiln({fs:emptyFs(),loadPyodide:async()=>py});
  const active=kiln.exec('active','first',sqlite);await py.started.promise;
  const queued=kiln.exec('queued','must-not-run',{...sqlite,signal:controller.signal});controller.abort();py.release.resolve();
  assert.equal((await active).status,'ok');assert.equal((await queued).status,'interrupted');assert.deepEqual(py.calls,['first']);
});
