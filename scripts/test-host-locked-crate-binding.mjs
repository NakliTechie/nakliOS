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
// The prompt is shared per app: the region runs from its map to the end of fsEnsurePermissionOnce.
const src = host.match(/const fsPermissionPrompts = new Map\(\);[\s\S]*?async function fsEnsurePermissionOnce\(appId\)\{[\s\S]*?\n\}\n/);
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
  const made = new Function(...Object.keys(env), `${src[0]}; return { fsEnsurePermission, fsPromptWaiters };`)(...Object.values(env));
  return { fn: made.fsEnsurePermission, waiters: made.fsPromptWaiters, state, calls, env };
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

// The first-use dialog promises "You can revoke or switch backends later in Settings" — the control
// that keeps the promise (2026-09-24): one select per app, wired to fsHostSelectBackend / revoke.
assert.match(host, /switch backends later in Settings/, 'the promise is still made');
assert.match(host, /<h4 id="settings-app-storage-heading">App storage<\/h4>\s*\$\{appStorageHTML\}/, 'Settings renders the App storage section');
assert.match(host, /class="app-storage-select" data-app-id=/, 'one select per app');
assert.match(host, /querySelectorAll\('\.app-storage-select'\)[\s\S]{0,400}await fsHostSelectBackend\(appId, sel\.value\)/, 'a change switches through the host function');
assert.match(host, /sel\.value === 'revoke'\) \{\s*delete state\.appPermissions\[appId\];/, 'and revoke removes the binding');

console.log('host-locked-crate-binding: a locked Crate asks unlock / move / cancel; the binding moves only on an explicit choice; Settings switches or revokes it per app');

// One prompt per app (live 2026-10-29: three stacked "Allow Anvil?" prompts). Calls that arrive while
// it is open share its answer, and every waiting call hears that the person is being asked.
{
  let release;
  const gate = new Promise((r) => { release = r; });
  const b2 = bed({ crateLocked: false, fsaConnected: true, perm: undefined });
  // Rebuild with a confirm that waits until released, so three calls overlap the open prompt.
  const confirms = [];
  const env = { ...b2.env, nakliosConfirm: async () => { confirms.push(1); await gate; return true; } };
  const made = new Function(...Object.keys(env), `${src[0]}; return { fsEnsurePermission, fsPromptWaiters };`)(...Object.values(env));
  const heard = [];
  made.fsPromptWaiters.set('anvil', new Set([() => heard.push('a'), () => heard.push('b')]));
  const calls = [made.fsEnsurePermission('anvil'), made.fsEnsurePermission('anvil'), made.fsEnsurePermission('anvil')];
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(confirms.length, 1, 'three overlapping file calls raise ONE prompt');
  assert.ok(heard.includes('a') && heard.includes('b'), 'every waiting call hears that the person is being asked');
  release();
  assert.deepEqual(await Promise.all(calls), ['fsa', 'fsa', 'fsa'], 'all three get the one answer');
  assert.equal(await made.fsEnsurePermission('anvil'), 'fsa', 'a later call uses the saved grant');
  assert.equal(confirms.length, 1, 'and asks nothing');
}

// The wire: the host tells the SDK a call is waiting, and the SDK stops that call's clock.
{
  assert.match(host, /type: 'naklios:rpc:waiting', requestId: msg\.requestId/, 'the fs dispatch tells the app its call waits');
  const sdk = await readFile(new URL('../sdk/naklios.js', import.meta.url), 'utf8');
  assert.match(sdk, /msg\.type === 'naklios:rpc:waiting' && msg\.requestId\)[\s\S]{0,200}clearTimeout\(w\.timer\)/, 'the SDK stops the 30 s clock for that call');
  const pi = await readFile(new URL('../apps/pi/index.html', import.meta.url), 'utf8');
  assert.match(pi, /Waiting for you to allow Pi\\'s storage in NakliOS/, 'Pi names the wait in its status line');
}
console.log('test-host-locked-crate-binding: ok (shared prompt + waiting wire)');
