// Pin Dish to one upstream tag: rewrite source.lock.json from that tag's release archive.
// Usage: node scripts/dish/pin.mjs dsh-v0.2.1-rc.4
// Then run scripts/dish/fetch-source.sh and build-dish.sh; the integration patches may need porting to the new tag.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const tag = process.argv[2];
if (!tag) throw new Error('Usage: node scripts/dish/pin.mjs <upstream tag>');
const repo = 'deepseek-ai/deepseek-harness';
const file = new URL('./source.lock.json', import.meta.url);
const lock = JSON.parse(fs.readFileSync(file));
const ref = await (await fetch(`https://api.github.com/repos/${repo}/commits/${tag}`, { headers: { accept: 'application/vnd.github.sha' } })).text();
if (!/^[0-9a-f]{40}$/.test(ref)) throw new Error(`No commit for ${tag}: ${ref.slice(0, 200)}`);
const response = await fetch(`https://github.com/${repo}/archive/refs/tags/${tag}.tar.gz`);
if (!response.ok) throw new Error(`Archive download failed with ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const prefix = `deepseek-harness-${tag}/`;
const files = {};
for (const name of Object.keys(lock.files)) {
  files[name] = sha(execFileSync('tar', ['-xzOf', '-', prefix + name], { input: archive, maxBuffer: 256 * 1024 * 1024 }));
  if (files[name] !== lock.files[name]) console.log(`changed: ${name}`);
}
fs.writeFileSync(file, JSON.stringify({ tag, commit: ref, archiveSha256: sha(archive), files }, null, 2) + '\n');
console.log(`Pinned ${tag} at ${ref}`);
