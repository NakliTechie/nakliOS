// A LOCKED Crate keeps an app's storage binding (live 2026-09-24).
//
// Anvil was bound to Crate; a reload left the Crate locked; the first file op fell through
// fsEnsurePermission's "backend disconnected → re-prompt" path, which offered the one connected
// backend (the Folder) as a first-time grant — and its Allow silently overwrote the Crate binding.
// Unlocking afterwards did not bring it back. Now a locked Crate asks: Unlock / Use Folder / Cancel.
//
// This extracts the real fsEnsurePermission from index.html and drives it against stubs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const src = host.match(/async function fsEnsurePermission\(appId\)\{[\s\S]*?\n\}\n/);
assert.ok(src, 'fsEnsurePermission found in index.html');

function bed({ crateLocked, crateConnected = false, fsaConnected = true, perm, answer, unlockOk = true }) {
  const calls = { dialogs: [], confirms: 0, saves: 0, broadcasts: 0, unlocks: 0 };
  const state = { appPermissions: { anvil: perm }, crateLocked, crateBucketName: 'crate-test', crate: null };
  const BACKENDS = {
    fsa: { id: 'fsa', isConnected: () => fsaConnected, displayName: () => 'nakliOS' },
    crate: { id: 'crate', isConnected: () => crateConnected || !!state.crate, displayName: () => 'crate-test' },
  };
  const env = {
    APPS: [{ id: 'anvil', name: 'Anvil' }], state, BACKENDS,
    migrateAppPermission: () => {},
    backendsAvailable: () => Object.values(BACKENDS).filter((b) => b.isConnected()).map((b) => b.id),
    _dlgEscape: (x) => String(x),
    _nakliosDialog: async (d) => { calls.dialogs.push(d); return answer; },
    nakliosConfirm: async () => { calls.confirms++; return true; },
    crateInteractiveUnlock: async () => { calls.unlocks++; if (unlockOk) state.crate = {}; return unlockOk; },
    saveAppPermissions: () => { calls.saves++; },
    broadcastCapabilities: () => { calls.broadcasts++; },
  };
  const fn = new Function(...Object.keys(env), `${src[0]}; return fsEnsurePermission;`)(...Object.values(env));
  return { fn, state, calls };
}

const bound = { backend: 'crate', granted: true };

// Unlock: the binding holds and the op proceeds on Crate.
{
  const b = bed({ crateLocked: true, perm: bound, answer: 'unlock' });
  assert.equal(await b.fn('anvil'), 'crate', 'unlocking returns the Crate');
  assert.equal(b.calls.unlocks, 1, 'the unlock flow ran');
  assert.deepEqual(b.state.appPermissions.anvil, bound, 'the binding is untouched');
  assert.equal(b.calls.confirms, 0, 'no first-time grant prompt');
  assert.match(b.calls.dialogs[0].title, /Anvil keeps its data in your Crate/, 'the dialog says why it is asking');
  assert.deepEqual(b.calls.dialogs[0].buttons.map((x) => x.value), ['cancel', 'fsa', 'unlock'], 'three choices, unlock primary last');
}
// Unlock that fails: nothing moves.
{
  const b = bed({ crateLocked: true, perm: bound, answer: 'unlock', unlockOk: false });
  assert.equal(await b.fn('anvil'), null, 'a failed unlock is no storage, not a silent move');
  assert.deepEqual(b.state.appPermissions.anvil, bound, 'still bound to Crate');
}
// Cancel: nothing moves.
{
  const b = bed({ crateLocked: true, perm: bound, answer: 'cancel' });
  assert.equal(await b.fn('anvil'), null);
  assert.deepEqual(b.state.appPermissions.anvil, bound, 'cancel keeps the Crate binding');
  assert.equal(b.calls.saves, 0);
}
// Use Folder: an explicit move.
{
  const b = bed({ crateLocked: true, perm: bound, answer: 'fsa' });
  assert.equal(await b.fn('anvil'), 'fsa', 'moved to the Folder on request');
  assert.deepEqual(b.state.appPermissions.anvil, { backend: 'fsa', granted: true });
  assert.equal(b.calls.saves, 1); assert.equal(b.calls.broadcasts, 1);
}
// No Folder connected: the move is not offered.
{
  const b = bed({ crateLocked: true, fsaConnected: false, perm: bound, answer: 'cancel' });
  await b.fn('anvil');
  assert.deepEqual(b.calls.dialogs[0].buttons.map((x) => x.value), ['cancel', 'unlock'], 'no Folder, no Folder button');
}
// Unchanged: a connected Crate answers at once; a DISCONNECTED (forgotten, not locked) one re-prompts as before.
{
  const b = bed({ crateLocked: false, crateConnected: true, perm: bound, answer: 'x' });
  assert.equal(await b.fn('anvil'), 'crate'); assert.equal(b.calls.dialogs.length, 0);
  const d = bed({ crateLocked: false, perm: bound, answer: 'x' });
  assert.equal(await d.fn('anvil'), 'fsa', 'not locked, just gone: the one-backend grant prompt, as before');
  assert.equal(d.calls.confirms, 1);
}

console.log('host-locked-crate-binding: a locked Crate asks unlock / move / cancel; the binding moves only on an explicit choice');
