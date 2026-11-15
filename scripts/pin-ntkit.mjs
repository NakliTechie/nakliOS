#!/usr/bin/env node
// pin-ntkit.mjs — write sys/ai/ntkit-pin.json: the ntkit release NakliOS installs from Settings → Skills.
//
// Usage: node scripts/pin-ntkit.mjs <path-to-ntkit-checkout> <tag>
// Reads every file under skills/ at that tag with `git show`, so the checkout's working tree does not
// matter. Leaves out audio, files in dot folders (Sentinel refuses hidden paths), and skills that need a
// desktop media pipeline. Each skill also gets ntkit's LICENSE as LICENSE-ntkit (MIT asks for the notice
// with every copy). The host downloads each file from raw.githubusercontent.com at the pinned commit and
// refuses any whose SHA-256 differs.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const [repoDir, tag] = process.argv.slice(2);
if (!repoDir || !tag) { console.error('Usage: node scripts/pin-ntkit.mjs <ntkit-checkout> <tag>'); process.exit(2); }
const git = (...a) => execFileSync('git', ['-C', repoDir, ...a], { maxBuffer: 64 << 20 });
const commit = git('rev-list', '-n', '1', tag).toString().trim();
const LEAVE_OUT = { 'package-nt': 'promo video pipeline: about 1 MB of media, and a hidden .gitignore Sentinel refuses' };
const AUDIO = /\.(ogg|wav|mp3|m4a|flac)$/i;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const license = git('show', `${commit}:LICENSE`);
const skills = {};
for (const path of git('ls-tree', '-r', '--name-only', commit, 'skills').toString().trim().split('\n')) {
  const [, name, ...rest] = path.split('/');
  if (LEAVE_OUT[name] || AUDIO.test(path) || rest.some((seg) => seg.startsWith('.'))) continue;
  const bytes = git('show', `${commit}:${path}`);
  (skills[name] ||= []).push({ path, sha256: sha(bytes), bytes: bytes.length });
}
for (const name of Object.keys(skills)) skills[name].push({ path: 'LICENSE', as: 'LICENSE-ntkit', sha256: sha(license), bytes: license.length });
const pin = { id: 'ntkit', repo: 'NakliTechie/ntkit', tag, commit, license: 'MIT', leftOut: LEAVE_OUT, skills };
writeFileSync(new URL('../sys/ai/ntkit-pin.json', import.meta.url), JSON.stringify(pin, null, 1) + '\n');
const files = Object.values(skills).reduce((n, f) => n + f.length, 0);
console.log(`ntkit ${tag} (${commit.slice(0, 12)}): ${Object.keys(skills).length} skills, ${files} files`);
