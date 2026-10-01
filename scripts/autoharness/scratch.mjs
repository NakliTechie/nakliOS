// A scratch copy of this repo for the round and loop lanes: sys/, scripts/, verify/, vendor/,
// apps/anvil/, .gitignore and the workflow, from the WORKING TREE, committed on a non-main branch.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export function scratchRepo(prefix = 'ah-scratch-') {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
  const TMP = mkdtempSync(join(tmpdir(), prefix));
  const REPO = join(TMP, 'repo');
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
    .filter((p) => p && (/^(sys|scripts|verify|vendor)\//.test(p) || p.startsWith('apps/anvil/') || p === '.gitignore' || p === '.github/workflows/test.yml'));
  for (const p of listed) { if (!existsSync(join(ROOT, p))) continue; mkdirSync(dirname(join(REPO, p)), { recursive: true }); copyFileSync(join(ROOT, p), join(REPO, p)); }
  const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
  git('add', '-A'); git('commit', '-q', '-m', 'scratch'); git('checkout', '-q', '-b', 'autoharness/test');
  return { TMP, REPO, git };
}
