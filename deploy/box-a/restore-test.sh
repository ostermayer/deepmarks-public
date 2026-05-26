#!/usr/bin/env bash
# Non-destructive backup restore test.
#
# Downloads the latest Redis RDB and strfry export manifests from Object
# Storage, verifies size + sha256, restores into throwaway Docker
# containers/directories, and optionally samples Blossom archive blobs by
# checking that sha256(bytes) == blobHash.

set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-https://us-southeast-1.linodeobjects.com}"
S3_BUCKET="${S3_BUCKET:-deepmarks}"
COMPOSE_DIR="/opt/deepmarks-repo/deploy/box-a"
BLOSSOM_PUBLIC_BASE="${BLOSSOM_PUBLIC_BASE:-https://blossom.deepmarks.org}"
ARCHIVE_BLOB_SAMPLE_LIMIT="${ARCHIVE_BLOB_SAMPLE_LIMIT:-3}"
ARCHIVE_BLOB_MAX_BYTES="${ARCHIVE_BLOB_MAX_BYTES:-104857600}"

source "$COMPOSE_DIR/s3-sigv4.sh"
require_var LINODE_ACCESS_KEY
require_var LINODE_SECRET_KEY

TMPDIR="$(mktemp -d /tmp/deepmarks-restore-test.XXXXXX)"
REDIS_CONTAINER="deepmarks-restore-redis-$(date -u +%Y%m%d%H%M%S)-$$"

