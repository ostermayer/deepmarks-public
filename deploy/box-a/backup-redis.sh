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
#   BACKUP_S3_BUCKET        — default S3_BUCKET or deepmarks
#   S3_BUCKET               — legacy fallback bucket name
#   REDIS_PASSWORD          — the requirepass value from compose .env
#
# Exit codes:
#   0  on successful upload
#   1  on any step failure (cron emails the output)

set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-https://us-southeast-1.linodeobjects.com}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-${S3_BUCKET:-deepmarks}}"
COMPOSE_DIR="/opt/deepmarks-repo/deploy/box-a"
STAMP="$(date -u +%Y-%m-%d_%H%M%SZ)"
OBJECT_KEY="redis/dump-${STAMP}.rdb"
BACKUP_TMP_PARENT="${BACKUP_TMP_PARENT:-/var/tmp}"
REDIS_BGSAVE_TIMEOUT_SECONDS="${REDIS_BGSAVE_TIMEOUT_SECONDS:-900}"
REDIS_BGSAVE_POLL_SECONDS="${REDIS_BGSAVE_POLL_SECONDS:-5}"

mkdir -p "$BACKUP_TMP_PARENT"
TMPDIR="$(mktemp -d "${BACKUP_TMP_PARENT%/}/deepmarks-redis-backup.XXXXXX")"
LOCAL_COPY="$TMPDIR/dump.rdb"
MANIFEST_COPY="$TMPDIR/redis.json"

cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

source "$COMPOSE_DIR/s3-sigv4.sh"
require_var LINODE_ACCESS_KEY
require_var LINODE_SECRET_KEY
require_var REDIS_PASSWORD

cd "$COMPOSE_DIR"

redis_cli() {
  docker compose exec -T redis redis-cli -a "$REDIS_PASSWORD" --no-auth-warning "$@"
}

redis_persistence_field() {
  local field="$1"
  redis_cli INFO persistence | awk -F: -v key="$field" '$1 == key { gsub(/\r/, "", $2); print $2; exit }'
}

echo "→ BGSAVE"
# BGSAVE is async — it returns "Background saving started" and we poll
# LASTSAVE until the timestamp changes.
LAST_BEFORE="$(redis_cli LASTSAVE)"
if ! BGSAVE_OUT="$(redis_cli BGSAVE 2>&1)"; then
  case "$BGSAVE_OUT" in
    *"Background save already in progress"*)
      echo "  existing BGSAVE already in progress"
      ;;
    *)
      echo "✗ BGSAVE failed: $BGSAVE_OUT" >&2
      redis_cli INFO persistence >&2 || true
      exit 1
      ;;
  esac
fi

echo "→ waiting for BGSAVE to finish"
deadline=$(( $(date +%s) + REDIS_BGSAVE_TIMEOUT_SECONDS ))
LAST_AFTER="$LAST_BEFORE"
while true; do
  LAST_AFTER="$(redis_cli LASTSAVE)"
  IN_PROGRESS="$(redis_persistence_field rdb_bgsave_in_progress)"
  LAST_STATUS="$(redis_persistence_field rdb_last_bgsave_status)"
  if [ "${IN_PROGRESS:-0}" = "0" ] && [ "$LAST_AFTER" != "$LAST_BEFORE" ]; then
    echo "  ✓ snapshot complete"
    break
  fi
  if [ "${IN_PROGRESS:-0}" = "0" ] && [ "${LAST_STATUS:-unknown}" != "ok" ]; then
    echo "✗ BGSAVE finished with status ${LAST_STATUS:-unknown}" >&2
    redis_cli INFO persistence >&2 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "✗ BGSAVE did not complete within ${REDIS_BGSAVE_TIMEOUT_SECONDS}s" >&2
    redis_cli INFO persistence >&2 || true
    exit 1
  fi
  sleep "$REDIS_BGSAVE_POLL_SECONDS"
done

echo "→ copying dump.rdb out of the container"
# /data is the Redis data dir; BGSAVE writes dump.rdb there atomically.
docker compose cp redis:/data/dump.rdb "$LOCAL_COPY"

SIZE_BYTES="$(stat -c %s "$LOCAL_COPY" 2>/dev/null || stat -f %z "$LOCAL_COPY")"
SHA256="$(sha256_file "$LOCAL_COPY")"
echo "  rdb size: $SIZE_BYTES bytes"
echo "  rdb sha256: $SHA256"

echo "→ uploading to s3://${BACKUP_S3_BUCKET}/${OBJECT_KEY}"
s3_put "$BACKUP_S3_BUCKET" "$OBJECT_KEY" "$LOCAL_COPY" "$S3_ENDPOINT"

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
s3_put "$BACKUP_S3_BUCKET" "redis/manifests/${STAMP}.json" "$MANIFEST_COPY" "$S3_ENDPOINT"
s3_put "$BACKUP_S3_BUCKET" "latest/redis.json" "$MANIFEST_COPY" "$S3_ENDPOINT"

echo "→ cleaning local copy"

echo "✓ redis snapshot uploaded to s3://${BACKUP_S3_BUCKET}/${OBJECT_KEY}"
