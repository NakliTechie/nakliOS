// test-check-app-shell.mjs — the app shell's agent-surface check fails on each broken manifest it exists to catch.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coreKeys, checkCommands } from './check-app-shell.mjs';

const core = coreKeys(readFileSync(new URL('../sdk/app-shell.js', import.meta.url), 'utf8'));
assert.deepEqual(core['file.save'], ['Mod+S']);
assert.ok(core['edit.replace'].includes('Ctrl+H') && core['edit.replace'].includes('Mod+H'), 'both sides of the isMac choice count');

const good = [
  { name: 'file.new', shortcut: ['Mod+Alt+N', 'Mod+N'] }, { name: 'file.open', shortcut: 'Mod+O' },
  { name: 'file.save', shortcut: 'Mod+S' }, { name: 'file.save_as', shortcut: 'Mod+Shift+S' }, { name: 'file.export' },
  { name: 'view.palette', shortcut: 'Mod+Shift+P' }, // an app's own command on an edit or app key is allowed
  { name: 'document.print', shortcut: 'Mod+P', description: 'Print (alias of file.print).' }, { name: 'file.print', shortcut: 'Mod+P' },
];
assert.deepEqual(checkCommands({ commands: good }, core), []);
assert.deepEqual(checkCommands(good, core), [], 'a bare array works too');

const without = good.filter((c) => c.name !== 'file.save_as');
assert.deepEqual(checkCommands(without, core), ['lacks the standard command file.save_as']);

const wrongKey = good.map((c) => (c.name === 'file.open' ? { ...c, shortcut: 'Mod+Shift+O' } : c));
assert.deepEqual(checkCommands(wrongKey, core), ['file.open misses the standard key Mod+O (has Mod+Shift+O)']);

const stolen = [...good, { name: 'deck.export', shortcut: 'Mod+S' }];
assert.deepEqual(checkCommands(stolen, core), ['deck.export binds Mod+S, the core key of file.save']);

const unmarkedAlias = good.map((c) => (c.name === 'document.print' ? { ...c, description: 'Print.' } : c));
assert.deepEqual(checkCommands(unmarkedAlias, core), ['document.print binds Mod+P, the core key of file.print']);

console.log('check-app-shell: 7 cases pass');
