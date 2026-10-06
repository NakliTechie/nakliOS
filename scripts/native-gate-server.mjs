#!/usr/bin/env node
// Owner-launched macOS bridge. It has no general shell, upload, commit, push,
// environment, or filesystem API. Candidate execution uses private copies.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { containerRuntime } from './native-gate-container.mjs';
import { load as loadYaml, JSON_SCHEMA } from '../vendor/js-yaml/js-yaml.mjs';

const exec = promisify(execFile);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const portable = value => typeof value === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)
  && value.split('/').every(part => part !== '.' && part !== '..');
const BINDING = '.anvil/gate/native-binding.json';
const MUTABLE_LIMIT = 1024 * 1024;
const EXECUTION_TIME_MS = 10 * 60 * 1000;
const COMMAND_TIME_MS = 120000;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const COMMAND_METADATA_LIMIT = 64 * 1024;

export function workflowCommands(text) {
  // Parse actual steps; caption text and action inputs cannot become commands.
  let workflow;
  try{workflow=loadYaml(String(text),{schema:JSON_SCHEMA});}
  catch(_){throw new Error('Unsupported native workflow structure');}
  const object=value=>value && typeof value==='object' && !Array.isArray(value);
  const fields=(value,allowed)=>{
    if(!object(value) || Object.keys(value).some(key=>!allowed.includes(key))) throw new Error('Unsupported native workflow execution control');
  };
  fields(workflow,['name','on','permissions','jobs']);
  if(!object(workflow.jobs) || !Object.keys(workflow.jobs).length || Object.keys(workflow.jobs).length>20) throw new Error('Expected bounded native workflow jobs');
  const runs=[];
  for(const job of Object.values(workflow.jobs)){
    fields(job,['name','runs-on','timeout-minutes','steps']);
    if(job['runs-on']!==undefined && job['runs-on']!=='ubuntu-latest') throw new Error('Unsupported native workflow runner');
    if(!Array.isArray(job.steps) || !job.steps.length || job.steps.length>600) throw new Error('Expected bounded native workflow steps');
    for(const step of job.steps){
      if(step?.run!==undefined){
        fields(step,['name','run']);
        if(typeof step.run!=='string' || /[\r\n]/.test(step.run)) throw new Error('Unsupported native workflow run scalar');
        runs.push(step.run.trim());
      }else{
        fields(step,['name','uses','with']);
        if(step.uses==='actions/checkout@v5'){
          if(step.with!==undefined){fields(step.with,['fetch-depth']);if(step.with['fetch-depth']!==0) throw new Error('Native workflow requires complete frozen history');}
        }else if(step.uses==='actions/setup-node@v4'){
          fields(step.with,['node-version']);
          if(String(step.with['node-version'])!=='24') throw new Error('Native workflow requires the pinned Node 24 runtime');
        }else throw new Error('Unsupported native workflow action');
      }
    }
  }
  if (!runs.length || runs.length > 500) throw new Error('Expected a bounded native workflow');
  if(runs.reduce((bytes,command)=>bytes+Buffer.byteLength(command),0)>COMMAND_METADATA_LIMIT) throw new Error('Workflow command metadata exceeds its byte bound');
  return runs.map(command => {
    // Exact argv, no shell interpretation. Reject unsupported workflow syntax
    // instead of quietly omitting it or executing a caller-provided string.
    const argv = command.split(/\s+/);
    if (argv[0] !== 'node' || argv.length < 2 || argv.some(arg => !/^[A-Za-z0-9_.\/-]+$/.test(arg))
        || argv.slice(1).some(arg => arg.split('/').includes('..') || arg.startsWith('/'))) {
      throw new Error('Workflow contains a command outside the fixed Node gate contract');
    }
    const options = argv.slice(1).filter(arg => arg.startsWith('-'));
    if (options.some(arg => !['--test', '--experimental-vm-modules'].includes(arg))) throw new Error('Unsupported native gate option');
    return { command, argv: argv.slice(1) };
  });
}

async function boundedFile(root, name, limit = 64 * 1024 * 1024) {
  // No user request supplies name. The owner freezes these paths at launch.
  const candidate = path.join(root, name), actual = await fs.realpath(candidate);
  if (!actual.startsWith(root + path.sep)) throw new Error('Gate source escapes its checkout');
  const handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error('Gate source is not a bounded regular file');
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const got = await handle.read(bytes, at, bytes.length - at, at);
      if (!got.bytesRead) throw new Error('Gate source changed during read');
      at += got.bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Gate source changed during read');
    return bytes;
  } finally { await handle.close(); }
}

