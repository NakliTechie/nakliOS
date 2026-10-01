// The autoharness task battery: { id, split, family, seed, prompt, gate, solve } per task.
//
//   seed   files the workspace starts with (path → text)
//   prompt the owner's ask; `carry` / `after` hold carried turns before it and [coordination] turns after it
//   gate   ({ file, files, seed, changed, answer, metrics, stop }) → { ok, why } over the FINISHED run.
//          `metrics` is null when a `gated` task's gate runs inside the loop. A `why` never names the
//          expected answer: on a gated task the loop shows it to the model.
//   solve  a known-good script of tool calls (scripts/autoharness/bed.mjs scriptedInfer); the battery
//          test runs it through the real assembly and requires the gate to pass, and requires the gate
//          to FAIL on the untouched seed and on an empty workspace.
//
// Splits are fixed (re-cut once on 2026-10-01, before any optimizer round, when the hard tier landed).
// Dev and test each hold the six battery cases of two asks (all three task states of an ask share a
// split, so an edit tuned on train never sees its dev twin), one guard per base family, and a third of
// the hard tier dealt per family by its calibrated pass rate (plan/bench-autoharness-2026-10-01.md), so
// the two match in difficulty. The base tier's ceiling tasks are train: in dev they cost runs and
// carried no signal. Sources: scripts/bench-procedural.mjs (3), scripts/anvil-simple-battery.browser.js
// (6 asks × 3 states), 45 base tasks written for this battery, and the hard tier (battery-hard.mjs,
// battery-build.mjs). Every task is solvable with the file tools, the curated shell and `node`, so a bed
// without python (CI's) can score every one. A task marked `pythonRef` has a reference that runs
// `python -c`: it is checked to pass in a bed with python (AUTOHARNESS_PYODIDE, python.mjs) and to fail
// in one without it.
import { recoveryNote } from '../../sys/history/run-record.mjs';
import { all, ok, no, onlyChanged, fileEq, absent, answerHas, stepsAtMost, noTools, answerFile, jsGate, sh, read, write, edit, say, done } from './gates.mjs';
import { HARD_TASKS } from './battery-hard.mjs';
import { BUILD_TASKS } from './battery-build.mjs';

