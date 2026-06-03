#!/usr/bin/env bash
# Optional protection for passkey-encrypted nsec ciphertext blobs.
#
# Versioning protects against accidental overwrite/delete, but it also
# retains old encrypted ciphertext versions after user deletion until the
# lifecycle rule removes them. Keep this retention short.

set -euo pipefail

S3_ENDPOINT="${S3_ENDPOINT:-https://us-southeast-1.linodeobjects.com}"
CIPHERTEXT_S3_BUCKET="${CIPHERTEXT_S3_BUCKET:-${LINODE_CIPHERTEXT_BUCKET:-ciphertext}}"
CIPHERTEXT_NONCURRENT_RETENTION_DAYS="${CIPHERTEXT_NONCURRENT_RETENTION_DAYS:-30}"
CIPHERTEXT_ABORT_MULTIPART_DAYS="${CIPHERTEXT_ABORT_MULTIPART_DAYS:-7}"
COMPOSE_DIR="/opt/deepmarks-repo/deploy/box-a"

source "$COMPOSE_DIR/s3-sigv4.sh"
require_var LINODE_ACCESS_KEY
require_var LINODE_SECRET_KEY

tmpdir="$(mktemp -d /var/tmp/deepmarks-ciphertext-bucket-policy.XXXXXX)"
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
    <ID>nsec-ciphertext-noncurrent-retention</ID>
    <Filter><Prefix>nsec/</Prefix></Filter>
    <Status>Enabled</Status>
    <NoncurrentVersionExpiration>
      <NoncurrentDays>${CIPHERTEXT_NONCURRENT_RETENTION_DAYS}</NoncurrentDays>
    </NoncurrentVersionExpiration>
    <AbortIncompleteMultipartUpload>
      <DaysAfterInitiation>${CIPHERTEXT_ABORT_MULTIPART_DAYS}</DaysAfterInitiation>
    </AbortIncompleteMultipartUpload>
  </Rule>
</LifecycleConfiguration>
EOF

echo "→ enabling versioning on s3://${CIPHERTEXT_S3_BUCKET}"
s3_put_bucket_versioning "$CIPHERTEXT_S3_BUCKET" "$S3_ENDPOINT" "$versioning_xml"

echo "→ applying lifecycle policy to s3://${CIPHERTEXT_S3_BUCKET}"
s3_put_bucket_lifecycle "$CIPHERTEXT_S3_BUCKET" "$S3_ENDPOINT" "$lifecycle_xml"

echo "→ verifying versioning"
s3_get_bucket_versioning "$CIPHERTEXT_S3_BUCKET" "$S3_ENDPOINT" "$tmpdir/versioning-readback.xml" >/dev/null
if ! grep -q '<Status>Enabled</Status>' "$tmpdir/versioning-readback.xml"; then
  echo "✗ ciphertext bucket versioning did not read back as Enabled" >&2
  cat "$tmpdir/versioning-readback.xml" >&2
  exit 1
fi

echo "→ verifying lifecycle"
s3_get_bucket_lifecycle "$CIPHERTEXT_S3_BUCKET" "$S3_ENDPOINT" "$tmpdir/lifecycle-readback.xml" >/dev/null
grep -q '<Prefix>nsec/</Prefix>' "$tmpdir/lifecycle-readback.xml"
grep -q '<NoncurrentDays>'"$CIPHERTEXT_NONCURRENT_RETENTION_DAYS"'</NoncurrentDays>' "$tmpdir/lifecycle-readback.xml"

echo "✓ ciphertext bucket policy configured"
