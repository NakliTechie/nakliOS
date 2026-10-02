import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const [html, coreSource, host, sdk, files, spec] = await Promise.all([
  readFile(new URL('../apps/editor/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/editor/core.js', import.meta.url), 'utf8'),
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../sdk/naklios.js', import.meta.url), 'utf8'),
  readFile(new URL('../apps/files/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../docs/file-handoff-v1.md', import.meta.url), 'utf8'),
]);

const context = { globalThis: {} };
vm.runInNewContext(coreSource, context);
const Core = context.globalThis.EditorCore;

assert.equal(Core.normalisePath('/src\\main.js/'), 'src/main.js');
assert.throws(() => Core.normalisePath('../secret.txt'));
assert.equal(Core.detectLanguage('src/main.tsx'), 'TypeScript JSX');
assert.equal(Core.detectLanguage('.gitignore'), 'Git ignore');
assert.equal(Core.recoveryKey('crate', 'src/a.js'), 'crate::src/a.js');
assert.deepEqual(
  JSON.parse(JSON.stringify(Core.normaliseWorkspace({ open:['a.js', '../bad'], active:'a.js' }))),
  { version:1, open:['a.js'], active:'a.js' },
);
assert.equal(Core.searchText('one TWO two', 'two', {}).length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(Core.lineColumn('one\ntwo', 6))), { line:2, column:3 });
assert.deepEqual(JSON.parse(JSON.stringify(Core.lineOffsets('one\ntwo\n'))), [0,4,8]);
assert.deepEqual(JSON.parse(JSON.stringify(Core.lineOffsets(''))), [0]);
assert.equal(Core.lineForOffset([0,4,8],5),2);
assert.equal(Core.lineForOffset([0,4,8],8),3);
const visible=Core.visibleRange(100_000, 50_000, 900, 20, 12);
assert.ok(visible.start<=2500&&visible.end>2500);
assert.ok(visible.end-visible.start<=120,'large files mount at most 120 reader rows');
assert.deepEqual(JSON.parse(JSON.stringify(Core.visibleRange(3, 5000, 900))), {start:0,end:3});

for (const contract of [
  "naklios.files.onOpen",
  "naklios.files.read(grant.token)",
  "naklios.files.write(tab.token",
  "naklios.files.release(tab.token)",
  "naklios.fs.subscribe('',event",
  'naklios.beforeClose(()=>saveAll())',
  "naklios-editor-recovery",
  "Core.recoveryKey(activeLocation,path)",
  "Core.recoveryKey('grant'",
  "id='restore-recovery'".replaceAll("'", '"'),
  "id='discard-recovery'".replaceAll("'", '"'),
]) {
  assert.ok(html.includes(contract), `Editor implements ${contract}`);
}
assert.doesNotMatch(html, /\b(?:alert|confirm|prompt)\s*\(/, 'Editor uses styled in-app UI');
assert.match(html, /\.welcome\[hidden\]\{display:none\}/, 'the empty-workspace welcome yields to an open editor tab');
assert.match(html, /class="reader" id="reader" hidden/, 'Editor has a separate read-only viewer');
assert.match(html, /loadWorkingReview\(\{fs:rigFs,git,filepath:tab\.path\}\)/, 'Git review reads through the shared Rig-backed diff');
assert.doesNotMatch(files, /\b(?:alert|confirm|prompt)\s*\(/, 'Files uses styled in-app UI');
assert.match(files, /id="ctx-edit"[^>]*>Edit in Editor/);
// Whole-store mode passes editPath (the apps/files-relative path) to the
// namespaced Open-With handoff; namespaced mode passes it through unchanged.
assert.match(files, /naklios\.files\.openWith\('editor', editPath\)/);

assert.match(sdk, /files:\s*\{[\s\S]*?openWith:[\s\S]*?onOpen:[\s\S]*?read:[\s\S]*?write:[\s\S]*?release:/);
assert.match(sdk, /naklios:file:grant/);
assert.match(host, /const fileGrants = new Map\(\)/);
assert.match(host, /targetAppId !== 'editor'/);
assert.match(host, /grant\.targetSource !== source/);
assert.match(host, /fileGrantBackendIdentity\(grant\.backendId\) !== grant\.backendIdentity/);
assert.match(host, /Editor receives access to this file only/);
assert.match(host, /FILE_GRANT_MAX_CHARS = 2 \* 1024 \* 1024/);
assert.match(host, /releaseFileGrantsForSource\(iframe\.contentWindow\)/);

for (const phrase of [
  'explicit, one-file capability',
  'opaque token',
  'never receives Folder handles',
  'fails closed',
  'there is no silent import, copy, or migration',
]) assert.ok(spec.includes(phrase), `handoff spec documents: ${phrase}`);

console.log('NakliOS Editor recovery and exact-file handoff contract: PASS');
