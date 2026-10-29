import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
const source = process.env.DISH_SOURCE_ROOT;
const output = process.env.DISH_OUTPUT_ROOT;
if (!source || !output) throw new Error('DISH_SOURCE_ROOT and DISH_OUTPUT_ROOT are required');
const req = createRequire(path.join(source, 'package.json'));
// Reuse the exact esbuild installed by upstream's frozen tsx dependency.
const esbuild = createRequire(req.resolve('tsx/package.json'))('esbuild');
const yaml = req('js-yaml');
const lib = rel => import(pathToFileURL(path.join(source, rel, 'lib/index.js')));
const { packTar, PLATFORM_ENTRY_CONFIG } = await lib('packages/experimental/webworker-runtime');
const { entryListSchema } = await lib('vendor/include');
const appBoot = await lib('packages/boot/app-boot');
const { packVfsImage, collectModuleNames, configTrees, indexWorkspacePackages, installationManifest, MANIFEST_PATH } = await lib('packages/experimental/webworker-packer');

// The Worker composes the profile at boot from the shipped template's bundle
// layers plus the home patch. Compose the same bundle layers here, so Dish's
// curation is expressed as home-patch rows over exactly what the Worker sees.
const PROFILE = 'web';
const installation = installationManifest(source);
const bundles = appBoot.PROFILE_TEMPLATES[PROFILE].bundles;
const bundlePatches = bundles.flatMap(bundle => {
  const dir = appBoot.resolveBundleDir('dish-pack', bundle, installation.manifest, path.join(source, 'apps/cli'));
  const declaration = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).dsh?.bundle;
  if (!declaration) throw new Error(`Bundle ${bundle} declares no dsh.bundle`);
  return appBoot.bundlePatchPaths(dir, declaration).flatMap(file => appBoot.loadOverlayPatches('dish-pack', file));
});
const composed = appBoot.composeEntries([bundlePatches]);
const findRow = (rows, id) => {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.id === id) return row;
    const nested = findRow(row.config, id); if (nested) return nested;
  }
};

const excluded = /(?:deepseek-llm-api-extensions|session-log-deepseek|plugin-package-inventory-deepseek|llm-deepseek(?:-account)?|desktop-product-telemetry|product-analytics|session-telemetry-otel|deepseek-account|llm-pi-ai|web-search-deepseek|ui-settings-account|account-controller)/;
const packageOf = name => name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
const removedPackages = new Set();
const retainedPackages = new Set();
const disabledIds = [];
(function curate(rows) {
  for (const row of Array.isArray(rows) ? rows : []) {
    const pkg = typeof row.name === 'string' && (row.name.startsWith('@') || row.name.includes('/')) ? packageOf(row.name) : undefined;
    if (excluded.test(row.id || '')) { disabledIds.push(row.id); if (pkg) removedPackages.add(pkg); continue; }
    if (pkg) retainedPackages.add(pkg);
    curate(row.config);
  }
})(composed);

// A patch replaces a row's whole config, so a configured row keeps its composed fields.
const configured = (id, fields) => {
  const row = findRow(composed, id);
  if (!row) throw new Error(`Profile ${PROFILE} has no row ${id}`);
  const base = row.config && typeof row.config === 'object' && !Array.isArray(row.config) ? row.config : {};
  return { id, config: { ...base, ...fields } };
};
const homePatch = [
  ...disabledIds.map(id => ({ id, disabled: true })),
  // The Worker's own required fields (plaintext JSONL sessions), as upstream's packer writes them.
  ...Object.entries(PLATFORM_ENTRY_CONFIG).filter(([id]) => findRow(composed, id)).map(([id, fields]) => configured(id, fields)),
  { id: 'agent-default-model', config: { provider: 'naklios', model: 'shared' } },
  configured('workspace-controller', { documentsDirectory: '/dsh/workspace' }),
  { insert: [{ id: 'naklios-llm', name: '@naklios/dish-llm' }] },
];

// Materialize the template's bundles and the packages their rows name. Dish
// offers no optional bundles, so upstream's profileRoster (template plus every
// optional bundle) would only add bytes the profile never mounts.
const names = new Set(bundles); collectModuleNames(bundlePatches, names);
const roster = [...names].filter(name => !removedPackages.has(name) || retainedPackages.has(name));
roster.push('@naklios/dish-llm');

