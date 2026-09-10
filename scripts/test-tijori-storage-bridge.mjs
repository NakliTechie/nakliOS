import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const host = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('../apps/tijori/index.html', import.meta.url), 'utf8');
const scripts = [...app.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 4, 'expected Tijori’s four vendored inline scripts');

const sdk = scripts[0];
const appScript = scripts.at(-1);
new Function(sdk);
new Function(appScript);

// The product is spelled NakliOS. The GitHub repo is genuinely NakliTechie/nakliOS,
// so a repo path is not a misspelling — exclude it rather than ban the token.
assert.doesNotMatch(
  app,
  /(?<!NakliTechie\/)\b(?:naklOS|nakliOS|Naklios)\b/,
  'Tijori must use the NakliOS product spelling',
);
assert.match(app, /name="version" content="1\.3\.0"/);
assert.match(app, /connect-src 'none'/, 'Tijori must keep direct network access disabled');
assert.match(app, /frame-ancestors 'self'/, 'same-origin NakliOS mirror must be iframeable');
assert.match(appScript, /const NAKLIOS_DIR = Object\.freeze/);
assert.match(appScript, /metaVersion\(meta\) === 2 && !metaPwWrapEnabled\(meta\)/,
  'hardware-key-only imports must be refused across origins');
assert.match(appScript, /window\.showDirectoryPicker/,
  'standalone/local-folder storage must remain available');

for (const op of ['read', 'write', 'append', 'list', 'delete', 'exists']) {
  assert.match(sdk, new RegExp(`naklios:fs:${op}`), `SDK must expose fs.${op}`);
}
assert.match(sdk, /naklios:fs:selectBackend/);
assert.match(host, /msg\.type\.startsWith\('naklios:fs:'\)/);
assert.match(host, /op === 'selectBackend'\) reply\.result = await fsHostSelectBackend/);
assert.match(host, /op === 'list'\) reply\.result = await fsHostList/);
assert.match(host, /reply\.result = await fsHostHandle/);
assert.match(host, /switching copies or deletes nothing/,
  'host keeps backend switching non-destructive (no confirmation, scoped to apps/<id>/)');
assert.match(host, /fsBackends,/);
assert.match(host, /fsBackend,/);
assert.match(host, /const safe = fsSafePath\(appId, msg\.path \|\| ''\)/,
  'host must scope file operations to the requesting app');

let messageListener;
const sent = [];
const childWindow = {
  parent: { postMessage(message) { sent.push(message); } },
  addEventListener(type, callback) {
    if (type === 'message') messageListener = callback;
  },
};
vm.runInNewContext(sdk, {
  window: childWindow,
  Set,
  Map,
  Promise,
  Object,
  Error,
  Date,
  setTimeout: () => 0,
  clearTimeout: () => {},
});

// SDK v2 only honours messages whose source is window.parent and whose origin
// matches the origin learned on first contact — deliver them the way a real host does.
const HOST_ORIGIN = 'https://naklios.dev';
const fromHost = (data) => messageListener({ source: childWindow.parent, origin: HOST_ORIGIN, data });

// A message from anything other than the parent frame must be ignored.
messageListener({
  source: {},
  origin: HOST_ORIGIN,
  data: { type: 'naklios:capabilities', fs: true },
});
assert.notEqual(childWindow.naklios.capabilities.fs, true,
  'SDK must ignore naklios:* messages whose source is not window.parent');

fromHost({
  type: 'naklios:capabilities',
  fs: true,
  fsBackends: [{ id: 'crate', label: 'Crate', name: 'vault-bucket' }],
  fsBackend: 'crate',
});
assert.equal(childWindow.naklios.capabilities.fs, true);
assert.equal(childWindow.naklios.capabilities.fsBackends[0].name, 'vault-bucket');
assert.equal(childWindow.naklios.capabilities.fsBackend, 'crate');

const selectPromise = childWindow.naklios.fs.useBackend('crate');
const selectRequest = sent.at(-1);
assert.equal(selectRequest.type, 'naklios:fs:selectBackend');
assert.equal(selectRequest.backend, 'crate');
fromHost({ type: 'naklios:fs:reply', requestId: selectRequest.requestId, result: true });
assert.equal(await selectPromise, true);

const requestPromise = childWindow.naklios.fs.exists('tijori-meta.json');
const request = sent.at(-1);
assert.equal(request.type, 'naklios:fs:exists');
assert.equal(request.path, 'tijori-meta.json');
fromHost({ type: 'naklios:fs:reply', requestId: request.requestId, result: false });
assert.equal(await requestPromise, false);

console.log('NakliOS ↔ Tijori storage bridge contract: PASS');
