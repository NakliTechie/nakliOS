// Builds the store package of the NakliOS Browser extension into a folder: the extension's files with
// manifest.store.json as manifest.json (no localhost, no 127.0.0.1, no http:// sites). Zip that folder for
// the Chrome Web Store; publishing is the owner's step.
//
//   node scripts/build-browser-extension.mjs <out-dir>
import { readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const out = process.argv[2];
if (!out) { console.error('usage: node scripts/build-browser-extension.mjs <out-dir>'); process.exit(64); }
const src = new URL('../extension/', import.meta.url);
const SKIP = new Set(['manifest.json', 'manifest.store.json', 'README.md', 'STORE-LISTING.md']);
await mkdir(out, { recursive: true });
for (const name of await readdir(src)) if (!SKIP.has(name)) await copyFile(new URL(name, src), join(out, name));
const manifest = JSON.parse(await readFile(new URL('manifest.store.json', src), 'utf8'));
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`store build of ${manifest.name} ${manifest.version} written to ${out}`);