cleanup() {
  docker rm -f "$REDIS_CONTAINER" >/dev/null 2>&1 || true
  chmod -R u+rwX "$TMPDIR" >/dev/null 2>&1 || sudo -n chmod -R u+rwX "$TMPDIR" >/dev/null 2>&1 || true
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

json_field() {
  python3 -c '
import json
import sys

with open(sys.argv[1], "r", encoding="utf-8") as f:
    value = json.load(f).get(sys.argv[2])
if value is None:
    sys.exit(2)
sys.stdout.write(str(value))
' "$1" "$2"
}

verify_file() {
  local label="$1"
  local file="$2"
  local expected_size="$3"
  local expected_sha="$4"
  local actual_size actual_sha
  actual_size="$(stat -c %s "$file" 2>/dev/null || stat -f %z "$file")"
  actual_sha="$(sha256_file "$file")"
  if [ "$actual_size" != "$expected_size" ]; then
    echo "✗ $label size mismatch: got $actual_size expected $expected_size" >&2
    exit 1
  fi
  if [ "$actual_sha" != "$expected_sha" ]; then
    echo "✗ $label sha256 mismatch: got $actual_sha expected $expected_sha" >&2
    exit 1
  fi
  echo "  ✓ $label sha256 verified"
}

download_manifest_and_object() {
  local label="$1"
  local latest_key="$2"
  local manifest="$3"
  local object_file="$4"

  echo "→ downloading $label manifest"
  s3_get "$S3_BUCKET" "$latest_key" "$S3_ENDPOINT" "$manifest"
  local object_key size sha
  object_key="$(json_field "$manifest" objectKey)"
  size="$(json_field "$manifest" sizeBytes)"
  sha="$(json_field "$manifest" sha256)"
  echo "  object: s3://${S3_BUCKET}/${object_key}"

  echo "→ downloading $label object"
  s3_get "$S3_BUCKET" "$object_key" "$S3_ENDPOINT" "$object_file"
  verify_file "$label object" "$object_file" "$size" "$sha"
}

test_redis_restore() {
  local rdb="$1"
  local redis_dir="$TMPDIR/redis-data"

  echo "→ validating Redis RDB format"
  docker run --rm -v "$(dirname "$rdb"):/restore:ro" redis:7-alpine \
    redis-check-rdb "/restore/$(basename "$rdb")" >/dev/null
  echo "  ✓ redis-check-rdb passed"

  mkdir -p "$redis_dir"
  cp "$rdb" "$redis_dir/dump.rdb"

  echo "→ starting throwaway Redis from restored dump"
  docker run -d --name "$REDIS_CONTAINER" \
    -v "$redis_dir:/data" \
    redis:7-alpine \
    redis-server --dir /data --dbfilename dump.rdb --appendonly no --save "" --protected-mode no >/dev/null

  for _ in $(seq 1 30); do
    if [ "$(docker exec "$REDIS_CONTAINER" redis-cli PING 2>/dev/null | tr -d '\r')" = "PONG" ]; then
      break
    fi
    sleep 1
  done
  if [ "$(docker exec "$REDIS_CONTAINER" redis-cli PING 2>/dev/null | tr -d '\r')" != "PONG" ]; then
    echo "✗ restored Redis did not start" >&2
    exit 1
  fi

  local dbsize
  dbsize="$(docker exec "$REDIS_CONTAINER" redis-cli DBSIZE 2>/dev/null | tr -d '\r')"
  if ! [[ "${dbsize:-}" =~ ^[0-9]+$ ]]; then
    echo "✗ restored Redis returned invalid DBSIZE: ${dbsize:-<empty>}" >&2
    exit 1
  fi
  if [ "$dbsize" = "0" ]; then
    echo "✗ restored Redis has zero keys" >&2
    exit 1
  fi
  echo "  ✓ restored Redis loaded $dbsize keys"
}

test_strfry_restore() {
  local archive="$1"
  local manifest="$2"
  local expected_count
  expected_count="$(json_field "$manifest" eventCount)"

  echo "→ validating strfry gzip + event JSON"
  gzip -t "$archive"
  gzip -cd "$archive" | python3 -c '
import json
import sys

count = 0
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    event = json.loads(line)
    if not all(isinstance(event.get(key), str) for key in ("id", "pubkey", "sig")):
        raise SystemExit("event missing id/pubkey/sig")
    if type(event.get("kind")) is not int or type(event.get("created_at")) is not int:
        raise SystemExit("event has invalid kind/created_at")
    if not isinstance(event.get("tags"), list):
        raise SystemExit("event has invalid tags")
    count += 1

if count == 0:
    raise SystemExit("zero events")
print(f"  verified {count} event JSON lines")
'

  mkdir -p "$TMPDIR/strfry-db"
  echo "→ importing strfry export into throwaway database"
  gzip -cd "$archive" | docker run --rm -i \
    -v "$TMPDIR/strfry-db:/var/lib/strfry" \
    -v "$COMPOSE_DIR/strfry/strfry.conf:/etc/strfry.conf:ro" \
    -v "$COMPOSE_DIR/strfry/deepmarks.js:/opt/strfry-policies/deepmarks.js:ro" \
    box-a-strfry:latest \
    strfry --config=/etc/strfry.conf import >/dev/null

  local restored_count
  restored_count="$(docker run --rm \
    -v "$TMPDIR/strfry-db:/var/lib/strfry" \
    -v "$COMPOSE_DIR/strfry/strfry.conf:/etc/strfry.conf:ro" \
    -v "$COMPOSE_DIR/strfry/deepmarks.js:/opt/strfry-policies/deepmarks.js:ro" \
    box-a-strfry:latest \
    strfry --config=/etc/strfry.conf export | wc -l | tr -d ' ')"
  if [ "$restored_count" != "$expected_count" ]; then
    echo "✗ restored strfry event count mismatch: got $restored_count expected $expected_count" >&2
    exit 1
  fi
  echo "  ✓ restored strfry database exported $restored_count events"
}

sample_archive_blobs() {
  local limit="$ARCHIVE_BLOB_SAMPLE_LIMIT"
  if [ "$limit" = "0" ]; then
    echo "→ archive blob sampling disabled"
    return
  fi

  echo "→ sampling up to $limit archive blob(s)"
  local hashes
  hashes="$(docker exec "$REDIS_CONTAINER" sh -c '
set -eu
count=0
for key in $(redis-cli --scan --pattern "dm:archives:*"); do
  redis-cli HKEYS "$key"
  count=$((count + 1))
  if [ "$count" -ge 50 ]; then
    break
  fi
done
' | awk -v limit="$limit" '/^[0-9a-f]{64}$/ && !seen[$0]++ && count < limit { print; count++ }' || true)"

  if [ -z "$hashes" ]; then
    echo "  no archive hashes found in restored Redis"
    return
  fi

  local checked=0
  while IFS= read -r hash; do
    [ -n "$hash" ] || continue
    local out="$TMPDIR/blob-${hash}"
    local header="$TMPDIR/blob-${hash}.headers"
    local url="${BLOSSOM_PUBLIC_BASE%/}/${hash}"
    local declared_size=""
    if curl --fail --silent --show-error --location --max-time 10 -I "$url" -D "$header" -o /dev/null; then
      declared_size="$(awk 'tolower($1)=="content-length:" {print $2}' "$header" | tr -d '\r' | tail -1)"
      if [[ "$declared_size" =~ ^[0-9]+$ ]] && [ "$declared_size" -gt "$ARCHIVE_BLOB_MAX_BYTES" ]; then
        echo "  skipped $hash: ${declared_size} bytes exceeds sample max"
        rm -f "$header"
        continue
      fi
    fi
    if ! curl --fail --silent --show-error --location --max-time 20 -D "$header" -o "$out" "$url"; then
      echo "✗ failed to download archive blob $hash" >&2
      exit 1
    fi
    local size
    size="$(stat -c %s "$out" 2>/dev/null || stat -f %z "$out")"
    if [ "$size" -gt "$ARCHIVE_BLOB_MAX_BYTES" ]; then
      echo "  skipped $hash after download: ${size} bytes exceeds sample max"
      rm -f "$out" "$header"
      continue
    fi
    local actual
    actual="$(sha256_file "$out")"
    if [ "$actual" != "$hash" ]; then
      echo "✗ archive blob hash mismatch: $hash downloaded as $actual" >&2
      exit 1
    fi
    checked=$((checked + 1))
    echo "  ✓ archive blob $hash verified (${size} bytes)"
    rm -f "$out" "$header"
  done <<< "$hashes"

  if [ "$checked" = "0" ]; then
    echo "  no archive blobs checked; all sampled blobs exceeded limits or no hashes were found"
  fi
}

REDIS_MANIFEST="$TMPDIR/redis.json"
REDIS_RDB="$TMPDIR/dump.rdb"
STRFRY_MANIFEST="$TMPDIR/strfry.json"
STRFRY_EXPORT="$TMPDIR/strfry.jsonl.gz"

download_manifest_and_object redis latest/redis.json "$REDIS_MANIFEST" "$REDIS_RDB"
test_redis_restore "$REDIS_RDB"

download_manifest_and_object strfry latest/strfry.json "$STRFRY_MANIFEST" "$STRFRY_EXPORT"
test_strfry_restore "$STRFRY_EXPORT" "$STRFRY_MANIFEST"

sample_archive_blobs

echo "✓ backup restore test passed"
