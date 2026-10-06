// SPDX-License-Identifier: MIT
// Vendor one immutable, clean authoritative Crate revision. No floating refs.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

const args=process.argv.slice(2);
assert.equal(args.length,4,'Usage: node scripts/vendor-crate.mjs --source-path PATH --commit FULL_SHA');
assert.equal(args[0],'--source-path');assert.equal(args[2],'--commit');
const source=path.resolve(args[1]),commit=args[3];assert.match(commit,/^[a-f0-9]{40}$/);
const git=(...argv)=>execFileSync('git',argv,{cwd:source,maxBuffer:4*1024*1024});
assert.equal(git('rev-parse','HEAD').toString().trim(),commit,'Source HEAD must match immutable pin');
assert.equal(git('status','--porcelain').toString().trim(),'','Commit upstream changes before vendoring');
assert.match(git('remote','get-url','origin').toString().trim(),/github\.com[/:]NakliTechie\/crate(?:\.git)?$/i);
const pending=['crate.js','credsfile.js','bucket.js','sync-client.js'],files=new Map();
while(pending.length){
  const name=pending.pop();if(files.has(name))continue;
  assert.ok(!path.isAbsolute(name)&&!name.startsWith('../')&&!name.includes('\\'),'Module must stay inside upstream lib');
  const bytes=git('show',`${commit}:lib/${name}`);assert.ok(bytes.length<=1024*1024);
  const text=bytes.toString('utf8');assert.match(text.slice(0,200),/SPDX-License-Identifier: AGPL-3\.0-or-later/);
  files.set(name,bytes);
  for(const match of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["'](\.[^"']+)["']/g))
    pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(name),match[1])));
}
const target=path.resolve('vendor/crate',commit);
let exists=false;try{await access(target);exists=true}catch(e){if(e.code!=='ENOENT')throw e}
assert.equal(exists,false,'An immutable vendor directory must never be overwritten');
await mkdir(target,{recursive:true});
const hashes={};for(const [name,bytes] of files){await mkdir(path.dirname(path.join(target,name)),{recursive:true});await writeFile(path.join(target,name),bytes);hashes[name]=createHash('sha256').update(bytes).digest('hex')}
const license=git('show',`${commit}:LICENSE`);assert.match(license.toString(),/AFFERO GENERAL PUBLIC LICENSE/);await writeFile(path.join(target,'LICENSE'),license);
hashes.LICENSE=createHash('sha256').update(license).digest('hex');
const manifest={repository:'https://github.com/NakliTechie/crate',commit,files:hashes,license:'AGPL-3.0-or-later',method:'Exact git blobs and transitive relative ESM imports from authoritative source',remotePublication:'Must be verified before delivery'};
await writeFile(path.join(target,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
await writeFile(path.join(target,'README.md'),`# Immutable Crate headless SDK\n\nSource: NakliTechie/crate at ${commit}.\n\nThe source manifest pins every transitive module and the upstream license.\nThe host imports one immutable revision. Historical vendors remain available.\nBounded reads refuse unsupported compressed objects or non-BYOB transports.\nThis SDK does not advertise atomic expected-content mutations.\nRemote publication requires separate verification before delivery.\n`);
console.log(JSON.stringify({target,commit,modules:files.size,bytes:[...files.values()].reduce((n,b)=>n+b.length,0)}));
