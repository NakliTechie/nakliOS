// Fixed guest entry: serve only pinned public runtime bytes on guest loopback.
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const assetRoot='/runtime';
const manifest=JSON.parse(await fs.readFile(assetRoot+'/assets-manifest.json','utf8'));
for(const [name,item] of Object.entries(manifest.files)){
  if(!/^[A-Za-z0-9_.-]+$/.test(name))throw new Error('Invalid runtime basename');
  const data=await fs.readFile(path.join(assetRoot,name));
  if(data.length!==item.bytes || crypto.createHash('sha256').update(data).digest('hex')!==item.sha256)throw new Error('Runtime asset changed: '+name);
}
for(const name of ['runtime-cert.pem','runtime-key.pem']) if(!manifest.files[name]) throw new Error('Unpinned runtime certificate');
const cert=new crypto.X509Certificate(await fs.readFile(assetRoot+'/runtime-cert.pem'));
if(cert.subject!=='CN=cdn.jsdelivr.net' || cert.issuer!==cert.subject || cert.subjectAltName!=='DNS:cdn.jsdelivr.net' || !cert.verify(cert.publicKey) || !cert.checkPrivateKey(crypto.createPrivateKey(await fs.readFile(assetRoot+'/runtime-key.pem'))) || Date.parse(cert.validTo)-Date.parse(cert.validFrom)>86400000 || Date.now()<Date.parse(cert.validFrom) || Date.now()>=Date.parse(cert.validTo)) throw new Error('Invalid synthetic runtime certificate');
await fs.mkdir('/tmp/home/.pki/nssdb',{recursive:true});
execFileSync('/usr/bin/certutil',['-N','-d','sql:/tmp/home/.pki/nssdb','--empty-password']);
execFileSync('/usr/bin/certutil',['-A','-d','sql:/tmp/home/.pki/nssdb','-n','NakliOS disposable runtime','-t','C,,','-i',assetRoot+'/runtime-cert.pem']);
const server=https.createServer({key:await fs.readFile(assetRoot+'/runtime-key.pem'),cert:await fs.readFile(assetRoot+'/runtime-cert.pem')},async(req,res)=>{
  const prefix='/pyodide/v0.26.4/full/';
  if(req.headers.host!=='cdn.jsdelivr.net' || req.method!=='GET' || !req.url.startsWith(prefix))return res.writeHead(404).end();
  const name=req.url.slice(prefix.length);
  if(!Object.hasOwn(manifest.files,name))return res.writeHead(404).end();
  const item=manifest.files[name];
  const data=await fs.readFile(path.join(assetRoot,name));
  if(crypto.createHash('sha256').update(data).digest('hex')!==item.sha256)return res.writeHead(500).end();
  res.writeHead(200,{'Content-Type':name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')||name.endsWith('.mjs')?'text/javascript':'application/octet-stream','Access-Control-Allow-Origin':'*','Cross-Origin-Resource-Policy':'cross-origin','Cache-Control':'no-store'});
  res.end(data);
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(443,'127.0.0.1',resolve);});
const child=spawn('/usr/local/bin/node',process.argv.slice(2),{cwd:'/workspace',stdio:'inherit',env:{PATH:'/usr/local/bin:/usr/bin:/bin',CHROME_BIN:'/usr/bin/chromium',HOME:'/tmp/home',TMPDIR:'/tmp',LANG:'C.UTF-8'}});
child.once('error',error=>{console.error(error.message);server.close(()=>process.exit(1));});
child.once('close',(code,signal)=>server.close(()=>process.exit(signal?130:code??1)));
