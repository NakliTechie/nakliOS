// Narrow host services for named mirrors (2026-11-15, for Gupshup; Lectella has the same need).
// A same-origin mirror listed with hostServices:['web'] or ['skills'] gets that one service, and
// nothing kind:'system' would add (the whole store, naklios.net egress).
//
// Runs the real appHasHostService, aiAppOwnsEgress and aiAppOwnsSystemFs from index.html
// against a fake catalog.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractFunction, evaluate } from './anvil-harness.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const src = ['appExpectedOrigin', 'appHasHostService', 'aiAppOwnsEgress', 'aiAppOwnsSystemFs']
  .map((name) => extractFunction(html, name)).join('\n');
const servicesLine = html.match(/const APP_HOST_SERVICES = new Set\([^)]*\);/)[0];

const APPS = [
  { id: 'gupshup', url: './apps/gupshup/', embedUrl: './apps/gupshup/', hostServices: ['web', 'skills'] },
  { id: 'lectella', url: './apps/lectella/', embedUrl: './apps/lectella/' },
  { id: 'remote', url: 'https://remote.example/', hostServices: ['web'] },
  { id: 'third', url: './apps/third/', thirdParty: true, hostServices: ['web'] },
  { id: 'odd', url: './apps/odd/', hostServices: ['net', 'sysfs'] },
  { id: 'dish', url: './apps/dish/', kind: 'system' },
];
const fns = evaluate(`${servicesLine}\n${src}\n;({ appHasHostService, aiAppOwnsEgress, aiAppOwnsSystemFs })`, {
  APPS, URL, location: { href: 'https://naklios.dev/', origin: 'https://naklios.dev' },
});

assert.equal(fns.appHasHostService('gupshup', 'web'), true, 'a named same-origin mirror gets web');
assert.equal(fns.appHasHostService('gupshup', 'skills'), true, 'and skills');
assert.equal(fns.aiAppOwnsEgress('gupshup'), false, 'but not naklios.net egress');
assert.equal(fns.aiAppOwnsSystemFs('gupshup'), false, 'and not the whole store');
assert.equal(fns.appHasHostService('lectella', 'web'), false, 'an unlisted mirror gets nothing');
assert.equal(fns.appHasHostService('remote', 'web'), false, 'a cross-origin app is refused even when listed');
assert.equal(fns.appHasHostService('third', 'web'), false, 'a third-party app is refused even when listed');
assert.equal(fns.appHasHostService('odd', 'net'), false, 'only the named services exist');
assert.equal(fns.appHasHostService('odd', 'sysfs'), false);
assert.equal(fns.appHasHostService('missing', 'web'), false);
assert.equal(fns.aiAppOwnsEgress('dish'), true, 'system apps keep what they had');

// The call sites use it: web service, the capability and the skills library.
assert.match(html, /if \(!aiAppOwnsEgress\(appId\) && !appHasHostService\(appId, 'web'\)\) throw/);
assert.match(html, /experimental_web:aiAppOwnsEgress\(appId\) \|\| appHasHostService\(appId, 'web'\)/);
assert.match(html, /if \(!aiAppOwnsSystemFs\(appId\) && !appHasHostService\(appId, 'skills'\)\) throw/);
// naklios.net stays system-only.
assert.match(html, /if \(!aiAppOwnsEgress\(appId\)\) throw new Error\('Egress is available to same-origin system apps only'\)/);

console.log('test-app-host-services: ok');
