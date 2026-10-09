#!/usr/bin/env node
// Isolated native Chrome profile. No model, user profile, or external dependencies.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url))),token=randomUUID();
let executable;
for(const candidate of [process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean)){
  try{await access(candidate,constants.X_OK);executable=candidate;break}catch{}
}
assert.ok(executable,'Native Chrome is required; set CHROME_BIN');
const profile=await mkdtemp(path.join(tmpdir(),'naklios-range-edit-browser-'));
let browser,timer,resolveReport,rejectReport;let object=new Uint8Array();
const report=new Promise((resolve,reject)=>{resolveReport=resolve;rejectReport=reject});
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/report/'+token&&req.method==='POST'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)throw new Error('Report too large')}
      const result=JSON.parse(body);res.writeHead(200).end();resolveReport(result);return;
    }
    if(url.pathname==='/fixture'&&req.method==='POST'){
      const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>131072)throw new Error('Fixture too large');parts.push(chunk)}object=Buffer.concat(parts);res.writeHead(200).end();return;
    }
    if(req.method!=='GET'){res.writeHead(405).end();return}
    if(url.pathname.startsWith('/objects/')){res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':object.length});res.end(object);return;}
    if(url.pathname==='/test.html'){
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(`<script type="module">try{const {run}=await import('/scripts/crate-bounded-browser-cases.mjs');await fetch('/report/${token}',{method:'POST',body:JSON.stringify(await run())})}catch(e){await fetch('/report/${token}',{method:'POST',body:JSON.stringify({error:String(e.stack||e)})})}</script>`);return;
    }
    if(!url.pathname.startsWith('/vendor/crate/813d079a2db2b810d231f04146626af20e053b42/')&&url.pathname!=='/scripts/crate-bounded-browser-cases.mjs'){res.writeHead(404).end();return;}
    const target=await realpath(path.resolve(root,'.'+decodeURIComponent(url.pathname)));
    if(!target.startsWith(root+path.sep)){res.writeHead(404).end();return}
    res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end(await readFile(target));
  }catch(error){res.writeHead(500).end();rejectReport(error)}
});
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  timer=setTimeout(()=>rejectReport(new Error('Native IndexedDB check timed out')),30000);
  browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--user-data-dir='+profile,`http://127.0.0.1:${server.address().port}/test.html`],{stdio:'ignore'});
  browser.once('error',rejectReport);browser.once('exit',code=>{if(code!==null)rejectReport(new Error('Chrome exited before its receipt: '+code))});
  const result=await report;assert.equal(result.error,undefined,result.error);assert.equal(result.passed,6);assert.ok(result.rows.every(row=>row.pass===true));
  console.log(JSON.stringify({backend:'native Chrome fetch BYOB and authenticated Crate',providerCalls:0,...result}));
}finally{
  clearTimeout(timer);if(browser?.pid&&browser.exitCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill('SIGTERM');await exited}
  // Chrome helpers can briefly retain profile entries after the main process exits.
  await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
