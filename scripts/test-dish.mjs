import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { toChatRequest, responseChunks } from './dish/protocol.mjs';
import { normaliseAgentMessages } from '../sys/ai/agent-protocol.mjs';
import { waitForCapabilities } from '../apps/dish/lifecycle.mjs';
import { Snapshot, validPath, hostStore } from '../apps/dish/storage.mjs';

test('agent request preserves tool call correlation and one-shot system content', () => {
  const request = toChatRequest({ system: 'system', messages: [
    { role: 'user', content: [{ type: 'text', text: 'read the file' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a"}' }] },
    { role: 'tool', source: { callId: 'call-1' }, content: [{ type: 'text', text: 'contents' }] },
  ], tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }] });
  assert.equal(request.agent, true);
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages[2].tool_calls[0].id, request.messages[3].tool_call_id);
  assert.equal(request.tools[0].function.name, 'read');
});
test('unsupported attachments refuse without silent content loss', () => {
  assert.throws(() => toChatRequest({ messages: [{ role: 'user', content: [{ type: 'image' }] }] }), /cannot send image/);
});
test('completion preserves reasoning, tools, usage and finish cause', () => {
  const chunks = [...responseChunks({ choices: [{ message: { content: 'text', reasoning_content: 'reason', tool_calls: [{ id: 'c', function: { name: 'read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 30 } } })];
  assert.deepEqual(chunks.filter(c => c.type === 'block-start').map(c => c.blockType), ['reasoning','text','tool-call']);
  assert.equal(chunks.find(c => c.type === 'usage').usage.inputTokens, 70);
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  assert.equal([...responseChunks({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })].at(-1).reason.kind, 'max-tokens');
  assert.throws(() => [...responseChunks({ choices: [] })], /no completion/);
});
test('snapshots retain binary files, permissions, rename mutations and recursive removal', () => {
  const snapshot = new Snapshot();
  snapshot.apply({ kind: 'mkdir', path: 'workspace/project', mode: 493 });
  snapshot.apply({ kind: 'write', path: 'workspace/project/a', bytes: new Uint8Array([0,255,1]), mode: 384 });
  snapshot.apply({ kind: 'chmod', path: 'workspace/project/a', mode: 420 });
  assert.equal(snapshot.values().find(e => e.path.endsWith('/a')).mode, 420);
  assert.deepEqual(new Snapshot(snapshot.values()).values(), snapshot.values());
  snapshot.apply({ kind: 'remove', path: 'workspace/project' });
  assert.deepEqual(snapshot.values(), []);
});
test('snapshot rejects traversal and immutable module replacement', () => {
  for (const path of ['workspace/../config', 'home//file', '/dsh/home/file', 'node_modules/a', 'workspace/./x']) {
    assert.equal(validPath(path), false);
    assert.throws(() => new Snapshot([{ path, bytes: [] }]), /Invalid/);
  }
});
test('snapshot rejects malformed binary data', () => {
  for (const bytes of [[256],[-1],[0.5],['secret']]) assert.throws(() => new Snapshot([{ path: 'home/file', bytes }]), /Invalid/);
});
test('host saves commit through app-scoped filesystem and reject a backend rebind', async () => {
  const cap = { fs: true, fsBackend: 'fsa' }; let stored;
  const sdk = { capabilities: cap, fs: { exists: async () => !!stored, read: async () => stored, write: async (path, data) => { assert.equal(path, 'vfs.json'); stored = data; } } };
  const store = hostStore(sdk); assert.deepEqual(await store.load(), []);
  await store.save([{ path: 'home/session', bytes: [1] }]);
  assert.equal((await store.load())[0].path, 'home/session');
  cap.fsBackend = 'crate';
  await assert.rejects(store.save([]), /backend changed/);
});
test('Dish ships a pinned image, shared broker provider and declared host routing', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url),'utf8');
  assert.match(html, /id:'dish', name:'Dish', kind:'system'/);
  assert.match(html, /AI_HOST_AGENT_APPS = new Set\(\['anvil', 'forge', 'dish', 'pi'\]\)/);
  assert.match(fs.readFileSync(new URL('../apps/dish/profile.yml', import.meta.url),'utf8'), /provider: naklios\n\s+model: shared/);
  const profile = fs.readFileSync(new URL('../apps/dish/profile.yml', import.meta.url),'utf8');
  assert.match(profile, /documentsDirectory: \/dsh\/workspace/);
  assert.match(profile, /- id: naklios-llm\n\s+name: '@naklios\/dish-llm'/);
  // The Worker composes the profile at boot; excluded rows stay as disabled home-patch rows.
  const rows = profile.split(/\n(?=\s*- id: )/);
  for (const id of ['llm-deepseek', 'deepseek-account', 'product-analytics', 'session-telemetry-otel', 'web-search-deepseek', 'ui-settings-account', 'account-controller']) {
    for (const row of rows.filter(row => row.trimStart().startsWith(`- id: ${id}\n`))) assert.match(row, /\n\s+disabled: true/, id);
  }
  assert.ok(fs.statSync(new URL('../apps/dish/preview/vfs-image.tar.gz', import.meta.url)).size > 0);
});
test('the image carries the curated home patch the Worker composes at boot', () => {
  const image = new URL('../apps/dish/preview/vfs-image.tar.gz', import.meta.url).pathname;
  const patch = execFileSync('tar', ['-xOf', image, 'home/cordis.patch.yml'], { encoding: 'utf8' });
  const metrics = JSON.parse(fs.readFileSync(new URL('../apps/dish/build-metrics.json', import.meta.url)));
  assert.ok(metrics.disabledIds.includes('llm-deepseek'));
  for (const id of metrics.disabledIds) assert.match(patch, new RegExp(`- id: ${id}\\n\\s+disabled: true`), id);
  assert.match(patch, /- id: agent-default-model\n\s+config:\n\s+provider: naklios\n\s+model: shared/);
  assert.match(patch, /- insert:\n\s+- id: naklios-llm\n\s+name: '@naklios\/dish-llm'/);
  assert.match(patch, /- id: session-persistence-jsonl\n\s+config:[\s\S]*?compression: none/);
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', image, 'config/vfs-manifest.json'], { encoding: 'utf8' }));
  assert.equal(manifest.profile, 'web');
  assert.deepEqual(manifest.lazy.flatMap(entry => entry.files.map(file => file.path)).sort(), [...metrics.lazyChunks].sort());
  for (const entry of manifest.lazy) {
    const archive = new URL(`../apps/dish/preview/${entry.archive}`, import.meta.url);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), entry.archive.match(/([0-9a-f]{64})\.tar\.gz$/)[1]);
  }
});
test('snapshot restore leaves the image-owned home patch alone', () => {
  const bridge = fs.readFileSync(new URL('./dish/vfs-bridge.txt', import.meta.url), 'utf8');
  assert.match(bridge, /imageOwned = \(path: string\) => path === 'home\/cordis\.patch\.yml'/);
  assert.match(bridge, /if \(imageOwned\(entry\.path\)\) continue;/);
  assert.match(bridge, /\|\| imageOwned\(relative\)\) return;/);
});

test('shipped artifact hashes match the immutable provenance record', () => {
  const root = new URL('../apps/dish/', import.meta.url);
  const lock = JSON.parse(fs.readFileSync(new URL('upstream.lock.json', root)));
  const source = JSON.parse(fs.readFileSync(new URL('./dish/source.lock.json', import.meta.url)));
  assert.deepEqual([lock.tag, lock.commit], [source.tag, source.commit]);
  for (const [name, expected] of Object.entries(lock.files)) {
    const bytes = fs.readFileSync(new URL(name, root));
    assert.equal(bytes.length, expected.bytes, name);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), expected.sha256, name);
  }
});

test('pack retains valid client bundles and debugger names after minification', () => {
  const root = new URL('../apps/dish/', import.meta.url);
  const metrics = JSON.parse(fs.readFileSync(new URL('build-metrics.json', root)));
  assert.ok(metrics.clientBundles.length > 0);
  assert.ok(metrics.clientOutputBytes < metrics.clientInputBytes);
  const image = new URL('preview/vfs-image.tar.gz', root).pathname;
  assert.equal(fs.statSync(image).size, metrics.imageBytes);
  const archivePaths = execFileSync('tar', ['-tzf', image], { encoding: 'utf8' }).split('\n');
  assert.ok(metrics.removedClientBundles.includes('node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'));
  for (const name of metrics.removedClientBundles) assert.ok(!archivePaths.includes(name), name);
  // PDF and spreadsheet previews load on demand from lazy archives beside the image.
  assert.ok(metrics.lazyChunks.includes('node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.pdf.js'));
  assert.ok(metrics.lazyChunks.includes('node_modules/@deepseek-ai/dsh-client-ui-sidebar-documentpreview/lib/client.excel.js'));
  for (const name of metrics.clientBundles) {
    const code = execFileSync('tar', ['-xOf', image, name], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    assert.match(code, /\/\/# sourceURL=\S+\s*$/);
    // client.node.js faces are ES modules; Node parses those in module mode.
    try { new vm.Script(code, { filename: name }); }
    catch (error) {
      if (!/import statement outside a module|Unexpected token 'export'/.test(error.message)) throw error;
      assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--check'], { input: code, stdio: ['pipe', 'ignore', 'pipe'] }), name);
    }
  }
});

test('DSH developer context retains its role through the shared agent broker', () => {
  const request = toChatRequest({ messages: [
    { role: 'system', content: [{ type: 'text', text: 'system instructions' }] },
    { role: 'developer', content: [{ type: 'text', text: 'workspace instructions' }] },
    { role: 'user', content: [{ type: 'text', text: 'task' }] },
  ] });
  assert.deepEqual(normaliseAgentMessages(request.messages), request.messages);
});
test('capability handshake waits for the host reply and releases its listener', async () => {
  let listener, stopped = false, cancelled = false;
  const cap = { fs: true, fsBackend: 'crate' };
  const sdk = {
    onCapabilitiesChange(callback) { listener = callback; callback({ fs: false }); return () => { stopped = true; }; },
    requestCapabilities() { listener(cap); },
  };
  const timers = { setTimeout() { return 1; }, clearTimeout(id) { assert.equal(id, 1); cancelled = true; } };
  assert.equal(await waitForCapabilities(sdk, { timers }), cap);
  assert.ok(stopped && cancelled);
});
test('capability handshake refuses silently opening the wrong library after a timeout', async () => {
  let expire, stopped = false;
  const sdk = {
    onCapabilitiesChange(callback) { callback({ fs: false }); return () => { stopped = true; }; },
    requestCapabilities() {},
  };
  const timers = { setTimeout(callback) { expire = callback; return 1; }, clearTimeout() {} };
  const pending = waitForCapabilities(sdk, { timers }); expire();
  await assert.rejects(pending, /NakliOS did not reply/);
  assert.ok(stopped);
});


test('packed provider loads its transitive protocol and registers the shared route', async () => {
  const image = new URL('../apps/dish/preview/vfs-image.tar.gz', import.meta.url).pathname;
  const read = name => execFileSync('tar', ['-xOf', image, `node_modules/@naklios/dish-llm/${name}`], { encoding: 'utf8' });
  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.exports['.'], './lib/index.js');
  const protocol = {};
  vm.runInNewContext(read('lib/protocol.mjs'), { exports: protocol });
  const plugin = {};
  vm.runInNewContext(read('lib/index.js'), { exports: plugin, require: name => {
    if (name === '@deepseek-ai/dsh-llm') return { LlmAdapter: class {} };
    if (name === './protocol.mjs') return protocol;
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  let registered;
  plugin.apply({ effect: callback => callback(), llm: { registerAdapter: (routes, adapter) => {
    registered = { routes, adapter }; return () => {};
  } } });
  assert.equal(registered.routes[0], 'naklios');
  assert.equal((await registered.adapter.resolveModel('naklios', 'shared')).id, 'shared');
});
test('upstream check flags only rc or final tags newer than the pin', async () => {
  const { newerTrackedTag } = await import('./dish/check-upstream.mjs');
  const tags = ['dsh-v0.2.2-alpha.2', 'dsh-v0.2.1-rc.4', 'dsh-v0.2.1-rc.3', 'dsh-v0.2.1-alpha.5', 'other'];
  assert.equal(newerTrackedTag(tags, 'dsh-v0.2.1-rc.4'), undefined);
  assert.equal(newerTrackedTag([...tags, 'dsh-v0.2.1-rc.10'], 'dsh-v0.2.1-rc.4'), 'dsh-v0.2.1-rc.10');
  assert.equal(newerTrackedTag([...tags, 'dsh-v0.2.1', 'dsh-v0.2.2-rc.1'], 'dsh-v0.2.1-rc.4'), 'dsh-v0.2.2-rc.1');
  assert.equal(newerTrackedTag([...tags, 'dsh-v0.2.1'], 'dsh-v0.2.1-rc.4'), 'dsh-v0.2.1');
  assert.throws(() => newerTrackedTag(tags, 'dsh-v0.2.2-alpha.2'), /not an rc or final/);
});
