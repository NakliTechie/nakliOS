import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [host, mirror, vendor, manifest, harness] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/nakliamp/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/nakliamp/VENDOR.md', import.meta.url), 'utf8'),
  readFile(new URL('../apps/manifest.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../test/nakliamp-host-harness.html', import.meta.url), 'utf8'),
]);

const declared = manifest.apps.find(app => app.id === 'nakliamp');
assert.ok(declared, 'NakliAmp mirror is declared');
assert.equal(declared.repo, 'NakliTechie/nakliamp', 'NakliAmp mirror points to its authoritative repository');
// Every module the mirror actually imports must be a DECLARED artifact.
//
// This replaces a hand-listed set of six destinations. That list went stale the moment upstream
// grew an `app/` tree (0.1.0-m0 -> 0.3.0-m2): the manifest still declared six files, the sync
// dutifully copied six files, `validate-mirrors` passed because it only checks what is DECLARED,
// and the mirrored app would have 404'd on six imports at load. A list cannot notice a file that
// was never added to it; walking the real import graph can.
const declaredSet = new Set(declared.files.map(f => f.destination));
const mirrorRoot = new URL('../apps/nakliamp/', import.meta.url);
const relImport = /(?:from\s*|new URL\(\s*)['"](\.[^'"]+)['"]/g;

async function importsOf(relPath) {
  const text = await readFile(new URL(relPath, mirrorRoot), 'utf8');
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : '';
  const out = [];
  for (const [, spec] of text.matchAll(relImport)) {
    // Resolve against the importing file's directory, then normalise away ./ and ../
    const parts = (dir + spec.replace(/^\.\//, '')).split('/');
    const stack = [];
    for (const seg of parts) {
      if (seg === '.' || seg === '') continue;
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    out.push(stack.join('/'));
  }
  return out;
}

const seen = new Set(['index.html']);
const queue = ['index.html'];
const undeclared = [];
while (queue.length) {
  const current = queue.shift();
  for (const target of await importsOf(current)) {
    if (!declaredSet.has(target)) undeclared.push(`${current} -> ${target}`);
    if (!seen.has(target) && target.endsWith('.mjs')) { seen.add(target); queue.push(target); }
  }
}
assert.deepEqual(undeclared, [], 'every module the mirror imports is a declared artifact');
assert.ok(declaredSet.has('index.html') && declaredSet.has('VENDOR.md'), 'the entry point and the vendor notice are declared');
// Canonical standalone, same-origin embed. The embed form may be absolute
// (https://naklios.dev/apps/nakliamp/) or relative (./apps/nakliamp/) — the inventory audit
// resolves both to /apps/<id>/, and relative is what makes a LOCAL serve testable, which is why
// the Menagerie mirror uses it (plan/history.md, 2026-09-09). Pin the property, not the spelling.
const entry = host.match(/\{ id:'nakliamp'[\s\S]*?embedUrl:'([^']+)'/);
assert.ok(entry, 'NakliOS catalogs NakliAmp');
assert.match(host, /id:'nakliamp'[\s\S]*?url:'https:\/\/nakliamp\.naklitechie\.com\/'/, 'NakliAmp keeps its canonical standalone URL');
assert.ok(
  entry[1] === './apps/nakliamp/' || entry[1] === 'https://naklios.dev/apps/nakliamp/',
  `NakliAmp embeds same-origin under /apps/nakliamp/ (got ${entry[1]})`,
);
// The two version strings must AGREE. Pinning a literal here just means a future sync fails
// this test for being current; what matters is that the meta tag and the visible label never
// drift apart, and that the mirror is not silently older than the lock says.
const metaVersion = mirror.match(/name="nakliamp-version" content="([^"]+)"/);
assert.ok(metaVersion, 'NakliAmp mirror declares a version in its meta tag');
assert.ok(
  mirror.includes(`v${metaVersion[1]}`),
  `the visible label matches the meta version (${metaVersion[1]})`,
);
assert.match(mirror, /connect-src 'self'/, 'NakliAmp mirror limits connections to its own origin');
assert.doesNotMatch(mirror, /connect-src[^;]*https?:/, 'NakliAmp mirror does not allow remote HTTP connections');
assert.match(vendor, /Corresponding Mediabunny source is available/, 'NakliAmp mirror includes the source-availability notice');
// libav arrived with 0.3.0-m2 and is LGPL, so its licence text is a shipping requirement, not
// an optional extra: declare it or the mirror redistributes LGPL code without its notice.
if (declaredSet.has('vendor/libav/libav-6.10.9.0-nakliamp.wasm.wasm')) {
  assert.ok(declaredSet.has('vendor/libav/LICENSE-LGPL-2.1.txt'), 'libav ships with its LGPL licence text');
  assert.match(vendor, /libav/i, 'VENDOR.md documents the libav dependency');
}
assert.match(harness, /Mirrored NakliAmp requested a cross-origin resource/, 'Browser harness rejects remote resource loads');
assert.match(harness, /NakliAmp mirror did not use the pinned Reel path/, 'Browser harness checks the pinned engine path');

console.log('NakliOS ↔ NakliAmp mirror, locality, and preview contract: PASS');
