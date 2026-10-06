#!/usr/bin/env node
// Production Editor handlers and real IndexedDB in a disposable Chrome profile.
// No provider calls or user-profile access.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {access,mkdtemp,readFile,realpath,rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {extractFunction} from './anvil-harness.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const editor=await readFile(path.join(root,'apps/editor/index.html'),'utf8');
const handlers=['rangeSourceCurrent','persistAnvilEdit','receiveRangeEdit','renderRangeActions','discardAnvilEdit'].map(n=>extractFunction(editor,n)).join('\n');
const token=randomUUID();
let executable;
for(const candidate of [process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/google-chrome-stable','/usr/bin/chromium','/usr/bin/chromium-browser'].filter(Boolean)){
  try{await access(candidate,constants.X_OK);executable=candidate;break}catch{}
}
assert.ok(executable,'Native Chrome is required; set CHROME_BIN');
const profile=await mkdtemp(path.join(tmpdir(),'naklios-receipt-races-'));
let browser,timer,resolveReport,rejectReport;
const report=new Promise((resolve,reject)=>{resolveReport=resolve;rejectReport=reject});
const html='<script type="module">try{const {runReceiptRaces}=await import("/scripts/range-edit-receipt-race-cases.mjs");const handlers=await (await fetch("/editor-handlers")).json();const result=await runReceiptRaces(handlers);await fetch("/report/'+token+'",{method:"POST",body:JSON.stringify(result)})}catch(error){await fetch("/report/'+token+'",{method:"POST",body:JSON.stringify({error:String(error.stack||error)})})}</script>';
const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/report/'+token&&req.method==='POST'){
      let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)throw Error('Report too large')}
      const result=JSON.parse(body);res.writeHead(200).end();resolveReport(result);return;
    }
    if(req.method!=='GET'){res.writeHead(405).end();return}
    if(url.pathname==='/test.html'){res.writeHead(200,{'Content-Type':'text/html'}).end(html);return}
    if(url.pathname==='/editor-handlers'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify(handlers));return}
    if(!(url.pathname.startsWith('/sys/')&&url.pathname.endsWith('.mjs'))&&url.pathname!=='/scripts/range-edit-receipt-race-cases.mjs'){res.writeHead(404).end();return}
    const target=await realpath(path.resolve(root,'.'+decodeURIComponent(url.pathname)));
    if(!target.startsWith(root+path.sep)){res.writeHead(404).end();return}
    res.writeHead(200,{'Content-Type':'text/javascript','Cache-Control':'no-store'}).end(await readFile(target));
  }catch(error){res.writeHead(500).end();rejectReport(error)}
});
try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  timer=setTimeout(()=>rejectReport(Error('Receipt race check timed out')),30000);
  browser=spawn(executable,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--user-data-dir='+profile,'http://127.0.0.1:'+server.address().port+'/test.html'],{stdio:'ignore'});
  browser.once('error',rejectReport);browser.once('exit',code=>{if(code!==null)rejectReport(Error('Chrome exited before its receipt: '+code))});
  const result=await report;console.log(JSON.stringify(result));
  assert.equal(result.error,undefined,result.error);assert.equal(result.rows.length,7);
  assert.equal(result.passed,7,'Every receipt race and retry case must pass');
}finally{
  clearTimeout(timer);
  if(browser?.pid&&browser.exitCode===null){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill('SIGTERM');await exited}
  await new Promise(resolve=>server.close(resolve));await rm(profile,{recursive:true,force:true});
}
