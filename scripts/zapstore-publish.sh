#!/usr/bin/env bash
# Publish the signed Android APK metadata to Zapstore with zsp.
#
# This helper reads the public-profile nsec from a local ignored file so
# the key does not land in shell history. zsp still requires SIGN_WITH in
# its process environment, so prefer a NIP-46 bunker for unattended use
# once that is available.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/zapstore.yaml"
NSEC_FILE="${DEEPMARKS_ZAPSTORE_NSEC_FILE:-$ROOT/publicprofile-nsec.txt}"
APK="$ROOT/frontend/android/app/build/outputs/apk/release/app-release.apk"
ZSP_BIN="${ZSP_BIN:-zsp}"

usage() {
  cat <<'EOF'
Usage:
  scripts/zapstore-publish.sh check
  scripts/zapstore-publish.sh publish [zsp flags...]
  scripts/zapstore-publish.sh offline <events.json>

Commands:
  check    Verify zapstore.yaml can resolve a valid local APK.
  publish  Publish with zsp, signing with publicprofile-nsec.txt.
  offline  Write signed events locally without uploading/publishing.

Set DEEPMARKS_ZAPSTORE_NSEC_FILE to use a different local nsec file.
EOF
}

require_zsp() {
  if ! command -v "$ZSP_BIN" >/dev/null 2>&1; then
    gopath="$(go env GOPATH 2>/dev/null || true)"
    if [ -n "$gopath" ] && [ -x "$gopath/bin/zsp" ]; then
      ZSP_BIN="$gopath/bin/zsp"
      return
    fi
    echo "zsp not found. Install it with: go install github.com/zapstore/zsp@latest" >&2
    exit 1
  fi
}

require_apk() {
  if [ ! -f "$APK" ]; then
    echo "release APK missing: $APK" >&2
    echo "Build a signed release APK in Android Studio first." >&2
    exit 1
  fi
}

read_signing_key() {
  if [ ! -f "$NSEC_FILE" ]; then
    echo "Zapstore signing key file missing: $NSEC_FILE" >&2
    exit 1
  fi
  awk -F: '
    /^[[:space:]]*nsec[[:space:]]*:/ {
      value=$0
      sub(/^[[:space:]]*nsec[[:space:]]*:[[:space:]]*/, "", value)
      gsub(/[[:space:]]/, "", value)
      print value
      found=1
      exit
    }
    END {
      if (!found) {
        exit 2
      }
    }
  ' "$NSEC_FILE" || tr -d '[:space:]' < "$NSEC_FILE"
}

cmd="${1:-}"
if [ -z "$cmd" ] || [ "$cmd" = "-h" ] || [ "$cmd" = "--help" ]; then
  usage
  exit 0
fi
shift

require_zsp

case "$cmd" in
  check)
    require_apk
    SIGN_WITH="npub199zwj9d6w88slsvlthdqfr8q2w58cq0aw3utz7fnpgt7mjjvut6qc80sqk" \
      "$ZSP_BIN" publish --check "$CONFIG"
    ;;
  publish)
    require_apk
    signer="$(read_signing_key)"
    SIGN_WITH="$signer" "$ZSP_BIN" publish "$CONFIG" "$@"
    ;;
  offline)
    require_apk
    out="${1:-}"
    if [ -z "$out" ]; then
      echo "offline requires an output path, e.g. scripts/zapstore-publish.sh offline zapstore-events.json" >&2
      exit 2
    fi
    signer="$(read_signing_key)"
    SIGN_WITH="$signer" "$ZSP_BIN" publish -q --offline "$CONFIG" > "$out"
    echo "wrote signed Zapstore events to $out"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    usage >&2
    exit 2
    ;;
esac
