import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const standard = readFileSync(new URL('../docs/third-party-apps-v1.md', import.meta.url), 'utf8');
const example = JSON.parse(readFileSync(
  new URL('../docs/examples/third-party-app.json', import.meta.url),
  'utf8',
));

for (const [index, match] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
  assert.doesNotThrow(() => new Function(match[1]), `inline NakliOS script ${index + 1} parses`);
}

const validatorStart = html.indexOf("const THIRD_PARTY_SCHEMA =");
const validatorEnd = html.indexOf('function loadThirdPartyAppRecords', validatorStart);
assert.ok(validatorStart >= 0 && validatorEnd > validatorStart, 'validator source is discoverable');
const validatorSource = html.slice(validatorStart, validatorEnd);
const validator = new Function(
  `${validatorSource}; return { normalizeThirdPartyManifest, newThirdPartyAppId };`,
)();

const valid = validator.normalizeThirdPartyManifest(example);
assert.equal(valid.schema, 'https://naklios.dev/app-manifest/v1');
assert.equal(valid.origin, 'https://example.com');
assert.equal(valid.display, 'window');
assert.deepEqual([...valid.permissions], ['storage']);
assert.ok(Object.isFrozen(valid), 'normalized manifests are immutable');

const invalid = (patch, pattern) => assert.throws(
  () => validator.normalizeThirdPartyManifest({ ...example, ...patch }),
  pattern,
);
invalid({ schema:'https://naklios.dev/app-manifest/v2' }, /schema/);
invalid({ surprise:true }, /Unknown manifest field/);
invalid({ id:'Bad App' }, /id/);
invalid({ version:'latest' }, /version/);
invalid({ version:`1.0.0-${'x'.repeat(64)}` }, /version/);
invalid({ url:'http://example.com/' }, /HTTPS/);
invalid({ url:'https://user:secret@example.com/' }, /credentials/);
invalid({ description:{ text:'not plain' } }, /description/);
invalid({ icon:['x'] }, /icon/);
invalid({ icon:'' }, /icon/);
invalid({ icon:'<svg>' }, /icon/);
invalid({ permissions:['storage', 'storage'] }, /permissions/);
invalid({ permissions:['host-native'] }, /permissions/);
invalid({ display:'system' }, /display/);
invalid({ display:'tab', permissions:['storage'] }, /host permissions require display "window"/);
invalid({ display:'tab', permissions:['inference'] }, /host permissions require display "window"/);
assert.deepEqual(
  [...validator.normalizeThirdPartyManifest({ ...example, permissions:['inference', 'storage'] }).permissions],
  ['inference', 'storage'],
);
assert.equal(
  validator.normalizeThirdPartyManifest({ ...example, url:'http://localhost:4173/' }).origin,
  'http://localhost:4173',
  'localhost HTTP remains available for development',
);
const firstInstallId = validator.newThirdPartyAppId();
const secondInstallId = validator.newThirdPartyAppId();
assert.match(firstInstallId, /^thirdparty-[0-9a-f]{32}$/);
assert.notEqual(firstInstallId, secondInstallId, 'new installations receive random 128-bit namespaces');

