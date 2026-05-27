#!/usr/bin/env bash
# Nightly Redis snapshot → Linode Object Storage.
#
# Runs on Box A's host (cron, 03:15 UTC). Triggers a BGSAVE on the Redis
# container, waits for it to finish, copies the resulting RDB out of the
# named volume, and uploads it with a date-stamped object key. Old
# snapshots aren't deleted here — use a bucket lifecycle rule on Linode
# for retention (e.g. keep 30 days) so the machine never holds a secret
# capable of mass-deletion.
#
# Usage:
#   ./backup-redis.sh
#
# Expects in the environment (exported via /etc/default/deepmarks-backup
# or inline cron env, never committed):
#   LINODE_ACCESS_KEY       — Linode Object Storage access key
#   LINODE_SECRET_KEY       — ... secret key
#   S3_ENDPOINT             — default https://us-southeast-1.linodeobjects.com
#   S3_BUCKET               — default deepmarks
#   REDIS_PASSWORD          — the requirepass value from compose .env
#
# Exit codes:
#   0  on successful upload
#   1  on any step failure (cron emails the output)

set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-https://us-southeast-1.linodeobjects.com}"
S3_BUCKET="${S3_BUCKET:-deepmarks}"
COMPOSE_DIR="/opt/deepmarks-repo/deploy/box-a"
STAMP="$(date -u +%Y-%m-%d_%H%M%SZ)"
OBJECT_KEY="redis/dump-${STAMP}.rdb"
LOCAL_COPY="/tmp/deepmarks-redis-${STAMP}.rdb"
MANIFEST_COPY="/tmp/deepmarks-redis-${STAMP}.json"

source "$COMPOSE_DIR/s3-sigv4.sh"
require_var LINODE_ACCESS_KEY
require_var LINODE_SECRET_KEY
require_var REDIS_PASSWORD

cd "$COMPOSE_DIR"

echo "→ BGSAVE"
# BGSAVE is async — it returns "Background saving started" and we poll
# LASTSAVE until the timestamp changes.
LAST_BEFORE="$(docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" LASTSAVE)"
docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" BGSAVE >/dev/null

echo "→ waiting for BGSAVE to finish"
for _ in $(seq 1 60); do
  LAST_AFTER="$(docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" LASTSAVE)"
  if [ "$LAST_AFTER" != "$LAST_BEFORE" ]; then
    echo "  ✓ snapshot complete"
    break
  fi
  sleep 2
done
if [ "$LAST_AFTER" = "$LAST_BEFORE" ]; then
  echo "✗ BGSAVE did not complete within 120s" >&2
  exit 1
fi

echo "→ copying dump.rdb out of the container"
# /data is the Redis data dir; BGSAVE writes dump.rdb there atomically.
docker compose cp redis:/data/dump.rdb "$LOCAL_COPY"

SIZE_BYTES="$(stat -c %s "$LOCAL_COPY" 2>/dev/null || stat -f %z "$LOCAL_COPY")"
SHA256="$(sha256_file "$LOCAL_COPY")"
echo "  rdb size: $SIZE_BYTES bytes"
echo "  rdb sha256: $SHA256"

echo "→ uploading to s3://${S3_BUCKET}/${OBJECT_KEY}"
s3_put "$S3_BUCKET" "$OBJECT_KEY" "$LOCAL_COPY" "$S3_ENDPOINT"

cat > "$MANIFEST_COPY" <<EOF
{
  "kind": "redis-rdb",
  "createdAt": "$STAMP",
  "objectKey": "$OBJECT_KEY",
  "sizeBytes": $SIZE_BYTES,
  "sha256": "$SHA256"
}
EOF

echo "→ uploading redis restore-test manifest"
s3_put "$S3_BUCKET" "redis/manifests/${STAMP}.json" "$MANIFEST_COPY" "$S3_ENDPOINT"
s3_put "$S3_BUCKET" "latest/redis.json" "$MANIFEST_COPY" "$S3_ENDPOINT"

echo "→ cleaning local copy"
rm -f "$LOCAL_COPY" "$MANIFEST_COPY"

echo "✓ redis snapshot uploaded to s3://${S3_BUCKET}/${OBJECT_KEY}"
