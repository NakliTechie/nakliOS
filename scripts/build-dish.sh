#!/usr/bin/env bash
# Rebuild the pinned upstream products, then apply the tracked Dish integration.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE=${1:?Usage: bash scripts/build-dish.sh /path/to/extracted-upstream}
export DSH_CLIENT_COMMIT_HASH=5badb15009ae1756c3afe0ae0cef1faafc290ccc
export DSH_CLIENT_TITLE=Dish
node "$ROOT/scripts/dish/verify-source.mjs" "$SOURCE"
cd "$SOURCE"
# Install with: pnpm install --frozen-lockfile --ignore-scripts
node node_modules/typescript/bin/tsc -b tsconfig.host.json
node node_modules/tsdown/dist/run.mjs --config-loader native --env.DSH_BUILD_FACE host
node node_modules/typescript/bin/tsc -b tsconfig.client.json
node node_modules/tsdown/dist/run.mjs --config-loader native --env.DSH_BUILD_FACE client
python3 "$ROOT/scripts/dish/prepare.py" "$SOURCE"
cd packages/experimental/webworker-runtime
node ../../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node ../../../node_modules/tsdown/dist/run.mjs --config-loader native
cd "$SOURCE/apps/web"
node ../../node_modules/vite/bin/vite.js build
# Replace generated directories so previous hashed bundles cannot survive a rebuild.
rm -rf "$ROOT/apps/dish/assets" "$ROOT/apps/dish/preview"
# Preserve our source adapters; copy only built distribution assets.
cp -R dist/assets "$ROOT/apps/dish/"
cp -R dist/preview "$ROOT/apps/dish/"
cp dist/favicon.svg dist/favicon-dark.svg dist/manifest.webmanifest "$ROOT/apps/dish/"
cp dist/preview.html "$ROOT/apps/dish/index.html"
cp "$SOURCE/LICENSE" "$ROOT/apps/dish/LICENSE-upstream"
export DISH_SOURCE_ROOT="$SOURCE"
export DISH_OUTPUT_ROOT="$ROOT/apps/dish"
cd "$SOURCE"
node "$ROOT/scripts/dish/pack.mjs"
node "$ROOT/scripts/dish/finalize.mjs"
node "$ROOT/scripts/dish/provenance.mjs"
