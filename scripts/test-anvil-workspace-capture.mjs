import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { CrateBackend } from '../sys/rig/fileops/crate-backend.mjs';
import { createGitCore } from '../sys/rig/git/git-core.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { makeToolExecutor } from '../sys/ai/agent-tools.mjs';
import { createWorkspaceCapture, snapshotWorkspace } from '../sys/ai/workspace-capture.mjs';
import { planRevert, turnChanges, planTurnRevert } from '../sys/ai/change-preimages.mjs';
import { MAX_REVIEW_BYTES } from '../sys/ai/review-diff.mjs';
import { inlineModule, extractFunction, instantiate, memFs } from './anvil-harness.mjs';

function fixture() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  const registry = buildRigRegistry({ fs, git });
  const grant = createGrant({ prefixes:[''], scopes:['fs:read','fs:write','fs:remove','git:read','git:write'] });
  const face = createAgentFace({ registry, grant,
    opLog:createOpLog({ fs:createFileops({ backend:new MemoryBackend() }) }), actor:'capture-test' });
  const shell = createShell({ registry, face });
  const execute = makeToolExecutor({ shell, face, mode:'code' });
  return { fs, execute, shell };
}

test('real shell changes, patch writes, and external runtime writes produce one net review row per file', async () => {
  const { fs, execute } = fixture();
  await fs.write('edit.txt', 'old\n');
  await fs.write('gone.txt', 'delete me\n');
  const capture = createWorkspaceCapture(fs, 7);
  assert.equal((await capture.start()).complete, true);
  const call = async (tool,args) => { const out=await execute(tool,args); await capture.observe(); return out; };
  await call('shell', {command:"sed -i 's/old/new/' edit.txt"});
  await call('shell', {command:'cp edit.txt copied.txt; mv copied.txt moved.txt'});
  await call('shell', {command:'rm gone.txt'});
  await call('shell', {command:"printf '%s\\n' from-redirect > redirect.txt"});
  await call('apply_patch', {patch:'*** Begin Patch\n*** Add File: patch.txt\n+from patch\n*** End Patch'});
  // Kiln/Python receives the same governed workspace. The capture observes its
  // changed bytes without identifying the command that wrote them.
  await fs.write('python.txt', 'from python\n'); await capture.observe();
  await fs.write('temporary.txt', 'created'); await capture.observe();
  await fs.remove('temporary.txt'); await capture.observe();
  const final=await capture.finish();
  assert.equal(final.complete, true, final.problems.join('; '));
  assert.deepEqual(final.rows.map(r=>r.file), ['edit.txt','gone.txt','moved.txt','patch.txt','python.txt','redirect.txt']);
  assert.ok(final.touched.includes('temporary.txt'), 'the touched history survives a net-zero path');
  assert.ok(!final.rows.some(r=>r.file==='temporary.txt'), 'the review shows net change only');
  const by=new Map(final.rows.map(r=>[r.file,r]));
  assert.equal(by.get('edit.txt').pre,'old\n');
  assert.equal(by.get('gone.txt').deleted,true);
  assert.equal(by.get('moved.txt').created,true);
  assert.equal(by.get('patch.txt').created,true);
  assert.equal(turnChanges(final.rows,7).files.length,6);
  assert.equal(planRevert(by.get('moved.txt'),'new\n').action,'remove');
  assert.equal(planRevert(by.get('gone.txt'),undefined).action,'write');
  assert.equal(planRevert(by.get('gone.txt'),null).reason,'unreadable');
  assert.equal(planRevert(by.get('gone.txt'),'another writer').reason,'stale');
});

test('binary changes remain visible without a lossy text pre-image or unsafe revert', async () => {
  const {fs}=fixture();
  await fs.write('artifact.bin',Uint8Array.from([0,255,128]));
  const capture=createWorkspaceCapture(fs,2); await capture.start();
  await fs.write('artifact.bin',Uint8Array.from([0,1,128]));
  const final=await capture.finish();
  assert.equal(final.rows.length,1);
  assert.equal(final.rows[0].binary,true);
  assert.equal(final.rows[0].pre,null);
  assert.match(final.rows[0].preUnavailable,/binary content/);
  assert.equal(planRevert(final.rows[0],'not the binary bytes').reason,'no-preimage');
});