async function pairingDirectory(root){
  let directory=root;
  for(const part of ['.anvil','gate']){
    directory=path.join(directory,part);
    try{await fs.mkdir(directory,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
    const info=await fs.lstat(directory);
    if(!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory)!==directory) throw new Error('Pairing directory must remain inside the checkout without symlinks');
  }
  return directory;
}

export function sandboxProfile({ view, nodePath, runtimeBin }) {
  const q = JSON.stringify;
  const reads = ['/System', '/usr', '/bin', '/sbin', '/Library/Frameworks', '/Library/Fonts',
    '/Applications/Google Chrome.app', '/Applications/Xcode.app',
    '/Library/Developer/CommandLineTools', path.dirname(nodePath), view,
    ...(runtimeBin ? [runtimeBin] : [])];
  return `(version 1)\n(deny default)\n` +
    `(allow process*)\n(allow sysctl-read)\n(allow file-read-metadata)\n` +
    `(allow file-read* ${reads.map(item => `(subpath ${q(item)})`).join(' ')}\n` +
    ` (literal "/") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom")\n` +
    ` (literal "/private/etc/hosts") (literal "/private/etc/localtime"))\n` +
    // Source is immutable throughout execution, not merely hash-checked later.
    `(allow file-write* (subpath ${q(path.join(view,'.tmp'))}) (literal "/dev/null"))\n` +
    `(deny file-write* (subpath ${q(path.join(view, '.git'))}))\n` +
    `(allow network-inbound (local ip "localhost:*"))\n` +
    `(allow network-outbound (remote ip "localhost:*"))\n` +
    `(allow mach-lookup (global-name "com.apple.system.logger")\n` +
    ` (global-name "com.apple.FontObjectsServer") (global-name "com.apple.windowserver.active"))\n` +
    `(allow ipc-posix-shm* (ipc-posix-name-prefix "com.google.Chrome"))\n` +
    `(allow signal (target same-sandbox))\n`;
}

export async function createNativeGateServer({ checkout, mutable, criterion, origin,
  port = 0, runtimeParent = os.tmpdir(), ttlMs = 60 * 60 * 1000, container = null } = {}) {
  if (process.platform !== 'darwin') throw new Error('This bridge requires the verified macOS execution adapter');
  if(process.versions.node.split('.')[0]!=='24') throw new Error('Native gate requires the workflow Node 24 runtime');
  if (!portable(mutable) || !portable(criterion) || mutable === criterion || mutable === '.github/workflows/test.yml'
      || /(^|\/)(?:test|scripts|\.git|\.anvil)(?:\/|$)/.test(mutable)) throw new Error('Select a production file and a separate frozen criterion');
  const allowedOrigin = new URL(origin);
  if (allowedOrigin.origin !== origin || allowedOrigin.username || allowedOrigin.password
      || !['http:', 'https:'].includes(allowedOrigin.protocol)) throw new Error('Supply one exact browser origin');
  if (!Number.isInteger(port) || port < 0 || port > 65535 || ttlMs < 1000 || ttlMs > 60 * 60 * 1000) throw new Error('Invalid bridge bounds');
  const guest = container ? await containerRuntime(container) : null;
  if (!guest) await fs.access('/usr/bin/sandbox-exec', constants.X_OK);
  const source = await fs.realpath(checkout);
  const runtime = await fs.mkdtemp(path.join(await fs.realpath(runtimeParent), 'naklios-native-gate-'));
  let binding, bindingOwned=false, server;
  try {
  await fs.chmod(runtime, 0o700);
  const template = path.join(runtime, 'template');
  const nodePath = await fs.realpath(process.execPath);
  // Resolve the installed Git runtime before sandboxing. The system launcher
  // otherwise tries to read host license preferences unrelated to the checkout.
  const gitPath=await fs.realpath((await exec('/usr/bin/xcrun',['--find','git'])).stdout.trim());
  if(!gitPath.startsWith('/Applications/Xcode.app/Contents/Developer/usr/bin/') && !gitPath.startsWith('/Library/Developer/CommandLineTools/usr/bin/')) throw new Error('Native Git must use an installed system developer runtime');
  // Pin Python from the owner's launch environment independently of Git.
  // Xcode's Git directory also contains an older Python SQLite runtime.
  let pythonPath;
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    try {
      const candidate = path.resolve(directory, 'python3');
      await fs.access(candidate, constants.X_OK);
      pythonPath = await fs.realpath(candidate); break;
    } catch (error) { if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  if (!pythonPath || !['/Library/Frameworks/', '/usr/', '/Applications/Xcode.app/',
    '/Library/Developer/CommandLineTools/'].some(prefix => pythonPath.startsWith(prefix))) {
    throw new Error('Native Python must use an installed runtime within the sandbox read roots');
  }
  const runtimeBin = path.join(runtime, 'bin');
  await fs.mkdir(runtimeBin, { mode: 0o700 });
  for (const [name, target] of Object.entries({ node: nodePath, git: gitPath, python3: pythonPath })) {
    await fs.symlink(target, path.join(runtimeBin, name));
  }
  const gitResult = await exec('/usr/bin/git', ['-C', source, 'ls-files', '-z'], { maxBuffer: 16 * 1024 * 1024 });
  const tracked = gitResult.stdout.split('\0').filter(Boolean);
  const untrackedResult = await exec('/usr/bin/git', ['-C', source, 'ls-files', '--others', '--exclude-standard', '-z'], { maxBuffer: 16 * 1024 * 1024 });
  const names = [...new Set([...tracked, ...untrackedResult.stdout.split('\0').filter(Boolean), criterion])];
  if (!tracked.includes(mutable) || names.length > 20000) throw new Error('Mutable file must exist in the tracked disposable checkout');
  // Clone Git history without alternates or hard links. Native historical
  // assertions keep their immutable objects without host repository access.
  await exec('/usr/bin/git', ['clone', '--no-hardlinks', '--no-checkout', source, template], { maxBuffer: 1024 * 1024 });
  const expected = new Map(); let total = 0;
  for (const name of names) {
    if (name.startsWith('.git/')) throw new Error('Git administrative paths are not source');
    const bytes = await boundedFile(source, name);
    total += bytes.length;
    if (total > 512 * 1024 * 1024) throw new Error('Checkout exceeds the frozen source byte bound');
    await fs.mkdir(path.dirname(path.join(template, name)), { recursive: true });
    await fs.writeFile(path.join(template, name), bytes);
    expected.set(name, digest(bytes));
  }
  const commands = workflowCommands(await fs.readFile(path.join(template, '.github/workflows/test.yml'), 'utf8'));
  const token = crypto.randomBytes(32).toString('base64url');
  binding = JSON.stringify({ version: 1, session: crypto.randomBytes(24).toString('base64url'),
    workflowSha256: expected.get('.github/workflows/test.yml'), mutable, criterion });
  await pairingDirectory(source);
  await fs.writeFile(path.join(source, BINDING), binding, { flag: 'wx', mode: 0o600 });
  bindingOwned=true;
  const expiresAt = Date.now() + ttlMs;
  const jobs = new Map(); let active = null, shuttingDown = false;
  async function sourceValid(candidateHash) {
    for (const [name, hash] of expected) {
      const actual = digest(await boundedFile(source, name, name === mutable ? MUTABLE_LIMIT : undefined));
      if (actual !== (name === mutable && candidateHash ? candidateHash : hash) && name !== mutable) throw new Error('Frozen source changed: ' + name);
      if (name === mutable && candidateHash && actual !== candidateHash) throw new Error('Candidate changed during native execution');
    }
    if (String(await boundedFile(source, BINDING, 1024)) !== binding) throw new Error('Workspace pairing changed');
  }
  function publicJob(job, receipt=false) {
    const terminal=receipt || job.receiptReady || job.persistenceFailed;
    return { id: job.id, state: terminal ? job.state : 'running', code: terminal ? job.code : null, output: terminal ? job.output : '',
      completedCommands: job.results.length, totalCommands: job.commands.length,
      candidateSha256: job.candidateSha256, receipt: receipt || job.receiptReady ? job.id + '/receipt.json' : null };
  }
  function kill(job, signal) {
    if (!job.child?.pid) return;
    try { process.kill(-job.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async function saveReceipt(job) {
    const receipt = { ...publicJob(job,true), commands: job.results, sourceFiles: Object.fromEntries(expected),
      candidateSha256: job.candidateSha256, mutable, criterion, commandsUnchanged: true,
      execution: guest ? guest.description : 'macOS sandbox-exec; private copy; no checkout writeback',
      ...(guest ? { containerRuntime: guest.evidence } : {}),
      runtimes: { node: nodePath, git: gitPath, python3: pythonPath },
      limits: { commandMs: COMMAND_TIME_MS, executionMs: EXECUTION_TIME_MS, outputBytes: OUTPUT_LIMIT },
      ioLimit: 'Frozen source reads and captured output have byte bounds. Git history cloning and private copying have no explicit byte cap. Setup and receipt I/O have no hard wall deadline. Cancellation acknowledgement awaits these operations.',
      cancellationLimit: guest ? 'Owned container stop and inactive PID acknowledgement before cancellation response.' : 'Process-group termination. Deliberately detached descendant escape is not claimed.' };
    const target = path.join(runtime, job.id, 'receipt.json');
    const temporary = target + '.' + crypto.randomBytes(16).toString('hex') + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, target);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  function persistJob(job){
    const next = (job.persistence || Promise.resolve()).then(() => persistJobOnce(job));
    job.persistence = next.catch(() => {});
    return next;
  }
  async function persistJobOnce(job){
    job.receiptReady=false; job.persistenceFailed=false;
    try{
      await fs.mkdir(path.join(runtime,job.id),{recursive:true});
      // Invalidate the previous verdict before any replacement can fail.
      await fs.rm(path.join(runtime,job.id,'receipt.json'),{force:true});
      await saveReceipt(job); job.receiptReady=true;
      return true;
    }catch(_){
      job.state='failed'; job.code=1; job.output='native gate: receipt persistence failed; no success verdict';
      job.persistenceFailed=true;
      return false;
    }
  }
  function stop(job) {
    if (job.stopping) return job.stopping;
    job.cancelled = true;
    job.stopping = stopOnce(job);
    return job.stopping;
  }
  async function stopOnce(job) {
    job.cancelled = true;
    job.receiptReady=false; job.persistenceFailed=false;
    if (guest && job.containerName) await guest.stop(job.containerName);
    kill(job, 'SIGTERM');
    const force = setTimeout(() => { kill(job, 'SIGKILL'); job.child?.stdout.destroy(); job.child?.stderr.destroy(); }, 1000);
    try { await job.done; if (guest && job.containerName) await guest.stop(job.containerName); } finally { clearTimeout(force); }
    // A terminal positive result racing with Stop cannot become a success.
    job.state = 'cancelled'; job.code = 130;
    job.output = 'native gate: cancelled; no result was applied to the checkout';
    if(!await persistJob(job)) throw new Error('Native cancellation receipt could not be persisted');
    return publicJob(job);
  }
  async function execute(job) {
    const started = Date.now(); let outputBytes = 0;
    const view = path.join(runtime, job.id, 'view');
    await fs.mkdir(path.dirname(view));
    await fs.cp(template, view, { recursive: true });
    await fs.mkdir(path.join(view, '.tmp'));
    await fs.mkdir(path.join(view, '.tmp', 'home'));
    await fs.writeFile(path.join(view, mutable), job.candidate);
    const profile = path.join(runtime, job.id, 'profile.sb');
    await fs.writeFile(profile, sandboxProfile({ view, nodePath, runtimeBin }));
    const log = await fs.open(path.join(runtime, job.id, 'output.log'), 'wx', 0o600);
    try {
      for (const item of job.commands) {
        if(job.logError) throw job.logError;
        if (job.cancelled || Date.now() - started >= EXECUTION_TIME_MS) {
          job.code = job.cancelled ? 130 : 124; break;
        }
        const invocation = guest ? await guest.command(view, item.argv) : { executable: '/usr/bin/sandbox-exec', args: ['-f', profile, nodePath, ...item.argv] };
        job.containerName = invocation.name || null;
        if (job.cancelled) { if (guest) await guest.cleanup(job.containerName); job.containerName = null; job.code = 130; break; }
        const result = await new Promise(resolve => {
          let tail = '', settled = false, limitReached = false, timedOut = false;
          const child = spawn(invocation.executable, invocation.args, {
            cwd: view, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
            env: { PATH: runtimeBin + ':/usr/bin:/bin:/usr/sbin:/sbin',
              TMPDIR: path.join(view, '.tmp'), HOME: path.join(view, '.tmp', 'home'), LANG: 'en_US.UTF-8' },
          });
          job.child = child;
          const terminate = () => {
            if (guest && job.containerName) job.containerStop = guest.stop(job.containerName).catch(error => { job.logError ||= error; });
            kill(job, 'SIGTERM');
            escalation = setTimeout(() => { kill(job, 'SIGKILL'); child.stdout.destroy(); child.stderr.destroy(); }, 1000);
          };
          let escalation;
          const timeout = setTimeout(() => { timedOut = true; terminate(); },
            Math.min(COMMAND_TIME_MS, Math.max(1, EXECUTION_TIME_MS - (Date.now() - started))));
          function output(chunk) {
            outputBytes += chunk.length;
            if (outputBytes > OUTPUT_LIMIT) { if (!limitReached) { limitReached = true; terminate(); } return; }
            // Queue writes in the handle; keep only a bounded diagnostic tail.
            job.logWrites = job.logWrites.then(() => job.logError ? undefined : log.write(chunk)).catch(error=>{
              job.logError ||= error; terminate();
            });
            tail = (tail + chunk.toString()).slice(-2048);
          }
          child.stdout.on('data', output); child.stderr.on('data', output);
          function finish(code, error) {
            if (settled) return; settled = true;
            clearTimeout(timeout); clearTimeout(escalation); job.child = null;
            resolve({ command: item.command, code: job.cancelled ? 130 : limitReached ? 125 : timedOut ? 124 : code ?? 1,
              tail: error ? String(error.message).slice(0,2048) : tail });
          }
          child.once('error', error => finish(1, error));
          child.once('close', (code, signal) => finish(code, signal ? new Error('Native process ended with '+signal) : null));
        });
        if (guest && job.containerName) {
          await job.containerStop;
          await guest.cleanup(job.containerName);
          job.containerName = null; job.containerStop = null;
        }
        job.results.push(result); job.code = result.code;
        if (result.code !== 0) break;
      }
      await job.logWrites;
      if(job.logError) throw job.logError;
      await sourceValid(job.candidateSha256);
      // Gate assertions and Git history remain fixed in the execution view.
      for (const [name, hash] of expected) {
        if (name !== mutable && digest(await boundedFile(view, name)) !== hash) throw new Error('Native execution changed frozen source: ' + name);
      }
      if (job.cancelled) job.code = 130;
      job.state = job.code === 0 && job.results.length === job.commands.length ? 'passed' : job.code === 130 ? 'cancelled' : 'failed';
      job.output = `native gate: ${job.state}; ${job.results.filter(row => row.code === 0).length}/${job.commands.length} commands passed\n`
        + job.results.map(row => `${row.code === 0 ? 'PASS' : 'FAIL'} ${row.command}${row.code ? '\n' + row.tail : ''}`).join('\n');
    } finally {
      try { if (guest && job.containerName) { await guest.cleanup(job.containerName); job.containerName = null; } }
      finally { await log.close(); }
    }
  }
  async function start(mode, id) {
    const previous=jobs.get(id);
    if(previous){ if(previous.mode!==mode) throw new Error('Native job identity already has another mode'); return publicJob(previous); }
    if (active || shuttingDown || Date.now() >= expiresAt) throw new Error('Native gate is busy, closed, or expired');
    if (jobs.size >= 6) throw new Error('Native gate session run limit reached');
    const job = { id, mode, state: 'running', code: null,
      output: '', results: [], cancelled: false, child: null, logWrites: Promise.resolve(), receiptReady:false, persistenceFailed:false,
      commands: mode === 'criterion' ? [{ command: 'node ' + criterion, argv: [criterion] }] : commands };
    active = job;
    jobs.set(id,job);
    job.done=(async()=>{
      await sourceValid(); job.candidate = await boundedFile(source, mutable, MUTABLE_LIMIT);
      job.candidateSha256 = digest(job.candidate);
      if(job.cancelled){job.state='cancelled';job.code=130;job.output='native gate: cancelled before execution';return;}
      if (guest) await guest.prepare();
      await execute(job);
    })().catch(error => {
        job.state = job.cancelled ? 'cancelled' : 'failed'; job.code = job.cancelled ? 130 : 1;
        job.output = 'native gate: ' + String(error.message).slice(0,2048);
      }).finally(async () => {
        await persistJob(job);
        active = null;
      });
    return publicJob(job);
  }
  async function bodyOf(req) {
    let count = 0; const chunks = [];
    for await (const chunk of req) { count += chunk.length; if (count > 4096) throw new Error('Native request exceeds its byte bound'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString());
  }
  server = http.createServer(async (req, res) => {
    const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Private-Network': 'true',
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type',
      'Cache-Control': 'no-store', Vary: 'Origin', 'Content-Type': 'application/json', 'Cross-Origin-Resource-Policy': 'cross-origin' };
    function send(status, value) { res.writeHead(status, cors); res.end(JSON.stringify(value)); }
    try {
      const ownHost = '127.0.0.1:' + server.address().port;
      if (req.headers.host !== ownHost || req.headers.origin !== origin) return send(403, { error: 'Native gate origin or host refused' });
      if (req.method === 'OPTIONS') return send(204, {});
      if (req.method !== 'POST') return send(405, { error: 'Native gate requires POST' });
      const supplied = Buffer.from(req.headers.authorization || ''), want = Buffer.from('Bearer ' + token);
      if (supplied.length !== want.length || !crypto.timingSafeEqual(supplied, want)) return send(401, { error: 'Native gate owner pairing required' });
      const body = await bodyOf(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Native request must be an object');
      const keys = Object.keys(body);
      if (req.url === '/status' && keys.length === 0) return send(200, { service: 'naklios-native-gate',
        commandCount: commands.length, mutable, criterion, expiresAt });
      if (req.url === '/run' && keys.length === 2 && keys.includes('mode') && keys.includes('id')
          && ['full','criterion'].includes(body.mode) && typeof body.id==='string' && /^[A-Za-z0-9_-]{16,64}$/.test(body.id)) return send(202, await start(body.mode,body.id));
      if (['/job','/cancel'].includes(req.url) && keys.length === 1 && keys[0] === 'id') {
        const job = jobs.get(body.id); if (!job) return send(404, { error: 'Unknown native gate job' });
        return send(200, req.url === '/cancel' ? await stop(job) : publicJob(job));
      }
      return send(400, { error: 'Native gate route or arguments refused' });
    } catch (error) { if (!res.headersSent) send(400, { error: String(error.message).slice(0,2048) }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const endpoint = 'http://127.0.0.1:' + server.address().port + '/';
  const connectionFile = path.join(runtime, 'connection.json');
  await fs.writeFile(connectionFile, JSON.stringify({ version: 1, endpoint, token, binding, expiresAt }) + '\n', { mode: 0o600 });
  const close = async () => {
    shuttingDown = true; if (active) await stop(active);
    await new Promise(resolve => server.close(resolve));
    try { if(String(await boundedFile(source,BINDING,1024))===binding) await fs.unlink(path.join(source,BINDING)); } catch {}
  };
  const expiry = setTimeout(() => close().catch(() => {}), ttlMs); expiry.unref();
  return { endpoint, connectionFile, runtime, commandCount: commands.length,
    close: async () => { clearTimeout(expiry); await close(); } };
  }catch(error){
    if(server?.listening) await new Promise(resolve=>server.close(resolve));
    if(bindingOwned){
      try{if(String(await boundedFile(source,BINDING,1024))===binding) await fs.unlink(path.join(source,BINDING));}catch{}
    }
    await fs.rm(runtime,{recursive:true,force:true});
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {};
  const keys = new Map([['--checkout','checkout'],['--mutable','mutable'],['--criterion','criterion'],['--origin','origin'],['--port','port'],['--container-config','container']]);
  for (let i = 0; i < args.length; i += 2) {
    if (!keys.has(args[i]) || !args[i + 1]) throw new Error('Use --checkout --mutable --criterion --origin and optional --port');
    options[keys.get(args[i])] = args[i] === '--port' ? Number(args[i + 1]) : args[i + 1];
  }
  if (options.container) options.container = JSON.parse(await fs.readFile(options.container, 'utf8'));
  const gate = await createNativeGateServer(options);
  // Print the connection FILE, never its bearer credential or full descriptor.
  console.log(JSON.stringify({ service: 'naklios-native-gate', endpoint: gate.endpoint,
    connectionFile: gate.connectionFile, runtime: gate.runtime, commandCount: gate.commandCount }));
  for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => gate.close().then(() => process.exit(0)));
}
