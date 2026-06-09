#!/usr/bin/env bash
# Enable Object Storage controls for the dedicated backup bucket.

set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-https://us-southeast-1.linodeobjects.com}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-${S3_BUCKET:-deepmarks-backups}}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-365}"
BACKUP_NONCURRENT_RETENTION_DAYS="${BACKUP_NONCURRENT_RETENTION_DAYS:-365}"
BACKUP_ABORT_MULTIPART_DAYS="${BACKUP_ABORT_MULTIPART_DAYS:-7}"
COMPOSE_DIR="/opt/deepmarks-repo/deploy/box-a"

source "$COMPOSE_DIR/s3-sigv4.sh"
require_var LINODE_ACCESS_KEY
require_var LINODE_SECRET_KEY

tmpdir="$(mktemp -d /var/tmp/deepmarks-backup-bucket-policy.XXXXXX)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

versioning_xml="$tmpdir/versioning.xml"
lifecycle_xml="$tmpdir/lifecycle.xml"

cat > "$versioning_xml" <<'EOF'
<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Status>Enabled</Status>
</VersioningConfiguration>
EOF

cat > "$lifecycle_xml" <<EOF
<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Rule>
    <ID>redis-backup-retention</ID>
    <Filter><Prefix>redis/</Prefix></Filter>
    <Status>Enabled</Status>
    <Expiration><Days>${BACKUP_RETENTION_DAYS}</Days></Expiration>
    <NoncurrentVersionExpiration>
      <NoncurrentDays>${BACKUP_NONCURRENT_RETENTION_DAYS}</NoncurrentDays>
    </NoncurrentVersionExpiration>
    <AbortIncompleteMultipartUpload>
      <DaysAfterInitiation>${BACKUP_ABORT_MULTIPART_DAYS}</DaysAfterInitiation>
    </AbortIncompleteMultipartUpload>
  </Rule>
  <Rule>
    <ID>strfry-backup-retention</ID>
    <Filter><Prefix>strfry/</Prefix></Filter>
    <Status>Enabled</Status>
    <Expiration><Days>${BACKUP_RETENTION_DAYS}</Days></Expiration>
    <NoncurrentVersionExpiration>
      <NoncurrentDays>${BACKUP_NONCURRENT_RETENTION_DAYS}</NoncurrentDays>
    </NoncurrentVersionExpiration>
    <AbortIncompleteMultipartUpload>
      <DaysAfterInitiation>${BACKUP_ABORT_MULTIPART_DAYS}</DaysAfterInitiation>
    </AbortIncompleteMultipartUpload>
  </Rule>
  <Rule>
    <ID>latest-manifest-noncurrent-retention</ID>
    <Filter><Prefix>latest/</Prefix></Filter>
    <Status>Enabled</Status>
    <NoncurrentVersionExpiration>
      <NoncurrentDays>${BACKUP_NONCURRENT_RETENTION_DAYS}</NoncurrentDays>
    </NoncurrentVersionExpiration>
    <AbortIncompleteMultipartUpload>
      <DaysAfterInitiation>${BACKUP_ABORT_MULTIPART_DAYS}</DaysAfterInitiation>
    </AbortIncompleteMultipartUpload>
  </Rule>
</LifecycleConfiguration>
EOF

echo "→ enabling versioning on s3://${BACKUP_S3_BUCKET}"
s3_put_bucket_versioning "$BACKUP_S3_BUCKET" "$S3_ENDPOINT" "$versioning_xml"

echo "→ applying lifecycle policy to s3://${BACKUP_S3_BUCKET}"
s3_put_bucket_lifecycle "$BACKUP_S3_BUCKET" "$S3_ENDPOINT" "$lifecycle_xml"

echo "→ verifying versioning"
s3_get_bucket_versioning "$BACKUP_S3_BUCKET" "$S3_ENDPOINT" "$tmpdir/versioning-readback.xml" >/dev/null
if ! grep -q '<Status>Enabled</Status>' "$tmpdir/versioning-readback.xml"; then
  echo "✗ backup bucket versioning did not read back as Enabled" >&2
  cat "$tmpdir/versioning-readback.xml" >&2
  exit 1
fi

echo "→ verifying lifecycle"
s3_get_bucket_lifecycle "$BACKUP_S3_BUCKET" "$S3_ENDPOINT" "$tmpdir/lifecycle-readback.xml" >/dev/null
grep -q '<Prefix>redis/</Prefix>' "$tmpdir/lifecycle-readback.xml"
grep -q '<Prefix>strfry/</Prefix>' "$tmpdir/lifecycle-readback.xml"
grep -q '<Prefix>latest/</Prefix>' "$tmpdir/lifecycle-readback.xml"

echo "✓ backup bucket policy configured"