test('host bounded reads do not imply bounded workspace listing coverage', async () => {
  const data=new Map([['ws/p/existing.txt',new TextEncoder().encode('before')]]);
  const host={ supportsBoundedReads:true,
    async readBinary(path,{maxBytes}={}) { const bytes=data.get(path); if(!bytes) throw Object.assign(new Error('missing'),{code:'ENOENT'});
      if(maxBytes!==undefined && bytes.length>maxBytes) throw Object.assign(new Error('too large'),{code:'EFBIG'}); return bytes; },
    async stat(path) { if(data.has(path)) return {type:'file',size:data.get(path).length};
      if([...data.keys()].some(key=>key.startsWith(path+'/'))) return {type:'dir',size:0}; return null; },
    async exists(path) { return data.has(path) || [...data.keys()].some(key=>key.startsWith(path+'/')); },
    async list(prefix) { return [...data.keys()].filter(key=>!prefix || key.startsWith(prefix+'/')); },
    async write(path,bytes) { data.set(path,bytes); }, async delete(path) { data.delete(path); },
  };
  const backend=new CrateBackend(host);
  const fs=createFileops({backend,root:'ws/p'});
  const read=await fs.read('existing.txt',{maxBytes:64});
  assert.equal(new TextDecoder().decode(read.data),'before');
  let unboundedCalls=0;
  host.list=async()=>{unboundedCalls++;throw new Error('must not download full manifest');};
  const capture=createWorkspaceCapture(fs,12);
  assert.equal((await capture.start()).complete,false);
  data.set('ws/p/existing.txt',new TextEncoder().encode('after'));
  const result=await capture.finish();
  assert.equal(result.complete,false);
  assert.deepEqual(result.rows,[]);
  assert.equal(unboundedCalls,0,'capture refuses unsupported bounded listing before downloading metadata');
  assert.equal(backend.supportsConditionalWrite,undefined);
  host.supportsBoundedReads=false;
  assert.equal((await snapshotWorkspace(fs)).complete,false,'a legacy host cannot claim bounded coverage');
});

test('failed or truncated listings cannot convert unobserved files into deletable creations', async () => {
  const {fs}=fixture();
  await fs.write('existing','owner bytes');
  let calls=0;
  const flaky={...fs,list:async (...args)=>(++calls===1 ? {ok:false,code:'EIO'} : fs.list(...args))};
  const capture=createWorkspaceCapture(flaky,8);
  assert.equal((await capture.start()).complete,false);
  const result=await capture.finish();
  assert.equal(result.complete,false);
  assert.deepEqual(result.rows,[], 'a failed baseline proves no file was absent');
  const shifted=createWorkspaceCapture(fs,9,{fileLimit:1});
  await shifted.start();
  await fs.write('a-new-first','new');
  const limited=await shifted.finish();
  assert.equal(limited.complete,false);
  assert.ok(!limited.rows.some(r=>r.file==='existing' && r.deleted), 'a path crossing the cutoff is not called deleted');
  assert.ok(limited.rows.every(r=>r.captureIncomplete && !planRevert(r,'new').ok), 'partial listing rows cannot be reverted');
});

test('empty directory changes are observed, but require manual review', async () => {
  const {fs}=fixture();
  const capture=createWorkspaceCapture(fs,10); await capture.start();
  await fs.mkdir('new-empty');
  const result=await capture.finish();
  assert.equal(result.rows.length,1);
  assert.equal(result.rows[0].directory,true);
  assert.equal(result.rows[0].file,'new-empty');
  assert.equal(planRevert(result.rows[0],null).ok,false);
});

test('bounded reads, listing limits, and stopped or failed writes report accurate coverage', async () => {
  const {fs}=fixture();
  await fs.write('big', 'x'.repeat(100));
  const limited=await snapshotWorkspace(fs,{readLimit:10});
  assert.equal(limited.complete,false);
  assert.ok(limited.problems.some(x=>/big: bounded read EFBIG/.test(x)));
  const count=await snapshotWorkspace(fs,{fileLimit:0});
  assert.equal(count.complete,false);
  const capture=createWorkspaceCapture(fs,3); await capture.start();
  // A refused or stopped tool leaves the bytes unchanged.
  await capture.observe();
  const result=await capture.finish();
  assert.deepEqual(result.rows,[]);
  assert.deepEqual(result.touched,[]);
});

