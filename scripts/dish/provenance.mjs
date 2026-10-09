import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.env.DISH_OUTPUT_ROOT;
const files = {};
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name !== 'upstream.lock.json') {
      const bytes = fs.readFileSync(full);
      files[path.relative(root, full)] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    }
  }
}
walk(root);
fs.writeFileSync(path.join(root, 'upstream.lock.json'), JSON.stringify({ repository: 'https://github.com/deepseek-ai/deepseek-harness', tag: 'dsh-v0.2.1-alpha.1', commit: '5badb15009ae1756c3afe0ae0cef1faafc290ccc', files }, null, 2)+'\n');
