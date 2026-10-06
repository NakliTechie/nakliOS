// Optional owner-paired native gate. The connection stays in memory, outside
// the agent's messages, settings, and operation log.
export const NATIVE_BINDING_PATH = '.anvil/gate/native-binding.json';
const MAX_RESPONSE = 1024 * 1024;

export function validateConnection(value) {
  if (!value || value.version !== 1 || typeof value.token !== 'string'
      || !/^[A-Za-z0-9_-]{32,128}$/.test(value.token)
      || typeof value.binding !== 'string' || value.binding.length > 1024
      || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()) {
    throw new Error('Invalid or expired native gate connection');
  }
  const url = new URL(value.endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Native gate connections require a plain IPv4 loopback origin');
  }
  return Object.freeze({ version: 1, endpoint: url.origin, token: value.token,
    binding: value.binding, expiresAt: value.expiresAt });
}

export function createNativeGateClient({ connection, readBinding, fetch: fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now } = {}) {
  const settings = validateConnection(connection);
  let closed = false, commandCount = null;
  const activeJobs = new Map();
  async function request(route, body, signal) {
    const response = await fetchImpl(settings.endpoint + route, {
      method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + settings.token },
      body: JSON.stringify(body),
    });
    // Bound before retaining the complete response, including an error body.
    if (!response.body?.getReader) throw new Error('Native gate response has no bounded stream');
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE) throw new Error('Native gate response exceeds its byte bound');
        chunks.push(part.value);
      }
    } finally { try { await reader.cancel(); } catch {} reader.releaseLock(); }
    const all = new Uint8Array(bytes); let at = 0;
    for (const part of chunks) { all.set(part, at); at += part.length; }
    let data;
    try { data = JSON.parse(new TextDecoder().decode(all)); }
    catch { throw new Error('Native gate returned invalid JSON'); }
    if (!response.ok) throw new Error(data.error || 'Native gate refused the request');
    return data;
  }
  async function check() {
    if (closed || now() >= settings.expiresAt) throw new Error('Native gate connection is closed or expired');
    if (await readBinding() !== settings.binding) throw new Error('Native gate belongs to another workspace');
  }
  function validateResult(result, id, mode) {
    if(result.id!==id || !['passed','failed','cancelled'].includes(result.state)
        || !Number.isInteger(result.code) || result.code<0 || result.code>255
        || typeof result.output!=='string' || result.output.length>128000
        || ((result.state==='passed')!==(result.code===0))
        || (result.state==='cancelled' && result.code!==130)
        || !Number.isInteger(result.completedCommands) || result.completedCommands<0
        || !Number.isInteger(result.totalCommands) || result.totalCommands<1 || result.totalCommands>500
        || result.completedCommands>result.totalCommands
        || (mode==='criterion' && result.totalCommands!==1)
        || (mode==='full' && commandCount!==null && result.totalCommands!==commandCount)
        || (result.receipt!==null && result.receipt!==id+'/receipt.json')
        || (result.state==='cancelled' && result.receipt!==id+'/receipt.json')
        || (result.state==='passed' && (result.receipt!==id+'/receipt.json'
          || result.completedCommands!==result.totalCommands || (mode==='full' && commandCount===null)))) {
      throw new Error('Invalid native gate result');
    }
    return result;
  }
  async function cancel(id) {
    const mode=activeJobs.get(id);
    const result=await request('/cancel', { id }, AbortSignal.timeout(10000));
    try{
      validateResult(result,id,mode);
      if(result.state!=='cancelled' || await readBinding()!==settings.binding) throw new Error('Cancellation binding changed');
    }catch(_){throw new Error('Native gate cancellation was not acknowledged');}
    activeJobs.delete(id);
    return result;
  }
  return {
    async connect() {
      await check();
      let binding;
      try { binding = JSON.parse(settings.binding); } catch { throw new Error('Invalid native gate binding metadata'); }
      const portable = name => typeof name === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(name)
        && name.split('/').every(part => part !== '.' && part !== '..');
      if (binding.version !== 1 || !/^[A-Za-z0-9_-]{32,128}$/.test(binding.session)
          || !/^[a-f0-9]{64}$/.test(binding.workflowSha256) || !portable(binding.mutable)
          || !portable(binding.criterion) || binding.mutable === binding.criterion || binding.mutable === '.github/workflows/test.yml'
          || /(^|\/)(?:test|scripts|\.git|\.anvil)(?:\/|$)/.test(binding.mutable)) {
        throw new Error('Invalid native gate binding metadata');
      }
      const metadata = await request('/status', {}, AbortSignal.timeout(10000));
      if (metadata.service !== 'naklios-native-gate' || metadata.mutable !== binding.mutable
          || metadata.criterion !== binding.criterion || metadata.expiresAt !== settings.expiresAt
          || !Number.isInteger(metadata.commandCount) || metadata.commandCount < 1 || metadata.commandCount > 500) {
        throw new Error('Native gate status does not match the owner-issued binding');
      }
      await check();
      commandCount = metadata.commandCount;
      return metadata;
    },
    async run(mode = 'full', { signal } = {}) {
      if (!['full', 'criterion'].includes(mode)) throw new Error('Use native-gate full or native-gate criterion');
      await check();
      if (signal?.aborted) return { code: 130, output: 'native gate: cancelled before execution', state: 'cancelled' };
      // The client owns the identity before /run. A lost acknowledgement does
      // not hide the job's cancellation address.
      const id = crypto.randomUUID().replaceAll('-', '');
      activeJobs.set(id,mode);
      let cancelPromise = null;
      const stop = () => { cancelPromise ||= cancel(id); cancelPromise.catch(() => {}); };
      signal?.addEventListener('abort', stop, { once: true });
      try {
        const started = await request('/run', { mode, id }, AbortSignal.timeout(10000));
        if(started.id!==id) throw new Error('Native gate returned another job identity');
        if (signal?.aborted) stop();
        while (true) {
          if (closed || now() >= settings.expiresAt) stop();
          if (cancelPromise) {
            const result = await cancelPromise;
            if (result.state !== 'cancelled' || result.code !== 130) throw new Error('Native gate cancellation was not acknowledged');
            return result;
          }
          const result = await request('/job', { id }, AbortSignal.timeout(10000));
          if(result.id!==id) throw new Error('Native gate returned another job identity');
          if(cancelPromise) continue;
          if (result.state !== 'running') {
            validateResult(result,id,mode);
            await check();
            if(signal?.aborted) stop();
            if(cancelPromise) return await cancelPromise;
            activeJobs.delete(id);
            return result;
          }
          await sleep(250);
        }
      } catch (error) {
        // An observation failure never means the native process has stopped.
        try { await cancel(id); } catch { error.message += '; cancellation unconfirmed'; }
        throw error;
      } finally { signal?.removeEventListener('abort', stop); }
    },
    async close() {
      closed = true;
      await Promise.all([...activeJobs.keys()].map(cancel));
    },
  };
}
