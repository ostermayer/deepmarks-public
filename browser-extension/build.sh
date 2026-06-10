#!/usr/bin/env bash
# Reproduce the Firefox zip uploaded to AMO.
# See SOURCE.md for prerequisites (Node 20+, npm 10+).
#
# Thin wrapper over the canonical npm script so the AMO source-review
# build and the operator's release build can never drift: both produce
# firefox/deepmarks-firefox.zip from firefox/code/.

set -euo pipefail

echo "→ npm ci          (install locked dependency tree)"
npm ci

echo "→ npm run package:firefox"
npm run package:firefox

echo
echo "✓ wrote $(pwd)/firefox/deepmarks-firefox.zip"
