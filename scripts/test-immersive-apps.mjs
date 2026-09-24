import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Non-FSA apps must EMBED (Immersive iframe window), never force a browser tab.
// SDK-hosted apps embed cross-origin (decision 2026-09-24, Chirag: lift the cap on bolo, mantra, books):
// their storage and AI go through naklios.fs / naklios.ai over postMessage, so the picker block does not
// reach them. books was on the FSA-cap list until it was; it moved here.
for (const id of ['bofh', 'bolo', 'mantra', 'books']){
  const start = html.indexOf(`{ id:'${id}'`);
  const end = html.indexOf('\n  { id:', start + 1);
  assert.ok(start >= 0 && end > start, `${id} app entry exists`);
  const entry = html.slice(start, end);
  assert.doesNotMatch(
    entry,
    /maxMode:'basic'/,
    `${id} must use NakliOS's Immersive iframe window instead of forcing a browser tab`,
  );
}

// A File-System-Access app must open TOP-LEVEL (maxMode:'basic') *while it is cross-origin* —
// showDirectoryPicker() is blocked in a cross-origin iframe, so it cannot run embedded
// (decision 2026-08-27). The cap is a consequence of being cross-origin, never a goal: an app
// MIRRORED same-origin under apps/<id>/ has no such block, and capping it there would cost the
// Immersive window for nothing. Superseded in part 2026-09-10, when NakliPoster and VaultMind
// were mirrored and verified embedded with showDirectoryPicker present.
//
// So the list is DERIVED from the manifest rather than frozen: mirrored → must not be capped,
// unmirrored → must be capped. A future mirror flips its app automatically, and an app that
// loses its mirror gets its cap demanded back.
const manifest = JSON.parse(readFileSync(new URL('../apps/manifest.json', import.meta.url), 'utf8'));
const mirrored = new Set(manifest.apps.map(app => app.id));

for (const id of ['vaultmind', 'nakliposter', 'slate']){
  const start = html.indexOf(`{ id:'${id}'`);
  const end = html.indexOf('\n  { id:', start + 1);
  assert.ok(start >= 0 && end > start, `${id} app entry exists`);
  const entry = html.slice(start, end);
  if (mirrored.has(id)) {
    assert.doesNotMatch(
      entry,
      /maxMode:'basic'/,
      `${id} is mirrored same-origin, so FSA works embedded — the top-level cap is obsolete for it`,
    );
    assert.match(entry, /embedUrl:'\.\/apps\//, `${id} is mirrored, so it must embed relatively`);
  } else {
    assert.match(
      entry,
      /maxMode:'basic'/,
      `${id} is a CROSS-ORIGIN FSA app — it must open top-level (maxMode:'basic'), not embedded`,
    );
  }
}

assert.match(
  html,
  /if \(m === 'immersive'\)[\s\S]*?return spawnIframeWindow\(app, options\);/,
  'Immersive apps must launch in NakliOS iframe windows',
);
assert.match(
  html,
  /\.nw-body\.has-iframe\s*\{\s*overflow:\s*hidden/,
  'iframe windows must not add a redundant host scrollbar',
);
assert.match(
  html,
  /body\.classList\.add\('has-iframe'\)/,
  'iframe windows mark their host body for overflow control',
);
assert.match(
  html,
  /iframe\.addEventListener\('load',\s*\(\)\s*=>\s*\{\s*markIframeLaunchPhase\(win,\s*'loaded'\)/,
  'iframe load reveals apps without waiting for a cooperative ready signal',
);
assert.match(
  html,
  /msg\.type\s*===\s*'naklios:ready'[\s\S]*?const win = findWin\(\)[\s\S]*?markIframeLaunchPhase\(win,\s*'ready'\)/,
  'cooperative ready signals still reveal apps before iframe load',
);
assert.doesNotMatch(
  html,
  /setTimeout\(\(\)\s*=>\s*skel\.remove\(\),\s*5000\)/,
  'iframe apps do not remain hidden behind the old fixed five-second cover',
);
assert.match(
  html,
  /scrollbar-color:[^;]*var\(--brand\)/,
  'NakliOS-owned scroll areas use the active theme',
);

console.log('NakliOS Immersive BOFH-embed + FSA-apps-top-level contract: PASS');

// A recording app embedded needs the powers a cross-origin iframe lacks by default; the host grants
// exactly what the catalog names, and never to a user-installed (opaque) app.
{
  const start = html.indexOf(`{ id:'bolo'`);
  const entry = html.slice(start, html.indexOf('\n  { id:', start + 1));
  assert.match(entry, /iframeAllow:'camera; microphone; display-capture'/, 'bolo asks for camera, mic and screen capture');
  assert.match(html, /if \(app\.iframeAllow && !forceOpaqueSandbox\) iframe\.setAttribute\('allow', app\.iframeAllow\);/, 'the host applies it, catalog apps only');
}

