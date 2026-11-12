import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

for (const retiredId of [
  // bahi: back in the catalog 2026-11-12 (Chirag: \"bahi into the catalog\"), replacing the 2026-07-28 exclusion.
  'fretlocal',
  'clacker',
  'mechanikon',
  'antikythera',
  'calendars',
  'karkhana',
  'tapasya',
  'dotspin',
  'hueandcry',
  'predmkt',
  'callib',
]) {
  assert.doesNotMatch(
    html,
    new RegExp(`id:'${retiredId}'`),
    `${retiredId} must not be present in the NakliOS app catalog`,
  );
  assert.doesNotMatch(
    html,
    new RegExp(`apps:\\[[^\\]]*'${retiredId}'`),
    `${retiredId} must not remain in a NakliOS desktop folder`,
  );
}

for (const [id, name] of [
  ['fld-essentials', 'Essentials'],
  ['fld-create', 'Create & Convert'],
  ['fld-research', 'Think & Research'],
  ['fld-work', 'Work & Build'],
  ['fld-privacy', 'Privacy & Security'],
  ['fld-games', 'Play'],
  ['fld-learn', 'Learn'],
]) {
  assert.match(html, new RegExp(`id:'${id}'[\\s\\S]*?name:'${name}'`),
    `${name} task folder must be present`);
}
assert.match(
  html,
  /id:'fld-create'[\s\S]*?apps:\[[^\]]*'rangrez'/,
  'Rangrez remains available under Create & Convert',
);
assert.doesNotMatch(
  html,
  /id:'fld-(?:fun|utilities)'/,
  'legacy portfolio-style folders must not return',
);
assert.match(
  html,
  /state\.layout\.pinned = \['files','notes','notepad','books'\]/,
  'new profiles pin the four Essentials apps',
);
assert.match(
  html,
  /const DEFAULT_DESKTOP_APP_IDS = Object\.freeze\(\[\s*'books',\s*'nakliposter',\s*'bofh',\s*'naklidata',\s*'tijori',\s*'files',\s*'anvil',\s*'dish',\s*'pi',\s*\]\)/,
  'core apps, storage utilities and the three coding agents are first-party desktop defaults',
);
assert.match(
  html,
  /const DESKTOP_DEFAULTS_VERSION = 5/,
  'existing desktops receive each expanded shortcut set once',
);
{
  // Run the migration itself: a version-4 desktop loses the four retired defaults and gains Dish and Pi,
  // a user's own pull-outs stay, and a migrated layout is left alone afterwards.
  const pick = re => { const m = html.match(re); assert.ok(m, `missing ${re}`); return m[0]; };
  const source = [
    pick(/const DEFAULT_DESKTOP_APP_IDS = Object\.freeze\(\[[\s\S]*?\]\);/),
    pick(/const DESKTOP_DEFAULTS_VERSION = \d+;/),
    pick(/const DESKTOP_DEFAULTS_RETIRED = Object\.freeze\(\{[\s\S]*?\}\);/),
    pick(/function applyDesktopDefaults\(layout\)\{[\s\S]*?\n\}/),
  ].join('\n');
  const applyDesktopDefaults = new Function(`${source}\nreturn applyDesktopDefaults;`)();
  const v4 = { desktopDefaultsVersion: 4, unfoldered: ['books', 'mod', 'notes', 'abhyas', 'chapters', 'anvil', 'reckon'] };
  assert.equal(applyDesktopDefaults(v4), true);
  for (const id of ['mod', 'notes', 'abhyas', 'chapters']) assert.ok(!v4.unfoldered.includes(id), `${id} returns to its folder`);
  for (const id of ['dish', 'pi', 'reckon', 'books']) assert.ok(v4.unfoldered.includes(id), `${id} is on the desktop`);
  assert.equal(v4.desktopDefaultsVersion, 5);
  v4.unfoldered.push('mod');
  assert.equal(applyDesktopDefaults(v4), false, 'a migrated layout is not migrated again');
  assert.ok(v4.unfoldered.includes('mod'), 'a pull-out made after the migration stays');
  const fresh = {};
  applyDesktopDefaults(fresh);
  assert.deepEqual([...fresh.unfoldered].sort(), ['anvil', 'bofh', 'books', 'dish', 'files', 'naklidata', 'nakliposter', 'pi', 'tijori']);
}
assert.match(
  html,
  /function applyDesktopDefaults\(layout\)[\s\S]*?layout\.unfoldered\.push\(appId\)[\s\S]*?layout\.desktopDefaultsVersion = DESKTOP_DEFAULTS_VERSION/,
  'desktop defaults carry a one-time migration version in the layout',
);
assert.match(
  html,
  /state\.layout = sanitizeLayout\(remote\.layout\)[\s\S]*?applyDesktopDefaults\(state\.layout\)/,
  'older Folder-backed layouts receive the desktop-default migration too',
);
assert.match(
  html,
  /id:'naklidata'[\s\S]*?url:'https:\/\/naklidata\.naklitechie\.com\/'[\s\S]*?opensInNewTab:true[\s\S]*?desktopAlign:'right', desktopOrder:6/,
  'NakliData launches top-level and occupies the seventh right-side desktop slot',
);
assert.match(
  html,
  /id:'calendar'[\s\S]*?kind:'system'[\s\S]*?url:'\.\/apps\/calendar\/'[\s\S]*?embedUrl:'\.\/apps\/calendar\/'/,
  'Calendar is a bundled system app',
);
assert.match(
  html,
  /id:'fld-essentials'[\s\S]*?apps:\['files','notes','calendar','notepad','books','calculator'\]/,
  'Calendar has one predictable home in Essentials',
);
assert.match(
  html,
  /id:'editor'[\s\S]*?kind:'system'[\s\S]*?url:'\.\/apps\/editor\/'[\s\S]*?embedUrl:'\.\/apps\/editor\/'/,
  'Editor is a bundled system app',
);
// Same-origin embed, either spelling: `./apps/<id>/` and `https://naklios.dev/apps/<id>/` both
// resolve to /apps/<id>/. Relative is the house default because it is what makes a mirrored app
// verifiable on a LOCAL serve before deploy (plan/history.md 2026-09-09, 2026-09-10).
assert.match(html, /id:'reel'[\s\S]*?url:'\.\/apps\/reel\/'/, 'Reel opens from NakliOS (NakliOS-only since 2026-11-12)');
const reelEmbed = html.match(/id:'reel'[\s\S]*?embedUrl:'([^']+)'/);
assert.ok(reelEmbed && ['./apps/reel/', 'https://naklios.dev/apps/reel/'].includes(reelEmbed[1]),
  `Reel uses a same-origin Immersive mirror (got ${reelEmbed && reelEmbed[1]})`);