const dshVersion = JSON.parse(fs.readFileSync(path.join(source, 'packages/llm/llm/package.json'), 'utf8')).version;
const plugin = path.join(source, 'dish-plugin'); fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: '@naklios/dish-llm', version: '1.0.0', type: 'module', main: 'lib/index.js', exports: { '.': './lib/index.js' }, files: ['lib'], dependencies: { '@deepseek-ai/dsh-llm': dshVersion } }));
fs.copyFileSync(new URL('./provider.mjs', import.meta.url), path.join(plugin, 'lib/index.js'));
fs.copyFileSync(new URL('./protocol.mjs', import.meta.url), path.join(plugin, 'lib/protocol.mjs'));
const workspaces = indexWorkspacePackages(source); workspaces.set('@naklios/dish-llm', plugin);
const result = packVfsImage({ profile: PROFILE, roster, installation, root: '/dsh', workspaces, resolveFrom: source, configTrees: configTrees(source), homePatch });
if (result.missing.length) throw new Error(`Incomplete image: ${JSON.stringify(result.missing)}`);

const files = { ...result.files };
// The reachability sweep keeps every collected page asset, including
// client-only plugins excluded from our profile. Remove only excluded page
// bundles and lazy chunks, preserving host modules and package licenses.
const excludedAsset = name => [...removedPackages].some(pkg => !retainedPackages.has(pkg) && name.startsWith(`node_modules/${pkg}/`));
const removedClientBundles = result.pageBundles.filter(excludedAsset);
for (const name of removedClientBundles) delete files[name];
const lazyArchives = result.lazyArchives.filter(archive => !archive.files.every(excludedAsset));
const removedLazyChunks = result.lazyArchives.filter(archive => !lazyArchives.includes(archive)).flatMap(archive => archive.files);
const manifest = JSON.parse(new TextDecoder().decode(files[MANIFEST_PATH]));
manifest.lazy = manifest.lazy.filter(entry => lazyArchives.some(archive => archive.name === entry.archive));
files[MANIFEST_PATH] = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);

// Page bundles are outside the Worker's lowered-module contract. Reduce their
// parse/transfer cost without changing the plugin roster or reflected names.
// Lazy chunks stay verbatim: the manifest records their sizes and digests.
const clientBundles = result.pageBundles.filter(name => !removedClientBundles.includes(name));
let inputBytes = 0, outputBytes = 0;
for (const name of clientBundles) {
  const original = new TextDecoder().decode(files[name]);
  const debuggerName = original.match(/\/\/# sourceURL=([^\r\n]+)\s*$/)?.[1];
  if (!debuggerName) throw new Error(`Missing client debugger name: ${name}`);
  const { code } = esbuild.transformSync(original, {
    loader: 'js', minifyWhitespace: true, minifySyntax: true,
    // Settings bundles reflect lexical binding names beyond Function.name.
    minifyIdentifiers: false, keepNames: true, legalComments: 'eof',
    target: 'esnext', sourcefile: name,
  });
  files[name] = new TextEncoder().encode(`${code}\n//# sourceURL=${debuggerName}\n`);
  inputBytes += result.files[name].byteLength;
  outputBytes += files[name].byteLength;
}
const image = gzipSync(packTar(files), { level: 9 });
image[9] = 255; // gzip OS byte "unknown", as upstream's packer writes it, so the image does not depend on the build host.
fs.mkdirSync(path.join(output, 'preview/lazy'), { recursive: true });
fs.writeFileSync(path.join(output, 'preview/vfs-image.tar.gz'), image);
// Lazy archive names are relative to the base image, which the Worker resolves them against.
for (const archive of lazyArchives) fs.writeFileSync(path.join(output, 'preview', archive.name), archive.image);
const dump = rows => yaml.dump(rows, { schema: entryListSchema, noRefs: true });
// profile.yml records the composition the Worker boots before any user layer, for review and tests.
fs.writeFileSync(path.join(output, 'profile.yml'), dump(appBoot.composeEntries([bundlePatches, homePatch])));
fs.writeFileSync(path.join(output, 'build-metrics.json'), JSON.stringify({
  clientMinifier: `esbuild ${esbuild.version}`, roster, disabledIds, clientBundles, removedClientBundles,
  lazyChunks: lazyArchives.flatMap(archive => archive.files), removedLazyChunks,
  clientInputBytes: inputBytes, clientOutputBytes: outputBytes, imageBytes: image.byteLength,
  lazyBytes: lazyArchives.reduce((sum, archive) => sum + archive.image.byteLength, 0),
}, null, 2)+'\n');
console.log(`Dish image: ${image.byteLength} compressed bytes; ${lazyArchives.length} lazy archives; client bundles ${inputBytes} → ${outputBytes} bytes`);