// ── the simple-task battery (scripts/anvil-simple-battery.browser.js), ported to the node bed ─────
// States: fresh (a new task); finished (a prior ask ran to done in the same task — its exchange is
// carried, notes.md exists); errored (that ask was stopped before it changed anything — the app's
// carry drops it, commit 02bf8a6, and only the recovery note names it). The recovery note is the
// real recoveryNote() over the prior run's shape, placed after the ask as the app places it.
const SEED = 'alpha\nbeta\n';
const PRIOR = 'create notes.md with a heading "Notes" and three bullet points about Python';
const NOTES = '# Notes\n\n- Python is dynamically typed.\n- Indentation defines blocks.\n- The standard library is large.\n';
const recovery = (endedAfter) => ({ role: 'user', content: '[coordination] ' + recoveryNote({ ownerInputs: [{ text: PRIOR, resolution: 'open', endedAfter }], coordinationCount: 0, checkpoint: null, orphanedSubagents: [] }) });
const STATES = {
  fresh: { seed: { 'seed.txt': SEED }, carry: [], after: [] },
  finished: {
    seed: { 'seed.txt': SEED, 'notes.md': NOTES },
    carry: [
      { role: 'user', content: PRIOR },
      { role: 'assistant', content: null, tool_calls: [{ id: 'prior_1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'notes.md', content: NOTES }) } }] },
      { role: 'tool', tool_call_id: 'prior_1', content: `Wrote notes.md (${NOTES.length} bytes)` },
      { role: 'assistant', content: 'Created notes.md with a "Notes" heading and three bullet points about Python.' },
    ],
    after: [recovery('done')],
  },
  errored: { seed: { 'seed.txt': SEED }, carry: [], after: [recovery('aborted')] },
};
// The bar (plan/bench-simple-battery-2026-09-24.md): fresh ≤ 2 steps and no write outside the ask;
// finished/errored, no write outside the ask. Each ask also has to be RIGHT here — the browser
// battery read steps and writes only, so an empty run passed `list`.
const ASKS = [
  { ask: 'list', split: 'dev', text: 'list the files here', allowed: [],
    right: (state) => (state === 'finished' ? all(answerHas(/seed\.txt/, 'seed.txt'), answerHas(/notes\.md/, 'notes.md')) : answerHas(/seed\.txt/, 'seed.txt')),
    solve: (state) => [sh('ls'), say(state === 'finished' ? 'notes.md, seed.txt' : 'seed.txt')] },
  { ask: 'write', split: 'train', text: 'write hi.txt containing hi', allowed: ['hi.txt'],
    right: () => fileEq('hi.txt', 'hi'), solve: () => [write('hi.txt', 'hi\n'), say('Wrote hi.txt.')] },
  { ask: 'read', split: 'test', text: 'what is the first line of seed.txt?', allowed: [],
    right: () => answerHas(/\balpha\b/, 'the first line'), solve: () => [sh('head -n 1 seed.txt'), say('alpha')] },
  { ask: 'answer', split: 'test', text: 'what is 17 times 23? answer without using any tools', allowed: [],
    right: () => all(answerHas(/\b391\b/, 'the product'), noTools), solve: () => [say('391')] },
  { ask: 'rename', split: 'train', text: 'rename seed.txt to seed2.txt', allowed: ['seed.txt', 'seed2.txt'],
    right: () => all(fileEq('seed2.txt', SEED, { trim: false }), absent('seed.txt')), solve: () => [sh('mv seed.txt seed2.txt'), say('Renamed.')] },
  { ask: 'edit', split: 'dev', text: 'in seed.txt, change beta to gamma', allowed: ['seed.txt'],
    right: () => fileEq('seed.txt', 'alpha\ngamma\n', { trim: false }), solve: () => [edit('seed.txt', 'beta', 'gamma'), say('Changed beta to gamma.')] },
];
const batteryTasks = ASKS.flatMap((a) => Object.entries(STATES).map(([state, s]) => ({
  id: `battery-${a.ask}-${state}`, family: 'battery', split: a.split,
  seed: s.seed, carry: s.carry, after: s.after, prompt: a.text,
  gate: all(a.right(state), onlyChanged(a.allowed), ...(state === 'fresh' ? [stepsAtMost(2)] : [])),
  solve: a.solve(state),
})));

// ── generated seeds (deterministic) ────────────────────────────────────────────────────────────
const LOG37 = Array.from({ length: 37 }, (_, i) => `2026-09-30T10:${String(i).padStart(2, '0')}:00 INFO request ${i + 1} ok`).join('\n') + '\n';
const APPLOG = Array.from({ length: 50 }, (_, i) => (i === 30 ? '10:30 FATAL database connection lost' : `10:${String(i).padStart(2, '0')} ${i % 7 === 3 ? 'WARN' : 'INFO'} tick ${i}`)).join('\n') + '\n';
const SALES = [['id', 'item', 'amount'], [1, 'pen', 12.5], [2, 'book', 40], [3, 'lamp', 23.75], [4, 'mug', 8], [5, 'desk', 150], [6, 'chair', 85.25], [7, 'pen', 12.5]];
const SALES_CSV = SALES.map((r) => r.join(',')).join('\n') + '\n';
const SALES_SUM = SALES.slice(1).reduce((s, r) => s + r[2], 0); // 332
const USERS = [['name', 'country'], ['asha', 'IN'], ['ben', 'US'], ['chen', 'CN'], ['devi', 'IN'], ['emil', 'DE'], ['farah', 'IN'], ['gopal', 'IN'], ['hana', 'JP'], ['ines', 'BR'], ['jai', 'IN']];
const USERS_CSV = USERS.map((r) => r.join(',')).join('\n') + '\n';
const USERS_IN = USERS.slice(1).filter((r) => r[1] === 'IN').length; // 5
const WORDS = ['apple', 'pear', 'fig', 'apple', 'kiwi', 'plum', 'fig', 'pear', 'lime', 'apple', 'date', 'kiwi', 'lime', 'plum', 'fig', 'grape', 'date', 'apple', 'mango', 'pear'];
const WORDS_UNIQ = new Set(WORDS).size; // 9
const TEMPS = [21.5, -3, 38.5, 12, 0, 37.9, 25.25, -11.5, 30];
const NAMES = ['mira', 'arjun', 'zoe', 'liam', 'bea', 'omar', 'kai', 'dev'];
const EMAILS = ['a@x.io', 'b@x.io', 'a@x.io', 'c@x.io', 'b@x.io', 'd@x.io', 'a@x.io', 'e@x.io'];
const PEOPLE_CSV = 'name,email,team\nmira,mira@acme.dev,core\narjun,arjun@acme.dev,web\nzoe,zoe@acme.dev,core\nliam,liam@acme.dev,ops\n';
const KV = 'host=db.local\nport=5432\nuser=admin\nmode=readonly\n';
const USERS_JSON = JSON.stringify([{ name: 'mira', active: true }, { name: 'arjun', active: false }, { name: 'zoe', active: true }, { name: 'liam', active: true }, { name: 'bea', active: false }], null, 2) + '\n';
const POEM = 'roses are red\nviolets are blue\nsugar is sweet\nand so are you\n';
const LIST = 'milk\neggs\nbread\nbutter\n';

// ── bench-procedural's three tasks (gated: the loop runs the gate on task_done) ─────────────────
const proceduralTasks = [
  { id: 'proc-edit-in-place', family: 'procedural', split: 'dev', gated: true,
    seed: { 'config.txt': 'name = anvil\nport = 8080\ndebug = false\nowner = chirag\n' },
    prompt: 'The file config.txt exists. Change the port to 9090. Every other line must be left exactly as it is.',
    gate: all(fileEq('config.txt', 'name = anvil\nport = 9090\ndebug = false\nowner = chirag\n', { trim: false }), onlyChanged(['config.txt'])),
    solve: [edit('config.txt', 'port = 8080', 'port = 9090'), done('changed the port')] },
  { id: 'proc-count-matches', family: 'procedural', split: 'test', gated: true,
    seed: { 'a.py': 'def solve():\n    pass\n', 'b.py': 'x = 1\n', 'c.py': 'def solve(n):\n    return n\n' },
    prompt: 'How many .py files in this directory contain the text "def solve"? Write just that number into answer.txt and nothing else.',
    gate: all((c) => { const t = c.file('answer.txt'); return t !== null && t.trim() === '2' ? ok() : no('answer.txt does not hold the correct count'); }, onlyChanged(['answer.txt'])),
    solve: [sh('grep -l "def solve" *.py | wc -l'), write('answer.txt', '2\n'), done('wrote 2')] },
  { id: 'proc-control-new-file', family: 'procedural', split: 'train', gated: true, seed: {},
    prompt: 'Create a file called hello.txt containing exactly the word hello.',
    gate: all(fileEq('hello.txt', 'hello'), onlyChanged(['hello.txt'])),
    solve: [write('hello.txt', 'hello'), done('wrote hello.txt')] },
];

// ── surgical edits ─────────────────────────────────────────────────────────────────────────────
const PKG = '{\n  "name": "demo",\n  "version": "1.4.2",\n  "private": true,\n  "scripts": {\n    "test": "node test.js"\n  }\n}\n';
const INI = '[server]\nhost = 0.0.0.0\n# cache = on\nworkers = 4\n';
const STORY = 'The colour of the sky changed. Her favourite colour was blue.\nNo colour lasts forever, she said, every colour fades.\n';
const HOSTS = '10.0.0.1 web.internal\n10.0.0.2 db.internal\n10.0.0.3 staging.internal\n10.0.0.4 cache.internal\n';
const CHANGELOG = '# Changelog\n\n## Unreleased\n\n- Add dark mode\n\n## 1.2.0\n\n- Initial release\n';
const UTILS_CALC = 'export function calc(items) {\n  return items.reduce((s, x) => s + x, 0);\n}\n\nexport function report(items) {\n  return "total: " + calc(items);\n}\n\nexport function double(items) {\n  return calc(items) * 2;\n}\n';
const README_TYPO = '# Inbox\n\nYou will recieve an email when a message arrives.\nKeep work and personal mail seperate.\nUsers who recieve too much mail can filter it.\n';
const YAML = 'web:\n  image: app:1.0\n  replicas: 2\nworker:\n  image: app:1.0\n  replicas: 2\n';
const ENV = 'DATABASE_URL=postgres://localhost/app\nPORT=3000\n';
const editTasks = [
  { id: 'edit-json-version', split: 'train', seed: { 'package.json': PKG },
    prompt: 'Bump the patch version in package.json (1.4.2 → 1.4.3). Change nothing else.',
    gate: all(fileEq('package.json', PKG.replace('1.4.2', '1.4.3'), { trim: false }), onlyChanged(['package.json'])),
    solve: [edit('package.json', '"version": "1.4.2"', '"version": "1.4.3"'), say('Bumped to 1.4.3.')] },
  { id: 'edit-uncomment', split: 'train', seed: { 'settings.ini': INI },
    prompt: 'In settings.ini, enable the cache setting by uncommenting it. Leave the other lines as they are.',
    gate: all(fileEq('settings.ini', INI.replace('# cache = on', 'cache = on'), { trim: false }), onlyChanged(['settings.ini'])),
    solve: [edit('settings.ini', '# cache = on', 'cache = on'), say('Uncommented cache.')] },
  { id: 'edit-replace-all', split: 'test', seed: { 'story.txt': STORY },
    prompt: 'Change the British spelling "colour" to the American "color" everywhere in story.txt.',
    gate: all(fileEq('story.txt', STORY.replaceAll('colour', 'color'), { trim: false }), onlyChanged(['story.txt'])),
    solve: [read('story.txt'), edit('story.txt', 'colour', 'color', { replace_all: true }), say('Replaced every colour.')] },
  { id: 'edit-delete-line', split: 'train', seed: { 'hosts.txt': HOSTS },
    prompt: 'Remove the staging entry from hosts.txt. Keep every other line in its order.',
    gate: all(fileEq('hosts.txt', HOSTS.replace('10.0.0.3 staging.internal\n', ''), { trim: false }), onlyChanged(['hosts.txt'])),
    solve: [edit('hosts.txt', '10.0.0.3 staging.internal\n', ''), say('Removed the staging line.')] },
  { id: 'edit-insert-under-heading', split: 'dev', seed: { 'CHANGELOG.md': CHANGELOG },
    prompt: 'Add "- Fix login timeout" to CHANGELOG.md as the first bullet under the Unreleased heading.',
    gate: all(fileEq('CHANGELOG.md', CHANGELOG.replace('## Unreleased\n\n- Add dark mode', '## Unreleased\n\n- Fix login timeout\n- Add dark mode')), onlyChanged(['CHANGELOG.md'])),
    solve: [edit('CHANGELOG.md', '## Unreleased\n\n- Add dark mode', '## Unreleased\n\n- Fix login timeout\n- Add dark mode'), say('Added the bullet.')] },
  { id: 'edit-rename-function', split: 'train', seed: { 'utils.js': UTILS_CALC },
    prompt: 'In utils.js, rename the function calc to calculateTotal, including every place it is called.',
    gate: all((c) => { const t = c.file('utils.js') || ''; return /\bcalc\b/.test(t) ? no('utils.js still names calc') : ok(); },
      jsGate('utils.js', [['calculateTotal', [[1, 2, 3]], 6], ['report', [[2, 3]], 'total: 5'], ['double', [[4]], 8]]), onlyChanged(['utils.js'])),
    solve: [read('utils.js'), edit('utils.js', 'calc', 'calculateTotal', { replace_all: true }), say('Renamed calc to calculateTotal.')] },
  { id: 'edit-fix-typos', split: 'train', seed: { 'README.md': README_TYPO },
    prompt: 'Fix the spelling mistakes in README.md.',
    gate: all(fileEq('README.md', README_TYPO.replaceAll('recieve', 'receive').replace('seperate', 'separate')), onlyChanged(['README.md'])),
    solve: [write('README.md', README_TYPO.replaceAll('recieve', 'receive').replace('seperate', 'separate')), say('Fixed recieve and seperate.')] },
  { id: 'edit-yaml-scoped', split: 'train', seed: { 'config.yaml': YAML },
    prompt: 'Scale the web service in config.yaml to 3 replicas. The worker service must stay at 2.',
    gate: all(fileEq('config.yaml', 'web:\n  image: app:1.0\n  replicas: 3\nworker:\n  image: app:1.0\n  replicas: 2\n', { trim: false }), onlyChanged(['config.yaml'])),
    solve: [edit('config.yaml', 'web:\n  image: app:1.0\n  replicas: 2', 'web:\n  image: app:1.0\n  replicas: 3'), say('web is at 3 replicas.')] },
  { id: 'edit-env-append', split: 'train', seed: { '.env': ENV },
    prompt: 'Add LOG_LEVEL=debug to the .env file, keeping the existing variables.',
    gate: all((c) => { const t = c.file('.env'); if (t === null) return no('.env does not exist'); const lines = t.split('\n').map((l) => l.trim()).filter(Boolean); return lines.includes('LOG_LEVEL=debug') && lines.includes('DATABASE_URL=postgres://localhost/app') && lines.includes('PORT=3000') && lines.length === 3 ? ok() : no('.env does not hold exactly the old variables plus LOG_LEVEL=debug'); }, onlyChanged(['.env'])),
    solve: [sh('echo LOG_LEVEL=debug >> .env'), say('Added LOG_LEVEL=debug.')] },
].map((t) => ({ family: 'edit', ...t }));

// ── multi-file work ────────────────────────────────────────────────────────────────────────────
const MF_A = "import { getUser } from './api.js';\nexport const show = (id) => getUser(id).name;\n";
const MF_API = "export function getUser(id) {\n  return { id, name: 'user' + id };\n}\nexport function getUserName(id) {\n  return getUser(id).name;\n}\n";
const MF_B = "import { getUser } from './api.js';\nexport const exists = (id) => !!getUser(id);\n";
const MF_C = "import { getUserName } from './api.js';\nexport const label = (id) => 'name: ' + getUserName(id);\n";
const multiTasks = [
  { id: 'multi-rename-across', split: 'dev', seed: { 'src/a.js': MF_A, 'src/api.js': MF_API, 'src/b.js': MF_B, 'src/c.js': MF_C },
    prompt: 'Rename the function getUser to fetchUser across the src/ folder. Do not rename getUserName.',
    gate: all((c) => {
      const files = ['src/a.js', 'src/api.js', 'src/b.js', 'src/c.js'].map((p) => c.file(p) || '');
      if (files.some((t) => /\bgetUser\b/.test(t))) return no('getUser is still referenced');
      if (!/\bfetchUser\b/.test(files[1]) || !/getUserName/.test(files[1]) || !/getUserName/.test(files[3])) return no('fetchUser is not defined, or getUserName was renamed');
      return (files[0].match(/\bfetchUser\b/g) || []).length === 2 && (files[2].match(/\bfetchUser\b/g) || []).length === 2 ? ok() : no('a call site was not renamed');
    }, onlyChanged(['src/a.js', 'src/api.js', 'src/b.js'])),
    solve: [sh("sed -i 's/getUser(/fetchUser(/g; s/{ getUser }/{ fetchUser }/g; s/function getUser(/function fetchUser(/g' src/a.js src/b.js src/api.js"), say('Renamed getUser to fetchUser.')] },
  { id: 'multi-move-module', split: 'test', seed: { 'helpers.js': 'export const twice = (x) => x * 2;\n', 'main.js': "import { twice } from './helpers.js';\nconsole.log(twice(21));\n" },
    prompt: 'Move helpers.js into a lib/ directory and update the import in main.js so it still works.',
    gate: all(absent('helpers.js'), fileEq('lib/helpers.js', 'export const twice = (x) => x * 2;'), (c) => (/from\s+['"]\.\/lib\/helpers\.js['"]/.test(c.file('main.js') || '') ? ok() : no('main.js does not import ./lib/helpers.js')), onlyChanged(['helpers.js', 'lib/helpers.js', 'main.js'])),
    solve: [sh('mkdir lib && mv helpers.js lib/helpers.js'), edit('main.js', "'./helpers.js'", "'./lib/helpers.js'"), say('Moved and updated the import.')] },
  { id: 'multi-split-sections', split: 'train', seed: { 'notes.txt': '[todo]\nwrite tests\nship v2\n[done]\nset up CI\nfix login\n' },
    prompt: 'notes.txt has a [todo] section and a [done] section. Put the todo items in todo.txt and the done items in done.txt, one per line, without the section headers. Leave notes.txt as it is.',
    gate: all(fileEq('todo.txt', 'write tests\nship v2'), fileEq('done.txt', 'set up CI\nfix login'), onlyChanged(['todo.txt', 'done.txt'])),
    solve: [write('todo.txt', 'write tests\nship v2\n'), write('done.txt', 'set up CI\nfix login\n'), say('Split.')] },
  { id: 'multi-delete-tmp', split: 'train', seed: { 'keep.txt': 'keep\n', 'a.tmp': 'x', 'b.tmp': 'y', 'cache/c.tmp': 'z', 'cache/data.json': '{}\n' },
    prompt: 'Delete every .tmp file in this workspace, including inside subfolders. Keep everything else.',
    gate: all(absent('a.tmp'), absent('b.tmp'), absent('cache/c.tmp'), fileEq('keep.txt', 'keep'), fileEq('cache/data.json', '{}'), onlyChanged(['a.tmp', 'b.tmp', 'cache/c.tmp'])),
    solve: [sh('rm a.tmp b.tmp cache/c.tmp'), say('Deleted 3 .tmp files.')] },
  { id: 'multi-concat', split: 'train', seed: { 'part1.txt': 'one\n', 'part2.txt': 'two\n', 'part3.txt': 'three\n' },
    prompt: 'Combine part1.txt, part2.txt and part3.txt, in that order, into full.txt.',
    gate: all(fileEq('full.txt', 'one\ntwo\nthree'), onlyChanged(['full.txt'])),
    solve: [sh('cat part1.txt part2.txt part3.txt > full.txt'), say('Wrote full.txt.')] },
].map((t) => ({ family: 'multifile', ...t }));

// ── questions whose answer has to be computed (written to answer.txt) ────────────────────────────
const TODO_FILES = { 'src/a.js': '// TODO: validate input\nexport const a = 1;\n// TODO: add tests\n', 'src/b.js': 'export const b = 2;\n', 'src/c.js': '// TODO: remove\n// todo lowercase is not counted\nexport const c = 3; // TODO: rename\n', 'lib/d.js': '// TODO: document\n// TODO: benchmark\n' };
const SIZES = { 'a.txt': 'a'.repeat(120), 'b.txt': 'b'.repeat(340), 'c.txt': 'c'.repeat(95), 'd.log': 'd'.repeat(200) };
// Shipped orders over 100: the bounds (100, 99.99, 100.01) are in the data on purpose.
const ORDERS = [[1, 'shipped', 120.5], [2, 'pending', 310], [3, 'shipped', 99.99], [4, 'shipped', 100], [5, 'cancelled', 450], [6, 'shipped', 101],
  [7, 'shipped', 75], [8, 'pending', 15], [9, 'shipped', 260], [10, 'shipped', 100.01], [11, 'cancelled', 120], [12, 'shipped', 12]].map(([id, status, total]) => ({ id, status, total }));
const ORDERS_BIG = ORDERS.filter((o) => o.status === 'shipped' && o.total > 100).length;
const DOCS = { 'docs/intro.md': '# Intro\n', 'docs/setup.md': '# Setup\n', 'docs/guide/usage.md': '# Usage\n', 'docs/guide/faq.md': '# FAQ\n', 'docs/guide/notes.txt': 'notes\n', 'docs/img/logo.svg': '<svg/>\n', 'README.md': '# Root\n' };
const queryTasks = [
  { id: 'query-count-lines', split: 'train', seed: { 'log.txt': LOG37 },
    prompt: 'How many lines does log.txt have? Write just the number into answer.txt.',
    gate: all(answerFile('answer.txt', '37', 'the line count'), onlyChanged(['answer.txt'])),
    solve: [sh('wc -l < log.txt > answer.txt'), say('37')] },
  { id: 'query-count-todo', split: 'dev', seed: TODO_FILES,
    prompt: 'Count the lines across all files in this workspace that contain the exact uppercase text "TODO". Write just the number into answer.txt.',
    gate: all(answerFile('answer.txt', '6', 'the count'), onlyChanged(['answer.txt'])),
    solve: [sh('grep -r "TODO" . | wc -l'), write('answer.txt', '6\n'), say('6')] },
  { id: 'query-which-defines', split: 'test', seed: { 'src/a.js': "import { parseConfig } from './config.js';\nexport const cfg = parseConfig('x=1');\n", 'src/config.js': "export function parseConfig(text) {\n  return Object.fromEntries(text.split('\\n').map((l) => l.split('=')));\n}\n", 'src/b.js': '// parseConfig is called once at startup\nexport const b = 1;\n' },
    prompt: 'Which file defines the function parseConfig? Write its path (relative to the workspace root) into answer.txt.',
    gate: all(answerFile('answer.txt', 'src/config.js', 'the defining file'), onlyChanged(['answer.txt'])),
    solve: [sh('grep -rl "function parseConfig" .'), write('answer.txt', 'src/config.js\n'), say('src/config.js')] },
  { id: 'query-sum-column', split: 'train', seed: { 'sales.csv': SALES_CSV },
    prompt: 'What is the total of the amount column in sales.csv? Write just the number into answer.txt.',
    gate: all((c) => { const t = c.file('answer.txt'); return t !== null && Math.abs(parseFloat(t) - SALES_SUM) < 1e-9 ? ok() : no('answer.txt does not hold the total'); }, onlyChanged(['answer.txt'])),
    solve: [sh("awk -F, 'NR>1 {s+=$3} END {print s}' sales.csv > answer.txt"), say(String(SALES_SUM))] },
  { id: 'query-count-rows', split: 'train', seed: { 'users.csv': USERS_CSV },
    prompt: 'How many users in users.csv are from country IN? Write just the number into answer.txt.',
    gate: all(answerFile('answer.txt', String(USERS_IN), 'the count'), onlyChanged(['answer.txt'])),
    solve: [sh('grep -c ",IN$" users.csv > answer.txt'), say(String(USERS_IN))] },
  { id: 'query-line-number', split: 'train', seed: { 'app.log': APPLOG },
    prompt: 'On which line number of app.log does the FATAL error appear? Write just the line number into answer.txt.',
    gate: all(answerFile('answer.txt', '31', 'the line number'), onlyChanged(['answer.txt'])),
    solve: [sh('grep -n FATAL app.log'), write('answer.txt', '31\n'), say('31')] },
  { id: 'query-largest-file', split: 'train', seed: SIZES,
    prompt: 'Which file in this directory is the largest? Write just its file name into answer.txt.',
    gate: all(answerFile('answer.txt', 'b.txt', 'the largest file'), onlyChanged(['answer.txt'])),
    solve: [sh('wc -c *'), write('answer.txt', 'b.txt\n'), say('b.txt')] },
  { id: 'query-unique-words', split: 'train', seed: { 'words.txt': WORDS.join('\n') + '\n' },
    prompt: 'words.txt has one word per line. How many distinct words does it contain? Write just the number into answer.txt.',
    gate: all(answerFile('answer.txt', String(WORDS_UNIQ), 'the distinct count'), onlyChanged(['answer.txt'])),
    solve: [sh('sort -u words.txt | wc -l > answer.txt'), say(String(WORDS_UNIQ))] },
  { id: 'query-count-md', split: 'train', seed: DOCS,
    prompt: 'How many Markdown (.md) files are under docs/, including its subfolders? Write just the number into answer.txt.',
    gate: all(answerFile('answer.txt', '4', 'the count'), onlyChanged(['answer.txt'])),
    solve: [sh('find docs -name "*.md" | wc -l > answer.txt'), say('4')] },
  { id: 'query-shipped-orders', split: 'train', pythonRef: true, seed: { 'orders.json': JSON.stringify(ORDERS, null, 2) + '\n' },
    prompt: 'How many orders in orders.json have status "shipped" and a total greater than 100? Write just the number into answer.txt.',
    gate: all(answerFile('answer.txt', String(ORDERS_BIG), 'the count'), onlyChanged(['answer.txt'])),
    solve: [sh(`python -c "import json; n = sum(1 for o in json.load(open('orders.json')) if o['status'] == 'shipped' and o['total'] > 100); open('answer.txt', 'w').write(str(n))"`), say(String(ORDERS_BIG))] },
].map((t) => ({ family: 'query', ...t }));

// ── transforms ─────────────────────────────────────────────────────────────────────────────────
const transformTasks = [
  { id: 'xf-sort-lines', split: 'train', seed: { 'names.txt': NAMES.join('\n') + '\n' },
    prompt: 'Write the names from names.txt into sorted.txt in alphabetical order, one per line.',
    gate: all(fileEq('sorted.txt', [...NAMES].sort().join('\n')), onlyChanged(['sorted.txt'])),
    solve: [sh('sort names.txt > sorted.txt'), say('Sorted.')] },
  { id: 'xf-dedupe', split: 'train', seed: { 'emails.txt': EMAILS.join('\n') + '\n' },
    prompt: 'Write the addresses from emails.txt into unique.txt with duplicates removed, keeping the order of first appearance.',
    gate: all(fileEq('unique.txt', [...new Set(EMAILS)].join('\n')), onlyChanged(['unique.txt'])),
    solve: [write('unique.txt', [...new Set(EMAILS)].join('\n') + '\n'), say('Deduplicated.')] },
  { id: 'xf-extract-column', split: 'test', seed: { 'people.csv': PEOPLE_CSV },
    prompt: 'Extract the email column from people.csv into emails.txt, one address per line, without the header.',
    gate: all(fileEq('emails.txt', 'mira@acme.dev\narjun@acme.dev\nzoe@acme.dev\nliam@acme.dev'), onlyChanged(['emails.txt'])),
    solve: [sh("awk -F, 'NR>1 {print $2}' people.csv > emails.txt"), say('Extracted.')] },
  { id: 'xf-kv-to-json', split: 'train', seed: { 'settings.txt': KV },
    prompt: 'Convert settings.txt (key=value lines) into settings.json: one JSON object whose values are the strings from the file.',
    gate: all((c) => { const t = c.file('settings.json'); if (t === null) return no('settings.json does not exist'); try { const o = JSON.parse(t); return JSON.stringify(o) === JSON.stringify({ host: 'db.local', port: '5432', user: 'admin', mode: 'readonly' }) ? ok() : no('settings.json does not hold the four keys as strings, in order'); } catch (_) { return no('settings.json is not valid JSON'); } }, onlyChanged(['settings.json'])),
    solve: [write('settings.json', JSON.stringify({ host: 'db.local', port: '5432', user: 'admin', mode: 'readonly' }, null, 2) + '\n'), say('Converted.')] },
  { id: 'xf-json-filter', split: 'dev', seed: { 'users.json': USERS_JSON },
    prompt: 'users.json is a list of users. Write the names of the active users into active.txt, one per line, in the order they appear.',
    gate: all(fileEq('active.txt', 'mira\nzoe\nliam'), onlyChanged(['active.txt'])),
    solve: [sh("jq -r '.[] | select(.active) | .name' users.json > active.txt"), say('Wrote active.txt.')] },
  { id: 'xf-reverse-lines', split: 'train', seed: { 'poem.txt': POEM },
    prompt: 'Write the lines of poem.txt into reversed.txt in reverse order (last line first).',
    gate: all(fileEq('reversed.txt', POEM.trim().split('\n').reverse().join('\n')), onlyChanged(['reversed.txt'])),
    solve: [sh('tac poem.txt > reversed.txt'), say('Reversed.')] },
  { id: 'xf-number-lines', split: 'train', seed: { 'list.txt': LIST },
    prompt: 'Write the items of list.txt into numbered.txt, each prefixed with its number like "1. milk".',
    gate: all(fileEq('numbered.txt', LIST.trim().split('\n').map((l, i) => `${i + 1}. ${l}`).join('\n')), onlyChanged(['numbered.txt'])),
    solve: [sh('awk \'{print NR". "$0}\' list.txt > numbered.txt'), say('Numbered.')] },
].map((t) => ({ family: 'transform', ...t }));

// ── code: write or fix a small ES module; the gate loads it and calls it (gated: the loop shows
//    the failing call, as a test command would) ───────────────────────────────────────────────────
const ISEVEN = 'export function isEven(n) {\n  return n % 2 === 1;\n}\n';
const RANGE = 'export function range(n) {\n  const out = [];\n  for (let i = 0; i <= n; i++) out.push(i);\n  return out;\n}\n';
const SLUG = '// slugify("Hello, World!") === "hello-world": lowercase, leading and trailing spaces dropped,\n// runs of spaces become one "-", every character that is not a-z, 0-9 or "-" is dropped.\nexport function slugify(s) {\n  throw new Error("TODO");\n}\n';
const GREET = 'export function greet(name) {\n  return "Hello, " + name + "!";\n}\n';
const SUM = 'export function sum(xs) {\n  let s = 0;\n  for (const x of xs) s += x;\n  return s;\n}\n';
const SUM_TEST = "import { sum } from './sum.js';\n// sum ignores anything that is not a finite number\nconsole.assert(sum([1, 2, 3]) === 6);\nconsole.assert(sum([1, '2', null, 3]) === 4);\nconsole.assert(sum([NaN, 5, Infinity]) === 5);\nconsole.assert(sum([]) === 0);\n";
const codeTasks = [
  { id: 'code-write-math', split: 'train', seed: {},
    prompt: 'Create math.js, an ES module that exports two functions: add(a, b) returns a + b, and mul(a, b) returns a * b.',
    gate: all(jsGate('math.js', [['add', [2, 3], 5], ['add', [-1, 1], 0], ['mul', [4, 5], 20], ['mul', [0, 9], 0]]), onlyChanged(['math.js'])),
    solve: [write('math.js', 'export function add(a, b) { return a + b; }\nexport function mul(a, b) { return a * b; }\n'), say('Created math.js.')] },
  { id: 'code-fix-iseven', split: 'train', gated: true, seed: { 'utils.js': ISEVEN },
    prompt: 'isEven in utils.js gives the wrong answer. Fix it.',
    gate: all(jsGate('utils.js', [['isEven', [4], true], ['isEven', [7], false], ['isEven', [0], true], ['isEven', [-2], true]]), onlyChanged(['utils.js'])),
    solve: [edit('utils.js', 'n % 2 === 1', 'n % 2 === 0'), done('fixed isEven')] },
  { id: 'code-fix-range', split: 'train', gated: true, seed: { 'range.js': RANGE },
    prompt: 'range(n) in range.js should return the n numbers 0 … n-1, but it returns one too many. Fix it.',
    gate: all(jsGate('range.js', [['range', [3], [0, 1, 2]], ['range', [0], []], ['range', [1], [0]]]), onlyChanged(['range.js'])),
    solve: [edit('range.js', 'i <= n', 'i < n'), done('fixed the bound')] },
  { id: 'code-implement-slugify', split: 'dev', seed: { 'strings.js': SLUG },
    prompt: 'Implement slugify in strings.js as its comment describes.',
    gate: all(jsGate('strings.js', [['slugify', ['Hello, World!'], 'hello-world'], ['slugify', ['  Many   spaces here '], 'many-spaces-here'], ['slugify', ['ABC 123'], 'abc-123'], ['slugify', ['a--b'], 'a--b']]), onlyChanged(['strings.js'])),
    solve: [edit('strings.js', 'throw new Error("TODO");', 'return s.toLowerCase().trim().replace(/\\s+/g, "-").replace(/[^a-z0-9-]/g, "");'), say('Implemented slugify.')] },
  { id: 'code-default-param', split: 'train', seed: { 'greet.js': GREET },
    prompt: 'Give greet in greet.js an optional second parameter, greeting, defaulting to "Hello", so greet("Ada", "Hi") returns "Hi, Ada!". greet("Ada") must still return "Hello, Ada!".',
    gate: all(jsGate('greet.js', [['greet', ['Ada'], 'Hello, Ada!'], ['greet', ['Ada', 'Hi'], 'Hi, Ada!']]), onlyChanged(['greet.js'])),
    solve: [write('greet.js', 'export function greet(name, greeting = "Hello") {\n  return greeting + ", " + name + "!";\n}\n'), say('Added the parameter.')] },
  { id: 'code-fix-from-test', split: 'test', gated: true, seed: { 'sum.js': SUM, 'sum.test.js': SUM_TEST },
    prompt: 'sum.test.js describes how sum in sum.js should behave, and sum.js does not meet it. Fix sum.js. Do not change the test.',
    gate: all(jsGate('sum.js', [['sum', [[1, 2, 3]], 6], ['sum', [[1, '2', null, 3]], 4], ['sum', [[NaN, 5, Infinity]], 5], ['sum', [[]], 0]]), onlyChanged(['sum.js'])),
    solve: [edit('sum.js', 's += x;', "if (typeof x === 'number' && Number.isFinite(x)) s += x;"), done('sum skips non-finite values')] },
].map((t) => ({ family: 'code', ...t }));

// ── read-only questions answered in prose ───────────────────────────────────────────────────────
const readonlyTasks = [
  { id: 'ro-what-port', split: 'train', seed: { 'server.conf': 'listen 0.0.0.0\nport 8443\ntls on\n', 'README.md': '# Server\n' },
    prompt: 'What port does the server listen on, according to its config?',
    gate: all(answerHas(/\b8443\b/, 'the port'), onlyChanged([])), solve: [sh('cat server.conf'), say('8443')] },
  { id: 'ro-count-functions', split: 'dev', seed: { 'lib.js': 'export function a() {}\nexport function b() {}\nfunction helper() {}\nexport const c = () => 1;\nexport function d() { return helper(); }\n' },
    prompt: 'How many functions are declared with the function keyword in lib.js?',
    gate: all(answerHas(/\b4\b|\bfour\b/i, 'the count'), onlyChanged([])), solve: [sh('grep -c "function " lib.js'), say('4')] },
  { id: 'ro-mystery-return', split: 'test', seed: { 'm.js': 'export function mystery(n) {\n  let r = 1;\n  for (let i = 0; i < n; i++) r = r * 2 + i;\n  return r;\n}\n' },
    prompt: 'What does mystery(3) in m.js return?',
    gate: all(answerHas(/\b12\b/, 'the value'), onlyChanged([])), solve: [sh('cat m.js'), say('mystery(3) returns 12.')] },
  { id: 'ro-list-subdirs', split: 'train', seed: { 'src/a.js': '', 'docs/x.md': '', 'tests/t.js': '', 'top.txt': '' },
    prompt: 'Which folders are at the top level of this workspace?',
    gate: all(answerHas(/\bsrc\b/, 'src'), answerHas(/\bdocs\b/, 'docs'), answerHas(/\btests\b/, 'tests'), onlyChanged([])), solve: [sh('ls'), say('docs, src, tests')] },
  { id: 'ro-maintainer', split: 'train', seed: { 'MAINTAINERS': 'Lead: Priya Raman <priya@example.org>\nReviewers: Tom Okafor\n', 'README.md': '# Project\n' },
    prompt: 'Who is the lead maintainer of this project?',
    gate: all(answerHas(/Priya Raman/, 'the lead'), onlyChanged([])), solve: [sh('cat MAINTAINERS'), say('Priya Raman')] },
].map((t) => ({ family: 'readonly', ...t }));

// ── constraints a careful agent keeps ───────────────────────────────────────────────────────────
const constraintTasks = [
  { id: 'cons-typo-one-file', split: 'train', seed: { 'notes.md': 'teh plan is set\n', 'other.md': 'teh other file\n' },
    prompt: 'Fix the typo "teh" in notes.md. Do not change any other file.',
    gate: all(fileEq('notes.md', 'the plan is set'), fileEq('other.md', 'teh other file'), onlyChanged(['notes.md'])),
    solve: [edit('notes.md', 'teh', 'the'), say('Fixed notes.md.')] },
  { id: 'cons-append-preserve', split: 'dev', seed: { 'list.txt': 'one\ntwo\nthree\n' },
    prompt: 'Append the line "four" to list.txt.',
    gate: all(fileEq('list.txt', 'one\ntwo\nthree\nfour\n', { trim: false }), onlyChanged(['list.txt'])),
    solve: [sh('echo four >> list.txt'), say('Appended four.')] },
  { id: 'cons-already-listed', split: 'train', seed: { '.gitignore': 'dist/\nnode_modules/\n.env\n' },
    prompt: 'Make sure node_modules is ignored in .gitignore — add it only if it is missing.',
    gate: all(fileEq('.gitignore', 'dist/\nnode_modules/\n.env\n', { trim: false }), answerHas(/already|is (listed|ignored|present)|no change/i, 'that it was already listed'), onlyChanged([])),
    solve: [sh('cat .gitignore'), say('node_modules/ is already listed; no change needed.')] },
  { id: 'cons-count-no-change', split: 'test', seed: { 'config.txt': 'a=1\nb=2\nc=3\nd=4\ne=5\n' },
    prompt: 'Without changing any files, tell me how many lines config.txt has.',
    gate: all(answerHas(/\b5\b|\bfive\b/i, 'the count'), onlyChanged([])), solve: [sh('wc -l config.txt'), say('5')] },
].map((t) => ({ family: 'constraint', ...t }));

export const TASKS = Object.freeze([...proceduralTasks, ...batteryTasks, ...editTasks, ...multiTasks, ...queryTasks, ...transformTasks, ...codeTasks, ...readonlyTasks, ...constraintTasks, ...HARD_TASKS, ...BUILD_TASKS]);
export const SPLITS = Object.freeze(['train', 'dev', 'test']);
export function tasksIn(split) {
  if (!SPLITS.includes(split)) throw new Error(`no split "${split}" — one of ${SPLITS.join(', ')}`);
  return TASKS.filter((t) => t.split === split);
}