test('a changed readable file keeps its diff but cannot be reverted when another file exceeded the capture bound', async () => {
  const {fs}=fixture();
  await fs.write('small','before');
  await fs.write('large','x'.repeat(100));
  const capture=createWorkspaceCapture(fs,11,{readLimit:16});
  assert.equal((await capture.start()).complete,false);
  await fs.write('small','after');
  const result=await capture.finish();
  assert.equal(result.complete,false);
  const row=result.rows.find(r=>r.file==='small');
  assert.equal(row.pre,'before');
  assert.equal(row.captureIncomplete,true);
  assert.equal(planRevert(row,'after').reason,'incomplete-capture');
});

test('change rows survive JSON reload and real revert handlers refuse stale writes', async () => {
  const {fs}=fixture();
  await fs.write('delete.txt','old');
  const capture=createWorkspaceCapture(fs,4); await capture.start();
  await fs.remove('delete.txt');
  await fs.write('create.txt','new');
  const rows=JSON.parse(JSON.stringify((await capture.finish()).rows));
  const turn=turnChanges(rows,4);
  const plan=planTurnRevert(turn, {'delete.txt':undefined,'create.txt':'new'});
  assert.deepEqual(plan.restore.map(p=>p.action).sort(),['remove','write']);
  const src=await inlineModule();
  const t={id:'capture',log:rows,runSeq:4};
  const storage=memFs({'create.txt':'new'});
  // The real openTurn reader is covered by test-anvil-turn-review; this lane isolates revert.
  const opened=[];
  const ctx={fs:storage,MAX_REVIEW_BYTES,activeTask:()=>t,turnChanges,planTurnRevert,planRevert,save(){},renderAll(){},renderPreview(){},state:{},globalPreview:null,
    backend:{supportsConditionalWrite:true,supportsConditionalDelete:true},lineDiff:(a,b)=>`${a} -> ${b}`,pushSystem() {},
    openTurn(task,run){ opened.push({task,run}); }};
  ctx.atomicRevertAvailable=instantiate(extractFunction(src,'atomicRevertAvailable'),'atomicRevertAvailable',ctx);
  ctx.readRevertState=instantiate(extractFunction(src,'readRevertState'),'readRevertState',ctx);
  const revertTurn=instantiate(extractFunction(src,'revertTurn'),'revertTurn',ctx);
  await revertTurn(4);
  assert.equal(opened.length,1, 'the handler calls the run-preview reader once after reverting');
  assert.equal(opened[0].task,t, 'the same task reaches the preview reader');
  assert.equal(opened[0].run,4, 'the exact run number reaches the preview reader');
  assert.equal(storage.store['delete.txt'],'old');
  assert.equal('create.txt' in storage.store,false);
  storage.store['create.txt']='new + owner';
  const stale=planRevert(rows.find(r=>r.file==='create.txt'),storage.store['create.txt']);
  assert.equal(stale.reason,'stale');
});

test('real revert handler refuses an edit that interleaves after its read', async () => {
  const {fs}=fixture();
  await fs.write('race.txt','agent result');
  const src=await inlineModule();
  const messages=[];
  const ctx={fs,backend:{supportsConditionalWrite:true,supportsConditionalDelete:true},planRevert,activeTask:()=>({preview:null}),save(){},renderAll(){},pushSystem:x=>messages.push(x),
    readRevertState:async path=>{ const r=await fs.read(path,{encoding:'utf-8'}); await fs.write(path,'owner edit'); return r.data; }};
  ctx.atomicRevertAvailable=instantiate(extractFunction(src,'atomicRevertAvailable'),'atomicRevertAvailable',ctx);
  const revertChange=instantiate(extractFunction(src,'revertChange'),'revertChange',ctx);
  const row={k:'change',file:'race.txt',pre:'before',postHash: (await import('../sys/ai/change-preimages.mjs')).digest('agent result')};
  await revertChange(row);
  assert.equal((await fs.read('race.txt',{encoding:'utf-8'})).data,'owner edit');
  assert.ok(messages.some(x=>/Not reverted/.test(x)));
});
