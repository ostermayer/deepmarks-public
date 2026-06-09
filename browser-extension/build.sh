#!/usr/bin/env bash
# Reproduce the Firefox XPI uploaded to AMO.
# See SOURCE.md for prerequisites (Node 20+, npm 10+).

set -euo pipefail

echo "→ npm ci          (install locked dependency tree)"
npm ci

echo "→ npm run build:firefox  (BROWSER=firefox tsc -b && vite build)"
npm run build:firefox

echo "→ zip dist/ → deepmarks-firefox.zip"
rm -f deepmarks-firefox.zip
( cd dist && zip -r ../deepmarks-firefox.zip . )

echo
echo "✓ wrote $(pwd)/deepmarks-firefox.zip"
