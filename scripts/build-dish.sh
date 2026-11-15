#!/usr/bin/env bash
# Rebuild the pinned upstream products, then apply the tracked Dish integration.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SOURCE=${1:?Usage: bash scripts/build-dish.sh /path/to/extracted-upstream (see scripts/dish/fetch-source.sh)}
# scripts/dish/source.lock.json is the one record of the upstream ref (scripts/dish/pin.mjs writes it).
export DSH_CLIENT_COMMIT_HASH=$(node -p "require('$ROOT/scripts/dish/source.lock.json').commit")
export DSH_CLIENT_TITLE=Dish
node "$ROOT/scripts/dish/verify-source.mjs" "$SOURCE"
# The allow-listed third-party plugins (scripts/dish/plugins.json), each verified by its npm integrity hash.
node "$ROOT/scripts/dish/fetch-plugins.mjs" "$SOURCE"
cd "$SOURCE"
# Upstream's own step runner (dsh-v0.2.2+): Typert declarations from source, then the host compiler and bundle,
# then the client compiler. The Typert pass writes the `@deepseek-ai/*/remote` declarations the client needs;
# a bare `tsc -b` misses them. The host type build ran out of memory at 4 GB (2026-10-31), so every step gets 8 GB.
# Dish skips the Desktop bundle (no Electron app here).
export NODE_OPTIONS="--max-old-space-size=8192"
node --import tsx/esm scripts/compile-referenced-projects.ts host-libraries
node --import tsx/esm scripts/compile-referenced-projects.ts client
node node_modules/tsdown/dist/run.mjs --config-loader native --env.DSH_BUILD_FACE client
unset NODE_OPTIONS
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
