#!/usr/bin/env node
// Actual whole-module Chrome integration with finite offline platform fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fixtureSDK} from './anvil-A04-browser-fixture.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),token=randomUUID();
const provider=process.env.ANVIL_A04_REAL_PROVIDER==='1';
const fixtureNames=['README.md','src/counter.js','package.json','comment-before.md','comment-instruction.txt'];
const fixtures=Object.fromEntries(await Promise.all(fixtureNames.map(async name=>[name,await readFile(path.join(root,'scripts/fixtures/anvil-A04',name),'utf8')])));
const providerReceipts=[];
if(provider){
 const frozen=JSON.parse(await readFile(process.env.ANVIL_A04_MODEL_METADATA,'utf8'));
 assert.equal(frozen.id,'space-bunny-free');assert.equal(frozen.api.url,'https://opencode.ai/zen/v1');
 for(const value of [frozen.cost.input,frozen.cost.output,frozen.cost.cache.read,frozen.cost.cache.write])assert.equal(value,0,'Only verified zero-cost routing');
 assert.ok(Date.now()-Number(process.env.ANVIL_A04_METADATA_VERIFIED_AT)<300000,'Fresh model metadata verification required');
}
let executable;
for(const candidate of [process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean)){
 try{await access(candidate,constants.X_OK);executable=candidate;break;}catch{}
}
assert.ok(executable,'Native Chrome is required; set CHROME_BIN');
const profile=await mkdtemp(path.join(tmpdir(),'naklios-A04-browser-'));
let browser,timer,resolveReport,rejectReport;
const report=new Promise((resolve,reject)=>{resolveReport=resolve;rejectReport=reject});
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/report/'+token&&req.method==='POST'){
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>8*1024*1024)throw Error('Report bound');}
   const result=JSON.parse(body);res.writeHead(200).end();resolveReport(result);return;
  }
  if(url.pathname==='/inference'&&req.method==='POST'){
   assert.ok(provider,'Provider route is opt-in');assert.ok(providerReceipts.length<80,'Provider call bound');
   let body='';for await(const chunk of req){body+=chunk;assert.ok(Buffer.byteLength(body)<=2*1024*1024,'Request bound');}
   const request=JSON.parse(body);assert.equal(request.model,'space-bunny-free');request.stream=false;request.max_tokens=Math.min(request.max_tokens||8192,8192);
   const controller=new AbortController(),deadline=setTimeout(()=>controller.abort(),180000);
   res.once('close',()=>{if(!res.writableEnded)controller.abort()});
   const receipt={requestedModel:request.model,requestSha256:createHash('sha256').update(JSON.stringify(request)).digest('hex')};providerReceipts.push(receipt);
   try{
    const answer=await fetch('https://opencode.ai/zen/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer public'},body:JSON.stringify(request),signal:controller.signal});
    receipt.status=answer.status;let text='';const reader=answer.body.getReader();
    while(true){const part=await reader.read();if(part.done)break;text+=Buffer.from(part.value).toString('utf8');if(Buffer.byteLength(text)>2*1024*1024){await reader.cancel();throw Error('Response bound')}}
    if(answer.ok){const result=JSON.parse(text);receipt.reportedModel=result.model;receipt.usage=result.usage;}
    res.writeHead(answer.status,{'Content-Type':'application/json'}).end(text);
   }finally{clearTimeout(deadline)}return;
  }
  if(url.pathname==='/fixtures'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(fixtures));return;}
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  if(url.pathname==='/test.html'){
   res.writeHead(200,{'Content-Type':'text/html'}).end(`<script type="module">try{const {runA04Cases}=await import('/scripts/anvil-A04-browser-cases.mjs');await fetch('/report/${token}',{method:'POST',body:JSON.stringify(await runA04Cases())})}catch(error){await fetch('/report/${token}',{method:'POST',body:JSON.stringify({error:String(error.stack||error)})})}</script>`);return;
  }
  if(url.pathname==='/sdk/naklios.js'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(fixtureSDK({provider}));return;}
  const allowed=url.pathname==='/apps/anvil/index.html'||url.pathname==='/scripts/anvil-A04-browser-cases.mjs'||((url.pathname.startsWith('/sys/')||url.pathname.startsWith('/vendor/'))&&url.pathname.endsWith('.mjs'));
  if(!allowed){res.writeHead(404).end();return;}
  const target=await realpath(path.resolve(root,'.'+decodeURIComponent(url.pathname)));if(!target.startsWith(root+path.sep)){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':target.endsWith('.html')?'text/html':'text/javascript'}).end(await readFile(target));
 }catch(error){if(!res.headersSent)res.writeHead(500);res.end();rejectReport(error);}
});
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 timer=setTimeout(()=>rejectReport(Error('A04 browser boundary exceeded 960 seconds')),960000);
 browser=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-dev-shm-usage','--user-data-dir='+profile,`http://127.0.0.1:${server.address().port}/test.html`],{stdio:'ignore'});
 browser.once('error',rejectReport);browser.once('exit',code=>{if(code!==null)rejectReport(Error('Chrome exited before its receipt: '+code))});
 const result=await report;if(result.error)console.error(JSON.stringify({error:result.error,providerReceipts}));assert.equal(result.error,undefined,result.error);assert.equal(result.survey.chainVerified,true);assert.equal(result.comments.adjacencyPass,true);assert.equal(result.delayedStop.lateFactWrites,0);
 console.log(JSON.stringify({source:'unchanged full Anvil inline module; native Chrome; finite offline host fixtures',providerCalls:providerReceipts.length,providerReceipts,...result},null,2));
}finally{
 clearTimeout(timer);
 if(browser?.pid&&browser.exitCode===null){
  const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill('SIGTERM');let ack=await Promise.race([exited.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2000))]);
  if(!ack){browser.kill('SIGKILL');ack=await Promise.race([exited.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2000))]);}assert.ok(ack,'Owned browser termination acknowledged');
 }
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