// Same-origin embed, either spelling. `./apps/<id>/` and `https://naklios.dev/apps/<id>/` both
// resolve to /apps/<id>/ for the inventory audit; the relative form additionally works on a
// local serve, which is what makes a mirrored app verifiable before deploy (Menagerie set this
// precedent, plan/history.md 2026-09-09). Pinning the absolute spelling made this test fail on
// a change that strictly improved the property it guards.
assert.match(html, /id:'nakliamp'[\s\S]*?url:'\.\/apps\/nakliamp\/'/,
  'NakliAmp opens from NakliOS (NakliOS-only since 2026-11-12)');
const ampEmbed = html.match(/id:'nakliamp'[\s\S]*?embedUrl:'([^']+)'/);
assert.ok(ampEmbed && ['./apps/nakliamp/', 'https://naklios.dev/apps/nakliamp/'].includes(ampEmbed[1]),
  `NakliAmp uses a same-origin Immersive mirror (got ${ampEmbed && ampEmbed[1]})`);
assert.match(
  html,
  /id:'fld-games'[\s\S]*?apps:\['reel','nakliamp'/,
  'Reel and NakliAmp have one predictable home under Play',
);
assert.match(
  html,
  /id:'fld-work'[\s\S]*?apps:\['editor','forge','anvil','dish','pi','kanzen','nakliposter','bofh','mod','naklidata','nemawashi','menagerie','bahi'\]/,
  'Editor, Forge, Anvil, Dish and Pi have predictable homes in Work & Build',
);
assert.match(
  html,
  /function getDesktopItems\(\)[\s\S]*?for \(const folder of FOLDERS\)[\s\S]*?if \(isInFolder\(app\.id\)\) continue/,
  'the desktop is task folders plus default or deliberate app pull-outs',
);

const appsBlock = html.slice(html.indexOf('const APPS = ['), html.indexOf('const FOLDERS = ['));
const foldersBlock = html.slice(html.indexOf('const FOLDERS = ['), html.indexOf('// Build a Set of all app ids'));
const activeAppIds = [...appsBlock.matchAll(/\{ id:'([^']+)'/g)].map(match => match[1]);
for (const appId of activeAppIds) {
  const homes = [...foldersBlock.matchAll(new RegExp(`'${appId}'`, 'g'))];
  assert.equal(homes.length, 1, `${appId} must have exactly one task-folder home`);
}

assert.match(
  html,
  /function sanitizeLayout\(layout\)[\s\S]*?filterMap\('positions', itemIds\)[\s\S]*?filterMap\('windowPositions', appIds\)/,
  'saved layouts discard orphaned desktop and window positions',
);
assert.match(
  html,
  /layout: sanitizeLayout\(JSON\.parse\(localStorage\.getItem\(LS_KEY\.layout\)/,
  'local saved layouts are sanitized on startup',
);
assert.match(
  html,
  /state\.layout = sanitizeLayout\(remote\.layout\)/,
  'newer folder-backed layouts are sanitized before hydration',
);

console.log('NakliOS app catalog exclusions: PASS');

assert.match(html, /id:'bahi'[\s\S]*?url:'https:\/\/bahi\.naklitechie\.com\/'[\s\S]*?opensInNewTab:true/, 'Bahi opens its own site in a tab, because its file pickers are blocked in a cross-origin frame');
