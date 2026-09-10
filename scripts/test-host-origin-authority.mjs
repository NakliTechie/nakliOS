// Two grants that were keyed on the wrong question, both fixed 2026-09-10.
//   node scripts/test-host-origin-authority.mjs
//
// 1. The SYSTEM filesystem — the whole user store, every app's apps/<id>/ tree —
//    was gated on `!app.thirdParty`. That admits every first-party CATALOG app,
//    including cross-origin ones running on their own origins under
//    allow-same-origin sandboxes. Lorewell is the sharpest case: kind:'system'
//    AND cross-origin, so neither half of the check alone refuses it.
//
// 2. The host's message handler authorised by window identity alone
//    (`knownIframes.has(e.source)`). A frame that navigates itself elsewhere keeps
//    its contentWindow, so its grants travelled to the new origin — and the replies
//    went out with targetOrigin '*', so the new origin read them too.
//
// Both are checked by RUNNING the real code out of index.html against stubs, not by
// grepping for it: a grep matches a name, and the defect here was never in a name.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const ORIGIN = 'https://naklios.dev';

// ── the real APPS table + the two predicates, evaluated ──────────────────────
function loadGate(hostname = 'naklios.dev'){
  const appsStart = host.indexOf('\nconst APPS = [');
  const appsEnd = host.indexOf('\n];\n', appsStart);
  assert.ok(appsStart > 0 && appsEnd > appsStart, 'the APPS table is still a top-level array literal');
  const apps = host.slice(appsStart, appsEnd + 3);

  const expected = host.match(/function appExpectedOrigin\(app\)\{[\s\S]*?\n\}/);
  const ownsFs = host.match(/function aiAppOwnsSystemFs\(appId\)\{[\s\S]*?\n\}/);
  const isSystem = host.match(/function aiAppIsSystem\(appId\)\{[\s\S]*?\n\}/);
  assert.ok(expected && ownsFs && isSystem, 'appExpectedOrigin / aiAppOwnsSystemFs / aiAppIsSystem found');

  return new Function('location', `
    ${apps}
    ${expected[0]}
    ${ownsFs[0]}
    ${isSystem[0]}
    return { APPS, appExpectedOrigin, aiAppOwnsSystemFs, aiAppIsSystem };
  `)({ hostname, origin: ORIGIN, href: ORIGIN + '/' });
}

const g = loadGate();
const byId = (id) => g.APPS.find(a => a.id === id);

// The premise: these apps really are shaped the way the finding says.
assert.equal(byId('books').kind, 'system', 'Lorewell is still declared a system app');
assert.notEqual(g.appExpectedOrigin(byId('books')), ORIGIN, 'Lorewell still loads cross-origin');
assert.equal(byId('files').kind, 'system');
assert.equal(g.appExpectedOrigin(byId('files')), ORIGIN, 'Files is served from this origin');

// ── the gate itself ──────────────────────────────────────────────────────────
for (const id of ['files', 'anvil', 'forge', 'editor', 'notes', 'calendar']) {
  assert.equal(g.aiAppOwnsSystemFs(id), true, `${id} is a same-origin system app and keeps the system filesystem`);
}
// A cross-origin app never reaches the whole store, whatever tier it is declared at.
assert.equal(g.aiAppOwnsSystemFs('books'), false,
  'Lorewell is kind:system but cross-origin — refused (this is the case a kind-only check misses)');
for (const id of ['mod', 'mehfil', 'bolo', 'reckon', 'draft', 'tijori']) {
  if (!byId(id)) continue;
  assert.equal(g.aiAppOwnsSystemFs(id), false, `${id} is a catalog app and stays clamped to its namespace`);
}
assert.equal(g.aiAppOwnsSystemFs('no-such-app'), false, 'an unknown id is refused');

// Every cross-origin app in the real table is refused, with no exception list.
const admitted = g.APPS.filter(a => a.url && g.aiAppOwnsSystemFs(a.id));
const leaking = admitted.filter(a => g.appExpectedOrigin(a) !== ORIGIN);
assert.deepEqual(leaking.map(a => a.id), [], 'no app served from another origin holds the system filesystem');

// A third-party app has an opaque origin and can never match this one.
assert.equal(g.appExpectedOrigin({ id:'x', thirdParty:true, url:'https://evil.example/' }), 'null');
assert.equal(g.appExpectedOrigin({ id:'y', url:'./apps/y/' }), ORIGIN, 'a relative embed resolves to this origin');

// The two tiers are genuinely separate questions now, not one answer shared.
assert.equal(g.aiAppIsSystem('books'), true, 'the AI tier still keys on !thirdParty (deliberate)');
assert.equal(g.aiAppOwnsSystemFs('books'), false, 'the file tier does not');

// The sysfs route and the capability broadcast both ride the new predicate.
assert.match(host, /if \(!aiAppOwnsSystemFs\(appId\)\) throw new Error\('System filesystem is available to same-origin system apps only'\);/,
  'the system-fs route is gated on aiAppOwnsSystemFs');
