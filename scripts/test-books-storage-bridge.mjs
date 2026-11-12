import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const booksEntry = html.match(/\{\s*id:'books'[\s\S]*?svg:`[\s\S]*?`\s*\},/);

assert.ok(booksEntry, 'Lorewell app entry exists under the stable books id');
assert.match(booksEntry[0], /name:'Lorewell'/, 'the launcher uses the Lorewell product name');
// Since 2026-11-12 Lorewell is a same-origin NakliOS mirror (lorewell.naklitechie.com is retired). It is not
// kind:'system', so it stays clamped to its own namespace; every app opens in a window since Basic mode retired.
assert.match(booksEntry[0], /url:'\.\/apps\/books\/'/, 'Lorewell opens from its NakliOS mirror');
assert.match(booksEntry[0], /embedUrl:'\.\/apps\/books\/'/, 'Lorewell embeds its NakliOS mirror');
assert.doesNotMatch(booksEntry[0], /kind:'system'|opensInNewTab/, 'Lorewell is an ordinary mirrored app that opens in a window');
assert.match(booksEntry[0], /Folder or Crate/, 'Lorewell launcher copy names both storage backends');
assert.match(html, /op === 'selectBackend'[\s\S]*fsHostSelectBackend/, 'host handles explicit app backend selection');
assert.match(html, /switching copies or deletes nothing/, 'host keeps backend switching non-destructive (scoped to apps/<id>/)');

console.log('NakliOS ↔ Lorewell storage bridge contract: PASS');
