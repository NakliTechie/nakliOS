import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=await mkdtemp(path.join(tmpdir(),'naklios-serve-books-'));
const site=path.join(root,'naklios'), books=path.join(root,'Books');
const script=fileURLToPath(new URL('./serve-coi.mjs',import.meta.url));
const children=[];
async function startServer(siteRoot){
  const child=spawn(process.execPath,[script,'--port','0','--root',siteRoot],{stdio:['ignore','pipe','pipe']});
  children.push(child);
  const origin=await new Promise((resolve,reject)=>{
    let output=''; const timeout=setTimeout(()=>reject(new Error('serve-coi did not start')),5000);
    child.stdout.on('data',chunk=>{output+=chunk.toString();const match=/serve-coi: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if(match){clearTimeout(timeout);resolve(match[1]);}});
    child.once('error',e=>{clearTimeout(timeout);reject(e);});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('serve-coi exited '+code));});
  });
  return {child,origin};
}
async function stopServer(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.kill();
  await new Promise(resolve=>child.once('exit',resolve));
}
try{
  await mkdir(site); await mkdir(books);
  await writeFile(path.join(site,'index.html'),'host marker');
  await writeFile(path.join(books,'index.html'),'books marker');
  await writeFile(path.join(books,'asset.txt'),'asset marker');
  await writeFile(path.join(books,'.env'),'private marker');
  await mkdir(path.join(books,'.git'));
  await writeFile(path.join(books,'.git','config'),'git marker');
  const first=await startServer(site), origin=first.origin;
  const host=await fetch(origin+'/');
  assert.equal(host.status,200); assert.equal(await host.text(),'host marker');
  const library=await fetch(origin+'/Books/');
  assert.equal(library.status,200); assert.equal(await library.text(),'books marker');
  const asset=await fetch(origin+'/Books/asset.txt');
  assert.equal(asset.status,200); assert.equal(await asset.text(),'asset marker');
  const missing=await fetch(origin+'/Books/missing.txt');
  assert.equal(missing.status,404);
  assert.equal((await fetch(origin+'/Books/.env')).status,403);
  assert.equal((await fetch(origin+'/Books/.git/config')).status,403);
  await stopServer(first.child);

  const worktree=path.join(site,'.worktrees','check');
  await mkdir(worktree,{recursive:true});
  await writeFile(path.join(worktree,'index.html'),'worktree marker');
  const second=await startServer(worktree);
  assert.equal(await (await fetch(second.origin+'/Books/')).text(),'books marker','managed-worktree discovery finds the parent Books checkout');
  await stopServer(second.child);

  const localBooks=path.join(site,'Books');
  await mkdir(localBooks);
  await writeFile(path.join(localBooks,'index.html'),'local marker');
  const third=await startServer(site);
  assert.equal(await (await fetch(third.origin+'/Books/')).text(),'local marker','a local Books route wins over sibling discovery');
  await stopServer(third.child);

  const invalid=spawnSync(process.execPath,[script,'--port','0','--root',site,'--books-root',path.join(root,'missing')],{encoding:'utf8'});
  assert.notEqual(invalid.status,0,'invalid explicit Books root must fail at startup');
  console.log('serve-coi: local Books source maps under /Books/');
}finally{
  for(const child of children) await stopServer(child);
  await rm(root,{recursive:true,force:true});
}
