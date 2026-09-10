import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [configSource, assetsIgnore] = await Promise.all([
  readFile(path.join(root, 'wrangler.jsonc'), 'utf8'),
  readFile(path.join(root, '.assetsignore'), 'utf8'),
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Cross-origin isolation headers ship and stay scoped to the Kiln-using app.
const headers = await readFile(path.join(root, '_headers'), 'utf8');
assert(/^\/apps\/forge\/\*$/m.test(headers), '_headers must scope COOP/COEP to /apps/forge/*');
assert(/Cross-Origin-Opener-Policy:\s*same-origin/i.test(headers), '_headers must set COOP: same-origin');
assert(/Cross-Origin-Embedder-Policy:\s*credentialless/i.test(headers), '_headers must set COEP: credentialless');
// What must not happen is site-wide ISOLATION, not a site-wide section: `558fee0` added a
// `/*` block carrying `frame-ancestors 'self'`, which is a different header doing a different
// job, and this check failed it — the deploy gate went red for a security fix that was
// correct. Read each section's own headers and object only if a catch-all carries COOP/COEP.
for (const [, section, body] of headers.matchAll(/^(\/\*|\/)\s*$\n((?:^[ \t]+\S.*$\n?)*)/gm)) {
  assert(!/Cross-Origin-(Opener|Embedder)-Policy/i.test(body),
    `_headers must not isolate the whole site via "${section}" (would break embedded cross-origin apps) — Phase 2 is a separate decision`);
}

const config = JSON.parse(configSource);
assert(config.name === 'nakli-dev', `Unexpected Worker name: ${config.name}`);
assert(config.assets?.directory === './', 'The static asset directory must be the repository root.');
assert(config.assets?.not_found_handling === '404-page', 'Unknown routes must use the 404-page policy.');

const expectedRules = [
  '.*',
  '**/.*',
  'node_modules/',
  'plan/',
  'scripts/',
  'redirects/',
  'test/',
  '**/test/',
  '**/*.test.mjs',
  '**/*.pem',
  '**/*.key',
  '*.mcp.json',
  'opencode.json',
  'prototypes/compos/relay-worker.mjs',
  'prototypes/compos/relay-worker-core.mjs',
  'prototypes/compos/wrangler.jsonc',
  'apps/forge/*.md',
  'apps/forge/forge-mockup.html',
  'wrangler.jsonc',
  'nakli-egress/',
];
const rules = assetsIgnore.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
assert(JSON.stringify(rules) === JSON.stringify(expectedRules), `Unexpected asset exclusions: ${rules.join(', ')}`);
// Forge now ships its terminal (apps/forge/index.html); only its planning
// docs (*.md) and the mockup stay excluded from delivery.

const requiredAssets = [
  'index.html',
  '_headers',
  'LICENSE',
  'sdk/naklios.js',
  'apps/manifest.json',
  'apps/manifest.lock.json',
  'apps/nakliamp/index.html',
  'apps/nakliamp/VENDOR.md',
  'apps/nakliamp/engine/nakliamp-engine.mjs',
  'apps/nakliamp/engine/reel-engine.mjs',
  'apps/nakliamp/vendor/mediabunny/LICENSE-MPL-2.0.txt',
  'apps/nakliamp/vendor/mediabunny/mediabunny-1.51.0.min.mjs',
  'vendor/localmind/host-model-catalog.js',
  'vendor/crate/v1.0.2/crate.js',
  'sys/kiln/kiln.mjs',
  'sys/rig/registry/registry.mjs',
  'prototypes/compos/index.html',
  'prototypes/compos/guide.html',
  'prototypes/compos/compos-relay.mjs',
  'prototypes/compos/setup-local-tls.sh',
  'prototypes/aimax-renderer/index.html',
  'prototypes/aimax-renderer/aimax.html',
  'prototypes/aimax-renderer/guide.html',
];
await Promise.all(requiredAssets.map(asset => access(path.join(root, ...asset.split('/')))));

console.log('PASS — NakliOS delivery policy: hidden state, plans, tests, scripts, and Forge planning files excluded');
