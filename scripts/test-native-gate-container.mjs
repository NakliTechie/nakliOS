import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { containerRuntime, containerArguments, validateRuntimeCertificate, createOwnedContainer } from './native-gate-container.mjs';
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
async function fixture(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'naklios-container-config-'));
 const assets=path.join(root,'assets');await fs.mkdir(assets);
 const policy=path.join(root,'seccomp.json');await fs.writeFile(policy,'{}');
 const image='sha256:'+'a'.repeat(64),docker=path.join(root,'docker');
 // Deliberately limited fake CLI verifies orchestration; it does not prove containment.
 await fs.writeFile(docker,`#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(path.join(root,'calls.jsonl'))},JSON.stringify(a)+'\\n');if(a[0]==='image')console.log(JSON.stringify([{Id:${JSON.stringify(image)}}]));else if(a[0]==='inspect')console.log(JSON.stringify({Running:false,Pid:0}));else if(a[0]==='create')console.log('owned');\n`,{mode:0o700});
 // Use real pinned public module from the repository's existing vendored fixture if available.
 const module=Buffer.from('fixture');await fs.writeFile(path.join(assets,'pyodide.mjs'),module);
 const manifest={files:{'pyodide.mjs':{bytes:module.length,sha256:digest(module)}}};
 await fs.writeFile(path.join(assets,'assets-manifest.json'),JSON.stringify(manifest));
 return {root,assets,policy,manifest,config:{image,assets,seccomp:policy,seccompSha256:digest('{}'),docker},clean:()=>fs.rm(root,{recursive:true,force:true})};
}
test('container runtime refuses unpinned image, changed policy, forged entry, and oversized asset metadata',async()=>{
 const f=await fixture();try{
  await assert.rejects(containerRuntime({...f.config,image:'latest'}),/pinned/);
  await assert.rejects(containerRuntime({...f.config,seccompSha256:'b'.repeat(64)}),/policy changed/);
  await assert.rejects(containerRuntime(f.config),/not pinned Pyodide/);
  f.manifest.files['pyodide.mjs'].bytes=65*1024*1024;
  await fs.writeFile(path.join(f.assets,'assets-manifest.json'),JSON.stringify(f.manifest));
  await assert.rejects(containerRuntime(f.config),/bounds/);
 }finally{await f.clean();}
});
test('container runtime refuses symlink assets before guest execution',async()=>{
 const f=await fixture();try{
  await fs.unlink(path.join(f.assets,'pyodide.mjs'));await fs.symlink(f.policy,path.join(f.assets,'pyodide.mjs'));
  await assert.rejects(containerRuntime(f.config),/bounds/);
 }finally{await f.clean();}
});
test('container runtime rejects asset traversal and mount option injection',async()=>{
 const f=await fixture();try{
  f.manifest.files['../policy']={bytes:2,sha256:digest('{}')};
  await fs.writeFile(path.join(f.assets,'assets-manifest.json'),JSON.stringify(f.manifest));
  await assert.rejects(containerRuntime(f.config),/basename|manifest/);
  const bad=path.join(f.root,'assets,readonly=false');await fs.mkdir(bad);
  await assert.rejects(containerRuntime({...f.config,assets:bad}),/mount separators/);
 }finally{await f.clean();}
});

test('owned container creation fixes network, source, privileges, resource bounds and exact Node argv',()=>{
 const input={name:'naklios-gate-'+'b'.repeat(32),view:'/frozen',assets:'/assets',seccomp:'/policy',image:'sha256:'+'a'.repeat(64),argv:['--experimental-vm-modules','scripts/original.mjs','frozen-ref']};
 const args=containerArguments(input);
 assert.equal(args[0],'create');
 for(const [flag,value] of [['--network','none'],['--read-only','--cap-drop'],['--cap-drop','ALL'],['--user','65532:65532'],['--memory','3g'],['--memory-swap','3g'],['--pids-limit','256']])assert.equal(args[args.indexOf(flag)+1],value);
 assert.ok(args.includes('no-new-privileges'));
 assert.ok(args.includes('type=bind,src=/frozen,dst=/workspace,readonly'));
 assert.ok(args.includes('type=bind,src=/assets,dst=/runtime,readonly'));
 assert.deepEqual(args.slice(-4),[input.image,...input.argv]);
 assert.ok(!args.some(arg=>arg.includes('docker.sock')||arg==='--privileged'||arg==='--no-sandbox'));
 assert.throws(()=>containerArguments({...input,view:'/frozen,readonly=false'}),/mount/);
 assert.throws(()=>containerArguments({...input,name:'user-container'}),/owned/);
});

test('container create failure reconciles the owned identity even when CLI response is lost',async()=>{
 const cleaned=[];
 await assert.rejects(createOwnedContainer({name:'owned',args:['create'],execute:async()=>{throw new Error('lost response');},cleanup:async name=>cleaned.push(name)}),/lost response/);
 assert.deepEqual(cleaned,['owned']);
 await assert.rejects(createOwnedContainer({name:'owned',args:['create'],execute:async()=>{throw new Error('lost');},cleanup:async()=>{throw new Error('cleanup lost');}}),/cleanup is unacknowledged/);
});
test('container creation verifies every private namespace before start',async()=>{
 const contract={PidMode:'',IpcMode:'private',UTSMode:'',CgroupnsMode:'private',NetworkMode:'none'};
 const run=async host=>{
  const calls=[],cleaned=[];
  const execute=async args=>{calls.push(args);return {stdout:JSON.stringify([{HostConfig:host}])};};
  let error;try{await createOwnedContainer({name:'owned',args:['create'],execute,cleanup:async name=>cleaned.push(name)});}catch(e){error=e;}
  return {calls,cleaned,error};
 };
 const good=await run(contract);assert.equal(good.error,undefined);assert.deepEqual(good.cleaned,[]);
 for(const [key,value] of [['PidMode','host'],['IpcMode','host'],['UTSMode','host'],['CgroupnsMode','host'],['NetworkMode','host']]){
  const bad=await run({...contract,[key]:value});assert.match(bad.error.message,/namespaces/);assert.deepEqual(bad.cleaned,['owned']);
 }
});
test('runtime TLS accepts only a current one-day synthetic certificate with its matching key',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'naklios-synthetic-tls-'));
 try{
  const cert=path.join(root,'cert.pem'),key=path.join(root,'key.pem');
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=cdn.jsdelivr.net','-addext','subjectAltName=DNS:cdn.jsdelivr.net'],{stdio:'ignore'});
  const c=await fs.readFile(cert),k=await fs.readFile(key);
  assert.equal(validateRuntimeCertificate(c,k),true);
  const wrong=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({format:'pem',type:'pkcs8'});
  assert.throws(()=>validateRuntimeCertificate(c,wrong),/matching/);
  assert.throws(()=>validateRuntimeCertificate(c,k,Date.now()+2*86400000),/current/);
  execFileSync('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','2','-subj','/CN=cdn.jsdelivr.net','-addext','subjectAltName=DNS:cdn.jsdelivr.net'],{stdio:'ignore'});
  const longCert=await fs.readFile(cert),longKey=await fs.readFile(key);
  assert.throws(()=>validateRuntimeCertificate(longCert,longKey),/one day/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
