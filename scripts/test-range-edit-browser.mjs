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
let browser,timer,resolveReport,rejectReport;
const report=new Promise((resolve,reject)=>{resolveReport=resolve;rejectReport=reject});
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/report/'+token&&req.method==='POST'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)throw new Error('Report too large')}
      const result=JSON.parse(body);res.writeHead(200).end();resolveReport(result);return;
    }
    if(req.method!=='GET'){res.writeHead(405).end();return}
    if(url.pathname==='/test.html'){
      res.writeHead(200,{'Content-Type':'text/html'}).end(`<script type="module">try{const {runNativeRangeEditCases}=await import('/scripts/range-edit-browser-cases.mjs');const {runRangeEditLifecycleCases}=await import('/scripts/range-edit-lifecycle-browser-cases.mjs');const {runRangeEditReceiptCases,runStaleAppliedRangeEditCases,runMissingSourceRangeEditCases,runCancelledReloadRangeEditCases}=await import('/scripts/range-edit-receipt-browser-cases.mjs');const result=await runNativeRangeEditCases();result.lifecycle=await runRangeEditLifecycleCases();result.receipt=await runRangeEditReceiptCases();result.staleApplied=await runStaleAppliedRangeEditCases();result.missingSource=await runMissingSourceRangeEditCases();result.cancelledReload=await runCancelledReloadRangeEditCases();await fetch('/report/${token}',{method:'POST',body:JSON.stringify(result)})}catch(e){await fetch('/report/${token}',{method:'POST',body:JSON.stringify({error:String(e.stack||e)})})}</script>`);return;
    }
    if(!(url.pathname.startsWith('/sys/')&&url.pathname.endsWith('.mjs'))&&!['/scripts/range-edit-browser-cases.mjs','/scripts/range-edit-lifecycle-browser-cases.mjs','/scripts/range-edit-receipt-browser-cases.mjs'].includes(url.pathname)){
      res.writeHead(404).end();return;
    }
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
  const result=await report;assert.equal(result.error,undefined,result.error);assert.equal(result.passed,12);
  assert.ok(result.rows.every(row=>row.pass===true));
  assert.equal(result.lifecycle.passed,11);assert.ok(result.lifecycle.rows.every(row=>row.pass===true));
  assert.equal(result.receipt.passed,7);assert.ok(result.receipt.rows.every(row=>row.pass===true));
  assert.equal(result.staleApplied.passed,3);assert.ok(result.staleApplied.rows.every(row=>row.pass===true));
  assert.equal(result.missingSource.passed,1);assert.ok(result.missingSource.rows.every(row=>row.pass===true));
  assert.equal(result.cancelledReload.passed,5);assert.ok(result.cancelledReload.rows.every(row=>row.pass===true));
  console.log(JSON.stringify({backend:'native Chrome IndexedDB',providerCalls:0,...result}));
}finally{
  clearTimeout(timer);if(browser?.pid&&browser.exitCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill('SIGTERM');await exited}
  await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
}
