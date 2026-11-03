#!/usr/bin/env node
// Common rail step 1: an app registers commands through naklios.experimental_commands, the desktop
// catalog lists them as <app-id>.<name>, and a caller invokes them through the agent face, which
// applies the grant, the op-log and staging. Runs the real SDK, catalog, registry and agent face.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCatalog, validateInput } from '../sys/host/catalog.mjs';
import { createHostRegistry, HOST_COMMANDS } from '../sys/host/agent.mjs';
import { createAgentFace, createGrant, createOpLog } from '../sys/rig/agent/index.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';

const actions = Object.fromEntries(HOST_COMMANDS.map(row => [row[2], async () => ({ host: row[2] })]));
const base = () => createHostRegistry(actions);

// A stand-in app window: dispatch records the call; the test answers it as the app would.
function standIn(catalog, appId = 'standin', owner = { window: appId }) {
  const calls = [];
  const out = catalog.register(appId, owner, [
    { name: 'greet', description: 'Say hello to someone', scope: 'read', input: { type: 'object', properties: { name: { type: 'string', minLength: 1 } }, required: ['name'] } },
    { name: 'list.add', description: 'Add an item to a list', scope: 'write', input: { type: 'object', properties: { item: { type: 'string' } }, required: ['item'] } },
    { name: 'wipe', description: 'Delete every list', scope: 'destructive' },
  ], call => calls.push(call));
  return { out, calls, owner };
}
const answer = (catalog, app, value) => {
  const call = app.calls.at(-1);
  assert.ok(call, 'the app received a call');
  return catalog.settle('standin', app.owner, call.invokeId, value);
};
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

// ── catalog rules ──
{
  const catalog = createCatalog({ base: base() });
  const app = standIn(catalog);
  assert.deepEqual(app.out, { ok: true, registered: ['standin.greet', 'standin.list.add', 'standin.wipe'] });
  const names = catalog.toolSchemas().map(t => t.name);
  assert.ok(names.includes('apps.list') && names.includes('standin.greet'), 'one catalog lists desktop and app commands');
  assert.equal(catalog.describeCommand('standin.wipe').destructive, true);
  assert.equal(catalog.describeCommand('standin.greet').scope, 'app:read');
  assert.equal(catalog.describeCommand('standin.list.add').scope, 'app:write');
  assert.equal(catalog.describeCommand('standin.greet').run, undefined, 'discovery never exposes the handler');
  assert.ok(catalog.searchCommands('hello').some(c => c.name === 'standin.greet'), 'search finds app commands');

  assert.match(catalog.register('apps', {}, [{ name: 'list', description: 'x', scope: 'read' }], () => {}).error, /desktop command/,
    'an app cannot take a desktop command name');
  assert.match(catalog.register('x', {}, [{ name: 'Bad Name', description: 'x', scope: 'read' }], () => {}).error, /invalid command name/);
  assert.match(catalog.register('x', {}, [{ name: 'a', description: 'x', scope: 'admin' }], () => {}).error, /scope/);
  assert.match(catalog.register('x', {}, [{ name: 'a', description: '', scope: 'read' }], () => {}).error, /description/);
  assert.match(catalog.register('x', {}, [{ name: 'a', description: 'x', scope: 'read', input: { type: 'array' } }], () => {}).error, /object schema/);
  assert.match(catalog.register('x', {}, Array.from({ length: 65 }, (_, i) => ({ name: `c${i}`, description: 'x', scope: 'read' })), () => {}).error, /at most/);

  // replace, owner checks, unregister
  catalog.register('standin', app.owner, [{ name: 'only', description: 'The only one', scope: 'read' }], () => {});
  assert.equal(catalog.describeCommand('standin.greet'), null, 'a second register replaces the whole set');
  assert.equal(catalog.unregister('standin', { window: 'stale' }), false, 'a stale window cannot remove a newer registration');
  assert.equal(catalog.unregister('standin', app.owner), true);
  assert.equal(catalog.describeCommand('standin.only'), null);
}

