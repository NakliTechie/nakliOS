// Projects in and out as zip files. A zip with one top folder loses it, and unsafe paths are refused.
import { unzipSync, zipSync } from '../vendor/fflate.js';

export function makeZip(files) {
  return zipSync(Object.fromEntries(files.map(({ path, bytes }) => [path, bytes])), { level:6 });
}

export function readZip(bytes) {
  const entries = Object.entries(unzipSync(bytes)).filter(([path]) => !path.endsWith('/') && !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(path));
  for (const [path] of entries) if (path.split('/').some(part => part === '..') || path.startsWith('/')) throw new Error(`The zip holds an unsafe path: ${path}`);
  const tops = new Set(entries.map(([path]) => path.split('/')[0]));
  const nested = entries.length && tops.size === 1 && entries.every(([path]) => path.includes('/'));
  return entries.map(([path, data]) => ({ path:nested ? path.slice(path.indexOf('/') + 1) : path, bytes:data }))
    .filter(file => !file.path.split('/').some(part => part.startsWith('.')));
}
