// test-dish-library-skills.mjs — Dish mounts NakliOS library skills as dsh-native folders: SKILL.md plus
// the support files the host returned, read-only, with parent folders created and unsafe paths dropped.
import assert from 'node:assert/strict';
import { loadLibrarySkills, LIBRARY_SKILLS_DIR } from '../apps/dish/host.mjs';

const lib = {
  kit: { name: 'kit', description: 'Has  helpers', status: 'active', body: 'Read references/steps.md.', files: [
    { path: 'references/steps.md', content: 'Step one.\n' },
    { path: 'bin/go.py', content: 'print(1)\n' },
    { path: '../escape.md', content: 'no' },
  ] },
  plain: { name: 'plain', description: 'Body only', status: 'active', body: 'Just text.' },
  bad: { name: 'bad', blocked: 'Sentinel: refused' },
};
const sdk = { experimental_skills: { list: async () => Object.values(lib).map(({ name }) => ({ name })), read: async (n) => lib[n] || null } };
const out = await loadLibrarySkills(sdk);
const byPath = new Map(out.map((e) => [e.path, e]));
const text = (p) => new TextDecoder().decode(new Uint8Array(byPath.get(p).bytes));
const root = `${LIBRARY_SKILLS_DIR}/kit`;
assert.match(text(`${root}/SKILL.md`), /^---\nname: kit\ndescription: Has helpers\n---\nRead references\/steps\.md\.\n$/);
assert.equal(text(`${root}/references/steps.md`), 'Step one.\n', 'a reference file is mounted');
assert.ok(byPath.get(`${root}/references`).directory && byPath.get(`${root}/bin`).directory, 'parent folders are created');
assert.equal(byPath.get(`${root}/bin/go.py`).mode, 0o555, 'scripts are executable and read-only');
assert.equal(byPath.get(`${root}/references/steps.md`).mode, 0o444, 'other files are read-only');
assert.ok(![...byPath.keys()].some((p) => p.includes('escape')), 'a path that leaves the folder is dropped');
assert.ok(byPath.has(`${LIBRARY_SKILLS_DIR}/plain/SKILL.md`), 'a skill with no files still mounts');
assert.ok(![...byPath.keys()].some((p) => p.includes('/bad')), 'a blocked skill is not mounted');
console.log('dish library skills: SKILL.md and support files mount read-only; unsafe paths and blocked skills stay out');
