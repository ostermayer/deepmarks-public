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
#   S3_BUCKET               — default deepmarks-backups
#   REDIS_PASSWORD          — the requirepass value from compose .env
#
# Exit codes:
#   0  on successful upload
#   1  on any step failure (cron emails the output)

set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-https://us-southeast-1.linodeobjects.com}"
S3_BUCKET="${S3_BUCKET:-deepmarks-backups}"
COMPOSE_DIR="/opt/deepmarks-repo/deploy/box-a"
STAMP="$(date -u +%Y-%m-%d_%H%M%SZ)"
OBJECT_KEY="redis/dump-${STAMP}.rdb"
LOCAL_COPY="/tmp/deepmarks-redis-${STAMP}.rdb"

require_var() {
  local v="$1"
  if [ -z "${!v:-}" ]; then
    echo "✗ missing env var: $v" >&2
    exit 1
  fi
}
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
echo "  rdb size: $SIZE_BYTES bytes"

echo "→ uploading to s3://${S3_BUCKET}/${OBJECT_KEY}"
# Signed S3 PUT via curl — avoids depending on awscli / s3cmd being
# installed on the host. We use AWS sigv4 which Linode Object Storage
# supports. Reference: https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
upload_with_sigv4() {
  local bucket="$1" key="$2" file="$3" endpoint="$4"
  local host; host="$(echo "$endpoint" | sed -E 's|https?://||' | sed 's|/$||')"
  local region; region="$(echo "$host" | cut -d. -f1)"
  local date_iso; date_iso="$(date -u +%Y%m%dT%H%M%SZ)"
  local date_ymd="${date_iso:0:8}"
  local content_sha; content_sha="$(openssl dgst -sha256 -hex "$file" | awk '{print $NF}')"
  local canonical_request="PUT
/${bucket}/${key}

host:${host}
x-amz-content-sha256:${content_sha}
x-amz-date:${date_iso}

host;x-amz-content-sha256;x-amz-date
${content_sha}"
  local hashed_canonical; hashed_canonical="$(printf "%s" "$canonical_request" | openssl dgst -sha256 -hex | awk '{print $NF}')"
  local scope="${date_ymd}/${region}/s3/aws4_request"
  local string_to_sign="AWS4-HMAC-SHA256
${date_iso}
${scope}
${hashed_canonical}"
  # Derive signing key: HMAC chain per sigv4 spec.
  local k1 k2 k3 k4 sig
  k1="$(printf "%s" "$date_ymd" | openssl dgst -sha256 -hex -mac HMAC -macopt "key:AWS4${LINODE_SECRET_KEY}" | awk '{print $NF}')"
  k2="$(printf "%s" "$region"   | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:$k1"                      | awk '{print $NF}')"
  k3="$(printf "%s" "s3"        | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:$k2"                      | awk '{print $NF}')"
  k4="$(printf "%s" "aws4_request" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:$k3"                   | awk '{print $NF}')"
  sig="$(printf "%s" "$string_to_sign" | openssl dgst -sha256 -hex -mac HMAC -macopt "hexkey:$k4"               | awk '{print $NF}')"

  local auth="AWS4-HMAC-SHA256 Credential=${LINODE_ACCESS_KEY}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}"

  curl --fail --silent --show-error \
    -X PUT "${endpoint}/${bucket}/${key}" \
    -H "Host: ${host}" \
    -H "Authorization: ${auth}" \
    -H "x-amz-content-sha256: ${content_sha}" \
    -H "x-amz-date: ${date_iso}" \
    --upload-file "$file"
}
upload_with_sigv4 "$S3_BUCKET" "$OBJECT_KEY" "$LOCAL_COPY" "$S3_ENDPOINT"

echo "→ cleaning local copy"
rm -f "$LOCAL_COPY"

echo "✓ redis snapshot uploaded to s3://${S3_BUCKET}/${OBJECT_KEY}"