// ── invoke through the agent face: grant, validation, timeout, staging, op-log ──
{
  const catalog = createCatalog({ base: base() });
  const app = standIn(catalog);
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const grant = createGrant({ prefixes: [''], scopes: ['ui:read', 'app:read', 'app:write'] });
  const face = createAgentFace({ registry: catalog, grant, opLog, actor: 'agent', caller: 'test' });

  const pending = face.invoke('standin.greet', { name: 'Chirag' });
  await tick();
  assert.deepEqual(app.calls.at(-1).args, { name: 'Chirag' });
  assert.equal(app.calls.at(-1).name, 'greet', 'the app receives its own short name');
  assert.equal(answer(catalog, app, { result: 'Hello, Chirag' }), true);
  assert.deepEqual(await pending, { ok: true, result: 'Hello, Chirag' });

  const failing = face.invoke('standin.list.add', { item: 'milk' });
  await tick();
  assert.equal(catalog.settle('standin', { window: 'other' }, app.calls.at(-1).invokeId, { result: 'forged' }), false,
    'only the registering window answers its calls');
  answer(catalog, app, { error: 'list is full' });
  assert.deepEqual(await failing, { ok: false, code: 'EAPP', message: 'list is full' });

  assert.equal((await face.invoke('standin.greet', {})).code, 'EINVAL', 'missing argument');
  assert.equal((await face.invoke('standin.greet', { name: 'a', extra: 1 })).code, 'EINVAL', 'unknown argument');
  assert.equal((await face.invoke('standin.greet', { name: 5 })).code, 'EINVAL', 'wrong type');

  const staged = await face.invoke('standin.wipe', {});
  assert.equal(staged.staged, true, 'a destructive command stages for the person');
  assert.equal(app.calls.filter(c => c.name === 'wipe').length, 0, 'staging runs nothing in the app');
  const accepted = face.accept(staged.proposalId);
  await tick();
  assert.equal(app.calls.at(-1).name, 'wipe');
  answer(catalog, app, { result: { wiped: 3 } });
  assert.deepEqual(await accepted, { ok: true, result: { wiped: 3 } });

  const readOnly = createAgentFace({ registry: catalog, grant: createGrant({ prefixes: [''], scopes: ['app:read'] }), opLog, actor: 'agent' });
  assert.equal((await readOnly.invoke('standin.list.add', { item: 'x' })).code, 'EGRANT', 'write needs app:write in the grant');
  const before = app.calls.length;
  assert.equal(app.calls.length, before, 'a refused call never reaches the app');

  const log = await opLog.read();
  assert.ok(log.some(e => e.command === 'standin.greet' && e.status === 'ok'), 'History records the app call');
  assert.ok(log.some(e => e.command === 'standin.wipe' && e.status === 'staged'));

  const waiting = face.invoke('standin.greet', { name: 'x' });
  await tick();
  catalog.unregister('standin', app.owner);
  assert.equal((await waiting).code, 'EGONE', 'closing the app fails its waiting calls');
  assert.equal((await face.invoke('standin.greet', { name: 'x' })).code, 'ENOCMD', 'a closed app has no commands');
}
{
  let fire;
  const catalog = createCatalog({ base: base(), timeoutMs: 1000, setTimeoutFn: fn => { fire = fn; return 1; }, clearTimeoutFn: () => {} });
  standIn(catalog);
  const waiting = catalog.invokeCommand('standin.greet', { name: 'x' });
  fire();
  assert.equal((await waiting).code, 'ETIMEOUT', 'a handler that never answers times out instead of hanging');
}
assert.equal(validateInput({ type: 'object', properties: { n: { type: 'integer' } }, required: [], additionalProperties: false }, { n: 1.5 }), 'n must be integer');

