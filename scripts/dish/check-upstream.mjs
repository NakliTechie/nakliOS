// Report the newest non-alpha upstream tag newer than Dish's pin, or nothing.
// Usage: node scripts/dish/check-upstream.mjs   (GITHUB_TOKEN optional, raises the API rate limit)
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

// dsh-vX.Y.Z or dsh-vX.Y.Z-rc.N; alpha and every other suffix are not tracked.
const TRACKED = /^dsh-v(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;
function rank(tag) {
  const m = TRACKED.exec(tag);
  // A final release sorts after every rc of the same version.
  return m && [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]];
}
function compare(a, b) {
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}
export function newerTrackedTag(tags, pinned) {
  const base = rank(pinned);
  if (!base) throw new Error(`Pinned tag is not an rc or final release: ${pinned}`);
  const newer = tags.filter(tag => rank(tag) && compare(rank(tag), base) > 0);
  return newer.sort((a, b) => compare(rank(b), rank(a)))[0];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pinned = JSON.parse(fs.readFileSync(new URL('../../apps/dish/upstream.lock.json', import.meta.url))).tag;
  const headers = { accept: 'application/vnd.github+json', ...process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {} };
  const tags = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(`https://api.github.com/repos/deepseek-ai/deepseek-harness/tags?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`Tag listing failed with ${response.status}`);
    const batch = await response.json();
    tags.push(...batch.map(tag => tag.name));
    if (batch.length < 100) break;
  }
  const newer = newerTrackedTag(tags, pinned);
  if (newer) console.log(newer);
}