assert.match(host, /const isSystem = aiAppOwnsSystemFs\(appId\);/,
  'the capability broadcast computes isSystem from the same predicate');
assert.match(host, /sysFs: isSystem && fsCap,/, 'sysFs is still broadcast from isSystem');

// ── the message handler, driven for real ─────────────────────────────────────
const start = host.indexOf("window.addEventListener('message', async e => {\n  if (!knownIframes.has(e.source)) return;");
assert.ok(start > 0, 'the host message handler is still one addEventListener');
const end = host.indexOf('\n});', start);
const handlerSrc = host.slice(start, end + 4);

// The window's expected origin is stamped where the sandbox decision is made, so the
// two can never disagree about who an app is.
assert.match(host, /win\._expectedOrigin = forceOpaqueSandbox \? 'null' : appExpectedOrigin\(app\);/,
  'each window records the origin it was launched at');

function driveHandler({ expectedOrigin, messageOrigin, type = 'naklios:close' }){
  const contentWindow = { posted: [], postMessage(m, target){ this.posted.push([m, target]); } };
  const win = { dataset:{ id:'reckon' }, _expectedOrigin: expectedOrigin, querySelector: () => ({ textContent:'' }) };
  const iframe = { contentWindow, closest: () => win };
  const calls = { closed: 0, settings: 0 };

  let handler = null;
  const scope = {
    window: { addEventListener: (_t, fn) => { handler = fn; } },
    document: { querySelectorAll: () => [iframe] },
    knownIframes: new Set([contentWindow]),
    closeWindow: () => { calls.closed++; },
    openSettings: () => { calls.settings++; },
    finalizeCloseWindow(){}, markIframeLaunchPhase(){}, deliverPendingFileGrants(){},
    postCapabilities(){}, THEMES: [{ id:'dark', colors:{}, mood:'dark' }], state:{ theme:'dark' },
  };
  const keys = Object.keys(scope);
  new Function(...keys, handlerSrc)(...keys.map(k => scope[k]));
  assert.ok(handler, 'the handler registered');
  return { run: (m = { type }) => handler({ source: contentWindow, origin: messageOrigin, data: m }), calls, contentWindow };
}

// Baseline: the same window, at the origin it was launched at, still works.
const ok = driveHandler({ expectedOrigin: ORIGIN, messageOrigin: ORIGIN });
await ok.run();
assert.equal(ok.calls.closed, 1, 'a message from the launch origin is honoured');

// The finding: a known window that has navigated elsewhere is dropped.
const moved = driveHandler({ expectedOrigin: ORIGIN, messageOrigin: 'https://attacker.example' });
await moved.run();
assert.equal(moved.calls.closed, 0, 'a known window at an unexpected origin is dropped');

// …including on the branches that do not resolve a window at all.
const movedSettings = driveHandler({ expectedOrigin: ORIGIN, messageOrigin: 'https://attacker.example' });
await movedSettings.run({ type:'naklios:open-settings' });
assert.equal(movedSettings.calls.settings, 0, 'open-settings is origin-gated too');

// A cross-origin app is bound to ITS origin, not merely to "not ours".
const crossOk = driveHandler({ expectedOrigin: 'https://lorewell.naklitechie.com', messageOrigin: 'https://lorewell.naklitechie.com' });
await crossOk.run();
assert.equal(crossOk.calls.closed, 1, 'a cross-origin app speaking from its own origin is honoured');
const crossMoved = driveHandler({ expectedOrigin: 'https://lorewell.naklitechie.com', messageOrigin: ORIGIN });
await crossMoved.run();
assert.equal(crossMoved.calls.closed, 0, 'a cross-origin app claiming the host origin is dropped');

// Replies are addressed to that origin, never '*'.
const themed = driveHandler({ expectedOrigin: ORIGIN, messageOrigin: ORIGIN });
await themed.run({ type:'naklios:theme-request' });
assert.equal(themed.contentWindow.posted.length, 1, 'the theme reply went out');
assert.equal(themed.contentWindow.posted[0][1], ORIGIN, 'addressed to the app origin, not "*"');

// An opaque third-party origin is the one case that must stay '*' — postMessage
// cannot target an opaque origin at all. Such a frame has no origin to impersonate.
const opaque = driveHandler({ expectedOrigin: 'null', messageOrigin: 'null' });
await opaque.run({ type:'naklios:theme-request' });
assert.equal(opaque.contentWindow.posted[0][1], '*', 'an opaque-origin frame is replied to with "*"');
const opaqueMoved = driveHandler({ expectedOrigin: 'null', messageOrigin: ORIGIN });
await opaqueMoved.run();
assert.equal(opaqueMoved.calls.closed, 0, 'a third-party frame claiming the host origin is dropped');

console.log('host-origin-authority: system filesystem gated on same-origin system apps; messages bound to the launch origin');
