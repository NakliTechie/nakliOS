#!/usr/bin/env bash
# Download the pinned upstream release into an empty directory, verify it, and install its dependencies.
# Usage: bash scripts/dish/fetch-source.sh /path/to/empty-dir   (prints the extracted tree on the last line)
set -euo pipefail
LOCK=$(cd "$(dirname "$0")" && pwd)/source.lock.json
DEST=${1:?Usage: bash scripts/dish/fetch-source.sh /path/to/empty-dir}
TAG=$(node -p "require('$LOCK').tag")
SHA=$(node -p "require('$LOCK').archiveSha256")
mkdir -p "$DEST"
curl -fsSL -o "$DEST/$TAG.tar.gz" "https://github.com/deepseek-ai/deepseek-harness/archive/refs/tags/$TAG.tar.gz"
echo "$SHA  $DEST/$TAG.tar.gz" | shasum -a 256 -c -
tar -xzf "$DEST/$TAG.tar.gz" -C "$DEST"
TREE="$DEST/deepseek-harness-$TAG"
# Use the pnpm release upstream pins in packageManager, through corepack.
PNPM=$(node -p "require('$TREE/package.json').packageManager")
(cd "$TREE" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack "$PNPM" install --frozen-lockfile --ignore-scripts)
echo "$TREE"