assert.match(html, /const forceOpaqueSandbox = app\.thirdParty === true/);
assert.match(
  html,
  /if \(forceOpaqueSandbox\)[\s\S]*?setAttribute\('sandbox', 'allow-scripts allow-popups allow-forms allow-downloads'\)/,
  'third-party sandbox permits no same-origin escape',
);
const opaqueTokens = html.match(
  /if \(forceOpaqueSandbox\)[\s\S]*?setAttribute\('sandbox', '([^']+)'\)/,
)?.[1] || '';
assert.doesNotMatch(opaqueTokens, /allow-same-origin/, 'opaque third-party sandbox excludes allow-same-origin');
assert.match(
  html,
  /app\?\.thirdParty && !\(app\.permissions \|\| \[\]\)\.includes\('storage'\)\) return null/,
  'undeclared storage is rejected before the permission flow',
);
assert.match(
  html,
  /const manifestAllowsStorage = !app\?\.thirdParty \|\| \(app\.permissions \|\| \[\]\)\.includes\('storage'\)/,
  'capability advertisements honor the installed manifest',
);
assert.match(
  html,
  /return !app\?\.thirdParty \|\| \(app\.permissions \|\| \[\]\)\.includes\('inference'\)/,
  'inference capability advertisements honor the installed manifest',
);
assert.match(
  html,
  /credentials:'omit'[\s\S]*?cache:'no-store'[\s\S]*?redirect:'error'[\s\S]*?referrerPolicy:'no-referrer'/,
  'remote manifest checks do not send ambient credentials or follow redirects',
);
assert.match(html, /THIRD_PARTY_MANIFEST_MAX_BYTES = 32768/);
assert.match(
  html,
  /response\.body\?\.getReader\(\)[\s\S]*?receivedBytes \+= value\.byteLength[\s\S]*?receivedBytes > THIRD_PARTY_MANIFEST_MAX_BYTES[\s\S]*?reader\.cancel\(\)/,
  'remote manifests are byte-limited while streaming, before the full body is buffered',
);
assert.match(html, /existing\.manifest\.origin !== manifest\.origin/);
assert.match(html, /!sameStringList\(existing\.manifest\.permissions, manifest\.permissions\)/);
assert.match(
  html,
  /if \(review\.originChanged\)[\s\S]*?purgeLayoutAppId\(review\.existing\.appId\)[\s\S]*?delete state\.appPermissions\[review\.existing\.appId\]/,
  'origin change does not inherit layout identity or a host storage grant',
);
assert.match(
  html,
  /else if \(review\.permissionsChanged\)[\s\S]*?delete state\.appPermissions\[review\.existing\.appId\]/,
  'permission changes revoke the previous runtime decision',
);
assert.match(
  html,
  /const appId = review\.existing && !review\.originChanged[\s\S]*?: newThirdPartyAppId\(\)/,
  'new installs and origin changes receive fresh random namespaces',
);
assert.match(
  html,
  /if \(!review\.existing \|\| review\.originChanged\)\{[\s\S]*?delete state\.appPermissions\[appId\]/,
  'a new profile-local registration cannot inherit a restored permission decision',
);
assert.match(html, /delete state\.aiPermissions\[review\.existing\.appId\]/);
assert.match(html, /delete state\.aiPermissions\[appId\]/);
assert.match(
  html,
  /'May ask for app-scoped Folder or Crate storage\. NakliOS asks again on first use\.'/,
  'storage consent names Folder or Crate and the first-use prompt',
);
assert.match(html, /dlg\.setAttribute\('aria-labelledby', titleId\)/);
assert.match(html, /dlg\.setAttribute\('aria-label', 'NakliOS dialog'\)/);
assert.match(html, /id="third-party-add"[\s\S]*?>＋ Add app from manifest…</);
assert.match(html, /class="third-party-uninstall"/);
assert.match(html, /class="third-party-update"/);
assert.match(html, /User-installed third-party app/);

const uninstallStart = html.indexOf('async function uninstallThirdPartyApp');
const uninstallEnd = html.indexOf('// ═', uninstallStart);
const uninstallSource = html.slice(uninstallStart, uninstallEnd);
assert.match(uninstallSource, /Its Folder, Crate, and origin data will not be deleted/);
assert.doesNotMatch(
  uninstallSource,
  /BACKENDS\.|fsDelete|crateDelete|\.delete\(/,
  'uninstall removes registration and layout only, never app data',
);

for (const phrase of [
  'opaque origin',
  'origin change creates a new',
  'does not auto-update',
  'Accessibility and acceptance',
  'naklios.ready()',
  'naklios.beforeClose',
  'no implicit copy',
  '`inference`',
  'lacks `allow-same-origin`',
]) {
  assert.match(standard, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
}

console.log('NakliOS third-party app manifest, sandbox, consent, and uninstall contract: PASS');
