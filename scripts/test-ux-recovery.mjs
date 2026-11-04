import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sdk = await readFile(new URL('../sdk/naklios.js', import.meta.url), 'utf8');
const files = await readFile(new URL('../apps/files/index.html', import.meta.url), 'utf8');
const notes = await readFile(new URL('../apps/notes/index.html', import.meta.url), 'utf8');

assert.match(host, /--faint:color-mix\(in srgb, var\(--ink\) 62%, var\(--body\)\)/,
  'secondary text must use the higher-contrast faint token');
assert.match(host, /function fitWindowToViewport\(win\)/,
  'windows must adapt to the mobile viewport');
assert.match(host, /Object\.values\(openWindows\)\.forEach\(fitWindowToViewport\)/,
  'open windows must refit when the viewport changes');
assert.match(host, /body\.is-mobile \.nw-close\{[\s\S]*?width:44px; height:44px/,
  'mobile window controls must expose 44px touch targets');

for (const label of [
  'aria-label="Search apps"',
  'aria-label="Folder — not connected"',
  'aria-label="Crate — not connected"',
  'aria-label="Settings"',
]) {
  assert.ok(host.includes(label), `host control must include ${label}`);
}
assert.match(host, /role="combobox"[\s\S]*?aria-controls="spot-list"/,
  'app search must expose combobox semantics');
assert.match(host, /role="listbox" aria-label="Matching apps"/,
  'app search results must expose listbox semantics');
assert.match(host, /role="option" aria-selected=/,
  'app search rows must expose option state');
assert.match(host, /wrap\.setAttribute\('role', 'dialog'\)/,
  'Settings must expose dialog semantics');
assert.match(host, /aria-pressed="\$\{t\.id === state\.theme\}"/,
  'theme choices must expose their selected state');
assert.match(host, /dlg\.setAttribute\('aria-labelledby', 'nw-manual-creds-title'\)/,
  'manual Crate credentials must have an accessible dialog name');

assert.match(sdk, /openSettings: function \(section\)/,
  'cooperative apps need the host-owned Settings recovery action');
assert.match(host, /msg\.type === 'naklios:open-settings'/,
  'the host must handle Settings requests from known app frames');
assert.match(files, /Open Storage settings…/,
  'Files must offer a direct recovery action when disconnected');
assert.doesNotMatch(files, /Files needs to run inside NakliOS/,
  'Files must not leave people at the old dead-end message');
assert.match(notes, /`Connect \$\{location\.label\}`/,
  'Notes must turn disconnected storage choices into connect actions');
assert.match(host, /'Saved · This browser'/,
  'ordinary browser autosave must say Saved');
assert.doesNotMatch(host, /\? 'Recovered · This browser'/,
  'ordinary browser autosave must not be presented as crash recovery');
assert.match(host, /if \(app\.opensInNewTab === true \|\| app\.iframeable === false\)[\s\S]*?return spawnIframeWindow\(app, options\);/,
  'every profile opens compatible apps inside NakliOS');
assert.doesNotMatch(host, /if \(isMobile\(\)\) return 'basic'/,
  'mobile profiles must retain the selected windowed experience now that windows fit');
assert.match(host, /const HAD_EXISTING_PROFILE = Object\.keys\(localStorage\)/,
  'first-run onboarding must distinguish returning profiles before boot writes defaults');
assert.match(host, /const TOUR_STEPS = \[/,
  'first-run onboarding must present a guided coach-mark tour');
assert.match(host, /function maybeStartFirstRunTour\(\)/,
  'the first-run tour must trigger only for new profiles');
assert.match(host, /id="replay-tour"[\s\S]*?Replay welcome tour/,
  'the tour must be replayable from Settings');
assert.match(host, /id:'files'[\s\S]*?Folder or Crate/,
  'Files remains deliberately scoped to connected Folder or Crate storage');
assert.doesNotMatch(files, /indexedDB\.open|localStorage\.setItem/,
  'Files must not silently invent a Browser-backed virtual filesystem');

console.log('NakliOS UX recovery contract: PASS');
