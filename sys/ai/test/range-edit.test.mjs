import assert from 'node:assert/strict';
import { createRangeEditBackend, rangeEditRequest, rangeEditProposal, rangeEditPrompt, RANGE_EDIT_LIMITS } from '../range-edit.mjs';
import { createFileops } from '../../rig/fileops/index.mjs';
import { createGrant, createAgentFace, createOpLog } from '../../rig/agent/index.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { MemoryBackend } from '../../rig/fileops/memory-backend.mjs';
import { createShell } from '../../rig/cli/shell.mjs';

const before='const answer = 1;\nconsole.log(answer);\n';
const input={path:'src/main.js',project:'editor:browser',backend:'browser',before,
  selection:{start:1,end:1},instruction:'Change answer from 1 to 2.'};
const request=rangeEditRequest(input);
assert.equal(request.context,before);
assert.match(rangeEditPrompt(request),/source remains unchanged/);
assert.equal(rangeEditRequest({...input,selection:{start:4,end:4}}).selection.start,4,'deleted EOF anchor survives');
for(const selection of [{start:0,end:1},{start:2,end:1},{start:1,end:99},{start:1.5,end:2}])
  assert.throws(()=>rangeEditRequest({...input,selection}),/selection anchors/);
for(const path of ['../secret.js','src/../main.js','/src/main.js','src\\main.js','.git/config','.anvil/gate/criterion.mjs','src/%2e%2e/private'])
  assert.throws(()=>rangeEditRequest({...input,path}),/canonical source-file path/);
assert.throws(()=>rangeEditRequest({...input,version:'wrong'}),e=>e.code==='ESTALE');
assert.throws(()=>rangeEditRequest({...input,before:'\0'}),/bounded text/);
assert.throws(()=>rangeEditRequest({...input,before:'\ud800'}),/invalid Unicode/);
assert.throws(()=>rangeEditRequest({...input,instruction:'é'.repeat(3000)}),/bounded text/);
assert.throws(()=>rangeEditRequest({...input,before:'a'.repeat(RANGE_EDIT_LIMITS.bytes+1)}),/bounded text/);
assert.throws(()=>rangeEditRequest({...input,before:'a'.repeat(16001)}),/context exceeds/);
assert.throws(()=>rangeEditProposal(request,'x'.repeat(RANGE_EDIT_LIMITS.bytes+1)),/bounded text/);

const bomRequest=rangeEditRequest({...input,before:'\ufeff'+before});
const bomSession=createRangeEditBackend(bomRequest);
assert.equal(new TextDecoder('utf-8',{ignoreBOM:true}).decode(await bomSession.backend.readBinary(input.path)),'\ufeff'+before);
assert.equal(bomSession.proposal().before,'\ufeff'+before);
assert.equal(bomSession.proposal().after,'\ufeff'+before);
bomSession.revoke();

let alive=true;
const session=createRangeEditBackend(request,{valid:()=>alive});
const fs=createFileops({backend:session.backend});
const read=await fs.read(request.path,{encoding:'utf-8',maxBytes:256*1024});
assert.equal(read.data,before);
assert.deepEqual((await fs.list('',{recursive:true})).entries.filter(e=>e.type==='file').map(e=>e.path),['src/main.js']);
const after=before.replace('= 1','= 2');
assert.equal((await fs.write(request.path,after)).ok,true);
assert.equal(session.proposal().after,after);
assert.equal(session.proposal().before,before,'source baseline remains immutable');
for(const path of ['src/sibling.js','src/main.js/descendant','src','.anvil/memory/a.md']){
  await assert.rejects(()=>session.backend.write(path,new TextEncoder().encode('escape')),e=>e.code==='EACCES');
}
await assert.rejects(()=>session.backend.delete(request.path),e=>e.code==='EACCES');
await assert.rejects(()=>session.backend.mkdir('other'),e=>e.code==='EACCES');
await assert.rejects(()=>session.backend.write(request.path,Uint8Array.of(0)),/bounded text/);
await assert.rejects(()=>session.backend.write(request.path,Uint8Array.of(255)),/encoded data/);
await assert.rejects(()=>session.backend.write(request.path,new Uint8Array(RANGE_EDIT_LIMITS.bytes+1)),e=>e.code==='EFBIG');
await assert.rejects(()=>session.backend.conditionalWrite(request.path,new TextEncoder().encode(before),
  {expectedData:new TextEncoder().encode(before)}),e=>e.code==='ESTALE');
assert.equal(session.proposal().after,after);

// Actual Rig tools and shell share the restricted snapshot backend.
const registry=buildRigRegistry({fs});
const grant=createGrant({prefixes:[request.path],scopes:['fs:read','fs:write']});
const face=createAgentFace({registry,grant,opLog:createOpLog({fs:createFileops({backend:new MemoryBackend()})}),actor:'agent'});
const shell=createShell({registry,face});
await shell.feed('printf escape > src/sibling.js');
assert.notEqual(shell.lastCode,0,'shell redirect cannot create a sibling');
await shell.feed("sed -i 's/answer/result/g' src/main.js");
assert.equal(shell.lastCode,0,'a governed shell edit reaches the granted file');
assert.match(session.proposal().after,/const result = 2/);
assert.equal((await fs.read('src/sibling.js')).ok,false);

alive=false;
await assert.rejects(()=>session.backend.readBinary(request.path),e=>e.code==='ESTALE');
assert.throws(()=>session.proposal(),e=>e.code==='ESTALE');
const revoked=createRangeEditBackend(request);revoked.revoke();
await assert.rejects(()=>revoked.backend.write(request.path,new TextEncoder().encode(after)),e=>e.code==='ESTALE');
console.log('range-edit: bounded requests, exact-file Rig/shell, stale writes, and session revocation pass');