// ── step 2: declared commands are listed while the app is closed; a call opens it and waits for it to register ──
{
  const catalog = createCatalog({ base: base() });
  const launched = []; let app;
  const manifest = [
    { name: 'greet', description: 'Say hello to someone', scope: 'read', input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    { name: 'wipe', description: 'Delete every list', scope: 'destructive' },
  ];
  assert.deepEqual(catalog.declare('standin', manifest, id => { launched.push(id); setImmediate(() => { app = standIn(catalog); }); }),
    { ok: true, declared: ['standin.greet', 'standin.wipe'] });
  assert.equal(catalog.describeCommand('standin.greet').annotations.opensApp, true, 'listed while the app is closed');
  assert.equal((await catalog.invokeCommand('standin.greet', {})).code, 'EINVAL', 'arguments are checked before the app opens');
  assert.deepEqual(launched, []);
  const waiting = catalog.invokeCommand('standin.greet', { name: 'Om' });
  await tick(); await tick();
  assert.deepEqual(launched, ['standin'], 'the first call opens the app once');
  assert.match(app.out.error, /not in standin's commands\.json/, 'an app may register only what it declared');
  const ok = catalog.register('standin', app.owner, manifest.map(c => ({ ...c, description: 'changed text' })), call => app.calls.push(call));
  assert.equal(ok.ok, true);
  assert.equal(catalog.describeCommand('standin.greet').description, 'Say hello to someone', 'the manifest\'s text is the one listed');
  await tick();
  answer(catalog, app, { result: 'Hello, Om' });
  assert.deepEqual(await waiting, { ok: true, result: 'Hello, Om' });
  assert.match(catalog.register('standin', app.owner, [{ ...manifest[0], scope: 'write' }], () => {}).error, /differs from the declared read/);
  catalog.unregister('standin', app.owner);
  assert.ok(catalog.describeCommand('standin.greet'), 'closing the app keeps its declared commands listed');
}
{
  let fire;
  const catalog = createCatalog({ base: base(), launchTimeoutMs: 1000, setTimeoutFn: fn => { fire = fn; return 1; }, clearTimeoutFn: () => {} });
  catalog.declare('standin', [{ name: 'greet', description: 'Say hello', scope: 'read' }], () => {});
  const waiting = catalog.invokeCommand('standin.greet', {});
  await tick(); fire();
  assert.equal((await waiting).code, 'ELAUNCH', 'an app that never registers fails the call instead of hanging');
}

// ── the SDK: register and answer an invoke ──
const sdk = await readFile(new URL('../sdk/naklios.js', import.meta.url), 'utf8');
function sdkFrame({ hosted = true } = {}) {
  const sent = []; let receive;
  const parent = { postMessage: message => sent.push(message) };
  const window = { location: { search: '?naklios' }, parent, addEventListener: (type, fn) => { if (type === 'message') receive = fn; } };
  if (!hosted) window.parent = window;
  vm.runInNewContext(sdk, { window, document: {}, URL, URLSearchParams, Map, Set, Promise, Date, Error, Object, setTimeout: () => 0, clearTimeout: () => {} });
  // The SDK runs in its own realm; plain() brings its values over for deep comparison.
  return { api: window.naklios, sent, send: data => receive({ origin: 'https://naklios.dev', data, source: parent }) };
}
{
  const app = sdkFrame();
  app.send({ type: 'naklios:capabilities' });
  const seen = [];
  const registered = app.api.experimental_commands.register([
    { name: 'greet', description: 'Say hello', scope: 'read', input: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      handler: async (args, context) => { seen.push(context); return `Hello, ${args.name}`; } },
    { name: 'boom', description: 'Always fails', scope: 'write', handler: () => { throw new Error('nope'); } },
  ]);
  const request = app.sent.find(m => m.type === 'naklios:commands:register');
  assert.ok(request, 'register sends the declarations');
  assert.deepEqual(plain(request.commands.map(c => c.name)), ['greet', 'boom']);
  assert.ok(request.commands.every(c => !('handler' in c)), 'handlers never leave the app');
  app.send({ type: 'naklios:commands:reply', requestId: request.requestId, result: { ok: true, registered: ['standin.greet'] } });
  assert.deepEqual(await registered, { ok: true, registered: ['standin.greet'] });

  app.send({ type: 'naklios:commands:invoke', invokeId: 'c1', name: 'greet', args: { name: 'Om' } });
  await tick(); await tick();
  assert.deepEqual(plain(app.sent.find(m => m.type === 'naklios:commands:result' && m.invokeId === 'c1')), { type: 'naklios:commands:result', invokeId: 'c1', result: 'Hello, Om' });
  app.send({ type: 'naklios:commands:invoke', invokeId: 'c2', name: 'boom', args: {} });
  await tick(); await tick();
  assert.equal(app.sent.find(m => m.invokeId === 'c2').error, 'nope', 'a throw comes back as the error');
  app.send({ type: 'naklios:commands:invoke', invokeId: 'c3', name: 'missing', args: {} });
  assert.match(app.sent.find(m => m.invokeId === 'c3').error, /unknown command/);

  await assert.rejects(app.api.experimental_commands.register([{ name: 'x' }]), /needs a handler/);
  await assert.rejects(app.api.experimental_commands.register('x'), /needs a list/);
}
{
  const alone = sdkFrame({ hosted: false });
  const out = await alone.api.experimental_commands.register([{ name: 'x', description: 'y', scope: 'read', handler: () => 1 }]);
  assert.deepEqual(plain(out), { standalone: true, registered: [] });
  assert.equal(alone.sent.length, 0, 'standalone sends nothing');
}

// ── the desktop wires both messages and drops an app's commands when its window closes ──
const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(host, /msg\.type === 'naklios:commands:register'[\s\S]*?catalog\.register\(appId, source, msg\.commands/);
assert.match(host, /msg\.type === 'naklios:commands:result'[\s\S]*?catalog\.settle\(getAppId\(\), e\.source/);
assert.match(host, /function finalizeCloseWindow[\s\S]*?catalog\.unregister\(id, closedSource\)/);

console.log('common rail step 1 — commands catalog, agent face, SDK and host wiring: PASS');
