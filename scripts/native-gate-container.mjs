// Owner-only Docker runtime configuration; never supplied by an agent request.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function validateRuntimeCertificate(certBytes, keyBytes, now=Date.now()) {
  const certificate=new crypto.X509Certificate(certBytes), key=crypto.createPrivateKey(keyBytes);
  const start=Date.parse(certificate.validFrom), end=Date.parse(certificate.validTo);
  if (certificate.subject !== 'CN=cdn.jsdelivr.net' || certificate.issuer !== certificate.subject
      || certificate.subjectAltName !== 'DNS:cdn.jsdelivr.net' || !certificate.verify(certificate.publicKey)
      || !certificate.checkPrivateKey(key) || !Number.isFinite(start) || !Number.isFinite(end)
      || end-start>86400000 || now<start || now>=end) throw new Error('Runtime certificate must be synthetic, matching, current, and at most one day');
  return true;
}
export async function createOwnedContainer({execute,args,name,cleanup}) {
  try {
        await execute(args,{timeout:15000,maxBuffer:65536});
        const created=JSON.parse((await execute(['inspect',name],{timeout:10000,maxBuffer:1024*1024})).stdout)[0];
        const host=created.HostConfig;
        if (host.PidMode!=='' || host.IpcMode!=='private' || host.UTSMode!=='' || host.CgroupnsMode!=='private' || host.NetworkMode!=='none') throw new Error('Container namespaces do not match the pinned private contract');
      } catch (error) {
        // Creation may commit before its CLI reports success. Reconcile our identity on every failure.
        try { await cleanup(name); } catch (cleanupError) { throw new AggregateError([error,cleanupError], 'Container creation failed and owned cleanup is unacknowledged'); }
        throw error;
      }
}
export function containerArguments({name, view, assets, seccomp, image, argv}) {
  if (!/^naklios-gate-[a-f0-9]{32}$/.test(name) || !/^sha256:[a-f0-9]{64}$/.test(image)) throw new Error('Invalid owned container or pinned image');
  if ([view, assets, seccomp].some(value => !path.isAbsolute(value) || /[,\r\n]/.test(value))) throw new Error('Invalid frozen mount path');
  return ['create','--name',name,'--pull','never','--network','none','--pid','','--ipc','private','--uts','','--cgroupns','private','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--security-opt','seccomp='+seccomp,'--user','65532:65532','--memory','3g','--memory-swap','3g','--cpus','2','--pids-limit','256','--shm-size','128m','--tmpfs','/tmp:rw,nosuid,nodev,size=512m,mode=1777','--add-host','cdn.jsdelivr.net:127.0.0.1','--mount','type=bind,src='+view+',dst=/workspace,readonly','--mount','type=bind,src='+assets+',dst=/runtime,readonly','--workdir','/workspace',image,...argv];
}
export async function containerRuntime(config){
  if(!config || !/^sha256:[a-f0-9]{64}$/.test(config.image) || !/^[a-f0-9]{64}$/.test(config.seccompSha256))throw new Error('Container runtime requires pinned image and seccomp digests');
  const assets=await fs.realpath(config.assets),seccomp=await fs.realpath(config.seccomp);
  if ([assets, seccomp].some(value => /[,\r\n]/.test(value))) throw new Error('Runtime paths cannot contain mount separators');
  if(hash(await fs.readFile(seccomp))!==config.seccompSha256)throw new Error('Container syscall policy changed');
  const manifest=JSON.parse(await fs.readFile(path.join(assets,'assets-manifest.json'),'utf8'));
  let total=0;
  for(const [name,item] of Object.entries(manifest.files||{})){
    if(!/^[A-Za-z0-9_.-]+$/.test(name) || !/^[a-f0-9]{64}$/.test(item.sha256))throw new Error('Invalid runtime asset manifest');
    const info=await fs.lstat(path.join(assets,name));
    if(!info.isFile() || info.isSymbolicLink() || info.size>64*1024*1024 || info.size!==item.bytes)throw new Error('Runtime asset exceeds bounds');
    total+=info.size;
    if(total>128*1024*1024 || hash(await fs.readFile(path.join(assets,name)))!==item.sha256)throw new Error('Runtime asset digest or total bound failed');
  }
  if(!manifest.files?.['pyodide.mjs'] || manifest.files['pyodide.mjs'].sha256!=='7f24c6655a79eacf0061d3d4e6a60dc0b1938812d15c52d7ff8b37d9e0689e51')throw new Error('Runtime entry is not pinned Pyodide');
  for (const name of ['runtime-cert.pem','runtime-key.pem']) if (!manifest.files?.[name]) throw new Error('Synthetic certificate and key must be pinned in the asset manifest');
  validateRuntimeCertificate(await fs.readFile(path.join(assets,'runtime-cert.pem')),await fs.readFile(path.join(assets,'runtime-key.pem')));
  const docker=config.docker||'/usr/local/bin/docker';
  if(!path.isAbsolute(docker))throw new Error('Use an absolute Docker executable');
  const endpoint = config.dockerHost || (await exec(docker,['context','inspect','--format','{{.Endpoints.docker.Host}}'],{timeout:10000,maxBuffer:65536})).stdout.trim();
  if (!endpoint.startsWith('unix:///') || /[\r\n]/.test(endpoint)) throw new Error('Container gate requires an owner-local Docker socket');
  const dockerExec = (args, options) => exec(docker, ['--host', endpoint, ...args], options);
  const image=JSON.parse((await dockerExec(['image','inspect',config.image],{timeout:10000,maxBuffer:1024*1024})).stdout)[0];
  if(image.Id!==config.image)throw new Error('Container image identity changed');
  const policyHash=config.seccompSha256, assetsHash=hash(Buffer.from(JSON.stringify(manifest)));
  return {
    description:'Pinned Docker runtime; no external network; read-only source and assets',
    evidence:{image:config.image,seccompSha256:policyHash,assetsManifestSha256:assetsHash},
    async prepare(){
      if(hash(await fs.readFile(seccomp))!==policyHash)throw new Error('Container syscall policy changed');
      if(hash(Buffer.from(JSON.stringify(JSON.parse(await fs.readFile(path.join(assets,'assets-manifest.json'),'utf8')))))!==assetsHash)throw new Error('Runtime manifest changed');
      for (const name of ['runtime-cert.pem','runtime-key.pem']) if(hash(await fs.readFile(path.join(assets,name)))!==manifest.files[name].sha256) throw new Error('Runtime certificate bytes changed');
      validateRuntimeCertificate(await fs.readFile(path.join(assets,'runtime-cert.pem')),await fs.readFile(path.join(assets,'runtime-key.pem')));
    },
    async command(view,argv){
      if (!path.isAbsolute(view) || /[,\r\n]/.test(view)) throw new Error('Invalid frozen mount path');
      const name='naklios-gate-'+crypto.randomBytes(16).toString('hex');
      const args=containerArguments({name,view,assets,seccomp,image:config.image,argv});
      await createOwnedContainer({execute:dockerExec,args,name,cleanup:owned=>this.cleanup(owned)});
      return {name,executable:docker,args:['--host',endpoint,'start','--attach',name]};
    },
    async stop(name){
      // The random name is ours. Never target an existing user container.
      if(!/^naklios-gate-[a-f0-9]{32}$/.test(name))throw new Error('Unknown owned container identity');
      try{await dockerExec(['stop','--timeout','1',name],{timeout:10000,maxBuffer:65536});}
      catch(error){
        // A start race may precede container creation; caller repeats after CLI close.
        if(!/No such container/i.test(error.stderr||''))throw error;
      }
      try{
        const state=JSON.parse((await dockerExec(['inspect','--format','{{json .State}}',name],{timeout:10000,maxBuffer:65536})).stdout);
        if(state.Running || state.Pid!==0)throw new Error('Container cancellation is not acknowledged');
      }catch(error){if(!/No such object|No such container/i.test(error.stderr||''))throw error;}
    },
    async cleanup(name){
      await this.stop(name);
      try{await dockerExec(['rm',name],{timeout:10000,maxBuffer:65536});}
      catch(error){if(!/No such container/i.test(error.stderr||''))throw error;}
    },
  };
}
