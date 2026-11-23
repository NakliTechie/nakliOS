// Build sys/emergic-rules/emergic-rules.wasm from the wrapper crate, and record where it came from.
//   node scripts/build-emergic-rules.mjs          rebuild, then write emergic-rules.wasm and build.json
//   node scripts/build-emergic-rules.mjs --check  rebuild and exit 1 if the committed wasm differs
// Needs cargo with the wasm32-unknown-unknown target and read access to atrium-solutions/emergic-app.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../sys/emergic-rules/', import.meta.url));
const crate = dir + 'crate';
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], {
  cwd: crate, stdio: 'inherit', env: { ...process.env, CARGO_NET_GIT_FETCH_WITH_CLI: 'true' },
});
const built = readFileSync(crate + '/target/wasm32-unknown-unknown/release/emergic_rules_wasm.wasm');
const sha = createHash('sha256').update(built).digest('hex');
const rev = /rev = "([0-9a-f]+)"/.exec(readFileSync(crate + '/Cargo.toml', 'utf8'))[1];
if (process.argv.includes('--check')) {
  const committed = existsSync(dir + 'emergic-rules.wasm') ? createHash('sha256').update(readFileSync(dir + 'emergic-rules.wasm')).digest('hex') : '';
  if (committed !== sha) { console.error(`emergic-rules.wasm is stale: committed ${committed.slice(0, 12)}, built ${sha.slice(0, 12)}`); process.exit(1); }
  console.log(`emergic-rules.wasm matches its sources (${sha.slice(0, 12)})`);
} else {
  writeFileSync(dir + 'emergic-rules.wasm', built);
  writeFileSync(dir + 'build.json', JSON.stringify({ crate: 'atrium-solutions/emergic-app src-tauri/crates/emergic-rules', rev, bytes: built.length, sha256: sha }, null, 2) + '\n');
  console.log(`sys/emergic-rules/emergic-rules.wasm: ${built.length} bytes, sha256 ${sha.slice(0, 12)}, crate rev ${rev}`);
}
