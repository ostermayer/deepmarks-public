#!/usr/bin/env bash
# Object Storage durability/safety smoke test.
#
# This is intentionally read-only. It verifies that the backup bucket can
# be read, that the latest manifests exist, and that bucket-level controls
# are not accidentally applied to the wrong durability domain.

set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-https://us-southeast-1.linodeobjects.com}"
ARCHIVE_S3_BUCKET="${ARCHIVE_S3_BUCKET:-${S3_BUCKET:-deepmarks}}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-${S3_BUCKET:-deepmarks}}"
CIPHERTEXT_S3_BUCKET="${CIPHERTEXT_S3_BUCKET:-${LINODE_CIPHERTEXT_BUCKET:-ciphertext}}"
OBJECT_STORAGE_TMP_PARENT="${OBJECT_STORAGE_TMP_PARENT:-/var/tmp}"
REQUIRE_DEDICATED_BACKUP_BUCKET="${REQUIRE_DEDICATED_BACKUP_BUCKET:-1}"
REQUIRE_BACKUP_BUCKET_VERSIONING="${REQUIRE_BACKUP_BUCKET_VERSIONING:-1}"
REQUIRE_BACKUP_BUCKET_LIFECYCLE="${REQUIRE_BACKUP_BUCKET_LIFECYCLE:-1}"

COMPOSE_DIR="/opt/deepmarks-repo/deploy/box-a"

source "$COMPOSE_DIR/s3-sigv4.sh"
require_var LINODE_ACCESS_KEY
require_var LINODE_SECRET_KEY

mkdir -p "$OBJECT_STORAGE_TMP_PARENT"
TMPDIR="$(mktemp -d "${OBJECT_STORAGE_TMP_PARENT%/}/deepmarks-object-storage-check.XXXXXX")"
cleanup() {
  rm -rf "$TMPDIR"
}
trap cleanup EXIT

failures=0

fail() {
  failures=$((failures + 1))
  echo "✗ $*" >&2
}

warn() {
  echo "! $*" >&2
}

pass() {
  echo "✓ $*"
}

bucket_versioning_status() {
  local bucket="$1"
  local output="$TMPDIR/${bucket}.versioning.xml"
  if ! s3_get_bucket_versioning "$bucket" "$S3_ENDPOINT" "$output" >/dev/null; then
    echo "unreadable"
    return
  fi
  if grep -q '<Status>Enabled</Status>' "$output"; then
    echo "Enabled"
  elif grep -q '<Status>Suspended</Status>' "$output"; then
    echo "Suspended"
  else
    echo "Disabled"
  fi
}

check_latest_manifest() {
  local key="$1"
  local output="$TMPDIR/$(basename "$key")"
  if s3_get "$BACKUP_S3_BUCKET" "$key" "$S3_ENDPOINT" "$output" >/dev/null; then
    pass "read s3://${BACKUP_S3_BUCKET}/${key}"
  else
    fail "cannot read s3://${BACKUP_S3_BUCKET}/${key}"
  fi
}

echo "→ checking backup bucket boundary"
if [ "$REQUIRE_DEDICATED_BACKUP_BUCKET" = "1" ] && [ "$BACKUP_S3_BUCKET" = "$ARCHIVE_S3_BUCKET" ]; then
  fail "BACKUP_S3_BUCKET is the same as archive bucket '$ARCHIVE_S3_BUCKET'; use a dedicated backup bucket before enabling bucket-level versioning/object lock"
else
  pass "backup bucket is separate from archive bucket"
fi

echo "→ checking latest backup manifests"
check_latest_manifest latest/redis.json
check_latest_manifest latest/strfry.json

echo "→ checking backup bucket versioning"
backup_versioning="$(bucket_versioning_status "$BACKUP_S3_BUCKET")"
case "$backup_versioning" in
  Enabled)
    pass "backup bucket versioning enabled"
    ;;
  *)
    if [ "$REQUIRE_BACKUP_BUCKET_VERSIONING" = "1" ]; then
      fail "backup bucket versioning is ${backup_versioning}; enable bucket versioning on '$BACKUP_S3_BUCKET'"
    else
      warn "backup bucket versioning is ${backup_versioning}"
    fi
    ;;
esac

echo "→ checking backup bucket lifecycle"
lifecycle_xml="$TMPDIR/backup.lifecycle.xml"
if s3_get_bucket_lifecycle "$BACKUP_S3_BUCKET" "$S3_ENDPOINT" "$lifecycle_xml" >/dev/null; then
  pass "backup bucket lifecycle policy readable"
  if grep -q '<AbortIncompleteMultipartUpload>' "$lifecycle_xml"; then
    pass "backup bucket aborts stale multipart uploads"
  else
    warn "backup bucket lifecycle has no AbortIncompleteMultipartUpload rule"
  fi
  if grep -q '<Prefix>redis/' "$lifecycle_xml" && grep -q '<Prefix>strfry/' "$lifecycle_xml"; then
    pass "backup bucket lifecycle mentions redis/ and strfry/ prefixes"
  else
    warn "backup bucket lifecycle does not explicitly mention both redis/ and strfry/ prefixes"
  fi
else
  if [ "$REQUIRE_BACKUP_BUCKET_LIFECYCLE" = "1" ]; then
    fail "backup bucket lifecycle policy is missing or unreadable"
  else
    warn "backup bucket lifecycle policy is missing or unreadable"
  fi
fi

echo "→ checking archive and ciphertext bucket versioning posture"
archive_versioning="$(bucket_versioning_status "$ARCHIVE_S3_BUCKET")"
if [ "$archive_versioning" = "Enabled" ]; then
  warn "archive bucket '$ARCHIVE_S3_BUCKET' has versioning enabled; normal archive deletes create delete markers and retain old object versions"
else
  pass "archive bucket versioning is ${archive_versioning}"
fi

ciphertext_versioning="$(bucket_versioning_status "$CIPHERTEXT_S3_BUCKET")"
if [ "$ciphertext_versioning" = "Enabled" ]; then
  pass "ciphertext bucket versioning enabled"
else
  warn "ciphertext bucket versioning is ${ciphertext_versioning}; accidental ciphertext overwrites/deletes have no bucket-level recovery"
fi

if [ "$failures" -gt 0 ]; then
  echo "✗ object storage safety check failed with $failures issue(s)" >&2
  exit 1
fi

echo "✓ object storage safety check passed"
