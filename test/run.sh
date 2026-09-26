#!/usr/bin/env bash
# Bundle the test with esbuild (already present via wrangler) and run it on node.
set -euo pipefail
cd "$(dirname "$0")/.."

BUNDLE="$(mktemp -t ailobang-test-XXXXXX.mjs)"
trap 'rm -f "$BUNDLE"' EXIT

./node_modules/.bin/esbuild test/humanize.test.ts \
  --bundle --format=esm --platform=node --target=node20 \
  --outfile="$BUNDLE" --log-level=warning

node "$BUNDLE"
