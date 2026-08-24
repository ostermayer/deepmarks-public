#!/usr/bin/env bash
# Run every Deepmarks test suite (all four packages) and report a summary.
# Each package keeps its own vitest + node_modules; the configs point at
# this directory. Usage:
#   ./tests/run-all.sh            # everything
#   ./tests/run-all.sh frontend   # one package
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGES=(frontend api archive-worker browser-extension bunker)
if [[ $# -gt 0 ]]; then PACKAGES=("$@"); fi

failed=()
for pkg in "${PACKAGES[@]}"; do
  echo "──────────────────────────────────────────────"
  echo "▶ ${pkg}"
  echo "──────────────────────────────────────────────"
  if ! (cd "${ROOT}/${pkg}" && npx vitest run); then
    failed+=("${pkg}")
  fi
done

echo "──────────────────────────────────────────────"
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "✗ failing packages: ${failed[*]}"
  exit 1
fi
echo "✓ all packages green"
