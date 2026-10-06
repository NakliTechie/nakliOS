#!/usr/bin/env node
// Actual whole-module Chrome integration with finite offline platform fixtures.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fixtureSDK} from './anvil-A07-browser-fixture.mjs';
const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),token=randomUUID();
let executable;
for(const candidate of [process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean)){
 try{await access(candidate,constants.X_OK);executable=candidate;break;}catch{}
}
assert.ok(executable,'Native Chrome is required; set CHROME_BIN');
const profile=await mkdtemp(path.join(tmpdir(),'naklios-A07-browser-'));
let browser,timer,resolveReport,rejectReport;
const report=new Promise((resolve,reject)=>{resolveReport=resolve;rejectReport=reject});
const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/report/'+token&&req.method==='POST'){
   let body='';for await(const chunk of req){body+=chunk;if(body.length>1024*1024)throw Error('Report bound');}
   const result=JSON.parse(body);res.writeHead(200).end();resolveReport(result);return;
  }
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  if(url.pathname==='/test.html'){
   res.writeHead(200,{'Content-Type':'text/html'}).end(`<script type="module">try{const {runA07Cases}=await import('/scripts/anvil-A07-browser-cases.mjs');await fetch('/report/${token}',{method:'POST',body:JSON.stringify(await runA07Cases())})}catch(error){await fetch('/report/${token}',{method:'POST',body:JSON.stringify({error:String(error.stack||error)})})}</script>`);return;
  }
  if(url.pathname==='/sdk/naklios.js'){res.writeHead(200,{'Content-Type':'text/javascript'}).end(fixtureSDK());return;}
  const allowed=url.pathname==='/apps/anvil/index.html'||url.pathname==='/scripts/anvil-A07-browser-cases.mjs'||url.pathname==='/scripts/anvil-A07-trap-fixture.mjs'||((url.pathname.startsWith('/sys/')||url.pathname.startsWith('/vendor/'))&&(/\.(mjs|js|wasm)$/.test(url.pathname)));
  if(!allowed){res.writeHead(404).end();return;}
  const target=await realpath(path.resolve(root,'.'+decodeURIComponent(url.pathname)));if(!target.startsWith(root+path.sep)){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':target.endsWith('.html')?'text/html':target.endsWith('.wasm')?'application/wasm':'text/javascript'}).end(await readFile(target));
 }catch(error){if(!res.headersSent)res.writeHead(500);res.end();rejectReport(error);}
});
try{
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 timer=setTimeout(()=>rejectReport(Error('A07 browser boundary exceeded 180 seconds')),180000);
 browser=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-dev-shm-usage','--user-data-dir='+profile,`http://127.0.0.1:${server.address().port}/test.html`],{stdio:'ignore'});
 browser.once('error',rejectReport);browser.once('exit',code=>{if(code!==null)rejectReport(Error('Chrome exited before its receipt: '+code))});
 const result=await report;assert.equal(result.error,undefined,result.error);assert.ok(result.cases.length>=13);assert.ok(result.cases.every(row=>row.ok));
 console.log(JSON.stringify({source:'unchanged full Anvil inline module; native Chrome; finite offline host fixtures',providerCalls:0,...result},null,2));
}finally{
 clearTimeout(timer);
 if(browser?.pid&&browser.exitCode===null){
  const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill('SIGTERM');let ack=await Promise.race([exited.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2000))]);
  if(!ack){browser.kill('SIGKILL');ack=await Promise.race([exited.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),2000))]);}assert.ok(ack,'Owned browser termination acknowledged');
 }
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
