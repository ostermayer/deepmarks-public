#!/usr/bin/env bash
# Nightly strfry event export → Linode Object Storage.
#
# strfry is the durable Nostr event store. Redis caches can be rebuilt
# from it, but not the other way around, so we export the relay event log
# separately from Redis snapshots.

set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-https://us-southeast-1.linodeobjects.com}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-${S3_BUCKET:-deepmarks}}"
COMPOSE_DIR="/opt/deepmarks-repo/deploy/box-a"
STAMP="$(date -u +%Y-%m-%d_%H%M%SZ)"
OBJECT_KEY="strfry/events-${STAMP}.jsonl.gz"
BACKUP_TMP_PARENT="${BACKUP_TMP_PARENT:-/var/tmp}"

mkdir -p "$BACKUP_TMP_PARENT"
TMPDIR="$(mktemp -d "${BACKUP_TMP_PARENT%/}/deepmarks-strfry-backup.XXXXXX")"
LOCAL_COPY="$TMPDIR/events.jsonl.gz"
MANIFEST_COPY="$TMPDIR/strfry.json"

cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

source "$COMPOSE_DIR/s3-sigv4.sh"
require_var LINODE_ACCESS_KEY
require_var LINODE_SECRET_KEY

cd "$COMPOSE_DIR"

echo "→ exporting strfry events"
docker compose exec -T strfry strfry --config=/etc/strfry.conf export | gzip -c > "$LOCAL_COPY"

echo "→ validating gzip"
gzip -t "$LOCAL_COPY"
EVENT_COUNT="$(gzip -cd "$LOCAL_COPY" | wc -l | tr -d ' ')"
if [ "$EVENT_COUNT" = "0" ]; then
  echo "✗ strfry export contained zero events" >&2
  exit 1
fi

SIZE_BYTES="$(stat -c %s "$LOCAL_COPY" 2>/dev/null || stat -f %z "$LOCAL_COPY")"
SHA256="$(sha256_file "$LOCAL_COPY")"
echo "  events: $EVENT_COUNT"
echo "  export size: $SIZE_BYTES bytes"
echo "  export sha256: $SHA256"

echo "→ uploading to s3://${BACKUP_S3_BUCKET}/${OBJECT_KEY}"
s3_put "$BACKUP_S3_BUCKET" "$OBJECT_KEY" "$LOCAL_COPY" "$S3_ENDPOINT"

cat > "$MANIFEST_COPY" <<EOF
{
  "kind": "strfry-export",
  "createdAt": "$STAMP",
  "objectKey": "$OBJECT_KEY",
  "sizeBytes": $SIZE_BYTES,
  "sha256": "$SHA256",
  "eventCount": $EVENT_COUNT
}
EOF

echo "→ uploading strfry restore-test manifest"
s3_put "$BACKUP_S3_BUCKET" "strfry/manifests/${STAMP}.json" "$MANIFEST_COPY" "$S3_ENDPOINT"
s3_put "$BACKUP_S3_BUCKET" "latest/strfry.json" "$MANIFEST_COPY" "$S3_ENDPOINT"

echo "→ cleaning local copy"

echo "✓ strfry export uploaded to s3://${BACKUP_S3_BUCKET}/${OBJECT_KEY}"
