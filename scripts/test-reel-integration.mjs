import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [host, mirror, manifest, harness] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/reel/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../apps/manifest.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../test/reel-host-harness.html', import.meta.url), 'utf8'),
]);

const declared = manifest.apps.find(app => app.id === 'reel');
assert.ok(declared, 'Reel mirror is declared');
assert.equal(declared.repo, 'NakliTechie/reel', 'Reel mirror points to its authoritative repository');
assert.equal(declared.files.length, 3, 'Reel mirror declares the app, decoder runtime, and decoder license');
// Same-origin embed, either spelling: `./apps/<id>/` and `https://naklios.dev/apps/<id>/` both
// resolve to /apps/<id>/. Relative is the house default because it is what makes a mirrored app
// verifiable on a LOCAL serve before deploy (plan/history.md 2026-09-09, 2026-09-10).
assert.match(host, /id:'reel'[\s\S]*?url:'https:\/\/reel\.naklitechie\.com\/'/, 'Reel keeps its canonical host');
const reelEmbed = host.match(/id:'reel'[\s\S]*?embedUrl:'([^']+)'/);
assert.ok(reelEmbed && ['./apps/reel/', 'https://naklios.dev/apps/reel/'].includes(reelEmbed[1]),
  `Reel uses a same-origin Immersive mirror (got ${reelEmbed && reelEmbed[1]})`);
assert.match(mirror, /script\.src = '\/sdk\/naklios\.js'/, 'Reel mirror loads the same-origin NakliOS SDK');
assert.match(mirror, /const LIBRARY_PATH = 'library\.json'/, 'Reel scopes hosted writes to its metadata library');
assert.match(mirror, /Media bytes never cross this boundary/, 'Reel documents the hosted media-byte boundary');
assert.match(harness, /Crate metadata escaped library\.json/, 'Browser harness rejects path expansion');
assert.match(harness, /Crate library included media payload fields/, 'Browser harness rejects media payloads');
assert.match(harness, /Switching from Crate copied metadata into Browser storage/, 'Browser harness enforces separate libraries');

console.log('NakliOS ↔ Reel mirror and Crate metadata contract: PASS');
