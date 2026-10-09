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
const { packTar } = await import(pathToFileURL(path.join(source, 'packages/experimental/webworker-runtime/lib/index.js')));
const { entryListSchema } = await import(pathToFileURL(path.join(source, 'vendor/include/lib/index.js')));
const { packVfsImage, composeProfile, configTrees, indexWorkspacePackages } = await import(pathToFileURL(path.join(source, 'packages/experimental/webworker-packer/lib/index.js')));
const rows = yaml.load(composeProfile(source, 'web'), { schema: entryListSchema });
const excluded = /(?:deepseek-llm-api-extensions|session-log-deepseek|plugin-package-inventory-deepseek|llm-deepseek(?:-account)?|desktop-product-telemetry|product-analytics|session-telemetry-otel|deepseek-account|llm-pi-ai|web-search-deepseek|ui-settings-account|account-controller)/;
function curate(entries) {
  return entries.filter(row => !excluded.test(row.id || '')).map(row => {
    if (Array.isArray(row.config)) row.config = curate(row.config);
    if (row.id === 'agent-default-model') row.config = { provider: 'naklios', model: 'shared' };
    if (row.id === 'workspace-controller') row.config = { ...row.config, documentsDirectory: '/dsh/workspace' };
    return row;
  });
}
const config = curate(rows);
config.push({ id: 'naklios-llm', name: '@naklios/dish-llm' });
const plugin = path.join(source, 'dish-plugin'); fs.mkdirSync(path.join(plugin, 'lib'), { recursive: true });
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({ name: '@naklios/dish-llm', version: '1.0.0', type: 'module', main: 'lib/index.js', exports: { '.': './lib/index.js' }, files: ['lib'], dependencies: { '@deepseek-ai/dsh-llm': '0.2.1-alpha.1' } }));
fs.copyFileSync(new URL('./provider.mjs', import.meta.url), path.join(plugin, 'lib/index.js'));
fs.copyFileSync(new URL('./protocol.mjs', import.meta.url), path.join(plugin, 'lib/protocol.mjs'));
const workspaces = indexWorkspacePackages(source); workspaces.set('@naklios/dish-llm', plugin);
const result = packVfsImage({ config: yaml.dump(config, { schema: entryListSchema }), profile: 'web', root: '/dsh', workspaces, resolveFrom: source, configTrees: configTrees(source) });
if (result.missing.length) throw new Error(`Incomplete image: ${JSON.stringify(result.missing)}`);
// Page bundles are outside the Worker's lowered-module contract. Reduce their
// parse/transfer cost without changing identifiers or the plugin roster.
const files = { ...result.files };
let inputBytes = 0, outputBytes = 0;
for (const name of result.pageBundles) {
  const original = new TextDecoder().decode(files[name]);
  const debuggerName = original.match(/\/\/# sourceURL=([^\r\n]+)\s*$/)?.[1];
  if (!debuggerName) throw new Error(`Missing client debugger name: ${name}`);
  const { code } = esbuild.transformSync(original, {
    loader: 'js', minifyWhitespace: true, minifySyntax: true,
    minifyIdentifiers: false, keepNames: true, legalComments: 'eof',
    target: 'esnext', sourcefile: name,
  });
  files[name] = new TextEncoder().encode(`${code}\n//# sourceURL=${debuggerName}\n`);
  inputBytes += result.files[name].byteLength;
  outputBytes += files[name].byteLength;
}
const image = gzipSync(packTar(files), { level: 9 });
fs.mkdirSync(path.join(output, 'preview'), { recursive: true });
fs.writeFileSync(path.join(output, 'preview/vfs-image.tar.gz'), image);
fs.writeFileSync(path.join(output, 'profile.yml'), yaml.dump(config, { schema: entryListSchema }));
fs.writeFileSync(path.join(output, 'build-metrics.json'), JSON.stringify({
  clientMinifier: `esbuild ${esbuild.version}`, clientBundles: result.pageBundles,
  clientInputBytes: inputBytes, clientOutputBytes: outputBytes, imageBytes: image.byteLength,
}, null, 2)+'\n');
console.log(`Dish image: ${image.byteLength} compressed bytes; client bundles ${inputBytes} → ${outputBytes} bytes`);
