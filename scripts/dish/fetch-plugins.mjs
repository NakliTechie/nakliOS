// Download every plugin in plugins.json, refuse any tarball whose integrity differs from the pin,
// and extract it into the upstream tree's node_modules so pack.mjs resolves it like any package.
// Usage: node scripts/dish/fetch-plugins.mjs /path/to/extracted-upstream
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/dish/fetch-plugins.mjs /path/to/extracted-upstream');
const { plugins } = JSON.parse(fs.readFileSync(new URL('./plugins.json', import.meta.url), 'utf8'));
for (const plugin of plugins) {
  const response = await fetch(plugin.tarball);
  if (!response.ok) throw new Error(`${plugin.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const [algorithm, expected] = plugin.integrity.split('-');
  const actual = crypto.createHash(algorithm).update(bytes).digest('base64');
  if (actual !== expected) throw new Error(`${plugin.name}@${plugin.version}: integrity mismatch, refusing`);
  const target = path.join(source, 'node_modules', plugin.name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  const archive = `${target}.tgz`;
  fs.writeFileSync(archive, bytes);
  execFileSync('tar', ['-xzf', archive, '-C', target, '--strip-components=1']);
  fs.rmSync(archive);
  const manifest = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  if (manifest.name !== plugin.name || manifest.version !== plugin.version) throw new Error(`${plugin.name}: tarball says ${manifest.name}@${manifest.version}`);
  console.log(`${plugin.name}@${plugin.version} verified`);
}
