#!/usr/bin/env bash
# Bundle every test file with esbuild (already present via wrangler) and run it
# on node. Each file gets its own build: esbuild rejects more than one entry
# point with --outfile. A test reports failure by setting a non-zero exit code
# rather than by throwing, so each run's status has to be checked explicitly.
set -euo pipefail
cd "$(dirname "$0")/.."

# A directory, not a file: `mktemp -t name.mjs` puts the random suffix after the
# extension and node then refuses to load the result.
BUNDLE_DIR="$(mktemp -d -t ailobang-test-XXXXXX)"
trap 'rm -rf "$BUNDLE_DIR"' EXIT
BUNDLE="${BUNDLE_DIR}/test.mjs"

status=0
for test_file in test/*.test.ts; do
  echo "== ${test_file}"
  ./node_modules/.bin/esbuild "$test_file" \
    --bundle --format=esm --platform=node --target=node20 \
    --outfile="$BUNDLE" --log-level=warning

  node "$BUNDLE" || status=1
done

exit "$status"
