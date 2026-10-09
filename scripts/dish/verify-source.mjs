import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const source = process.argv[2];
const lock = JSON.parse(fs.readFileSync(new URL('./source.lock.json', import.meta.url)));
for (const [name, digest] of Object.entries(lock.files)) {
  const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex');
  if (actual !== digest) throw new Error(`Upstream source differs from pinned commit: ${name}`);
}
console.log(`Verified upstream source inputs at ${lock.commit}`);
