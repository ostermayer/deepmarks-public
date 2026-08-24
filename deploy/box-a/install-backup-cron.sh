#!/usr/bin/env bash
# One-shot install of the nightly backup + restore-test jobs.
#
# Run this once on Box A after deploying backup-redis.sh (it's already
# there if /opt/deepmarks-repo is pulled fresh). It writes systemd
# timers + services — preferred over cron because they inherit the dan
# user's docker group membership cleanly and log to the journal. The
# installer enables lingering so the user timers keep running after SSH
# sessions close.
#
# Usage:
#   ./install-backup-cron.sh
#
# After install, check status:
#   systemctl --user list-timers 'deepmarks-*backup*' deepmarks-restore-test.timer
#   journalctl --user -u deepmarks-backup.service -u deepmarks-backup-strfry.service -u deepmarks-restore-test.service -n 100
#
# The envfile path is intentionally separate from compose's .env so we
# don't hand the backup job a VOLTAGE_INVOICE_MACAROON it doesn't need.

set -euo pipefail

UNIT_DIR="${HOME}/.config/systemd/user"
ENV_FILE="${HOME}/.config/deepmarks-backup.env"
REDIS_BACKUP_SCRIPT="/opt/deepmarks-repo/deploy/box-a/backup-redis.sh"
STRFRY_BACKUP_SCRIPT="/opt/deepmarks-repo/deploy/box-a/backup-strfry.sh"
RESTORE_TEST_SCRIPT="/opt/deepmarks-repo/deploy/box-a/restore-test.sh"
OBJECT_STORAGE_CHECK_SCRIPT="/opt/deepmarks-repo/deploy/box-a/object-storage-safety-check.sh"

for script in "$REDIS_BACKUP_SCRIPT" "$STRFRY_BACKUP_SCRIPT" "$RESTORE_TEST_SCRIPT" "$OBJECT_STORAGE_CHECK_SCRIPT"; do
  if [ ! -x "$script" ]; then
    echo "✗ $script not found or not executable" >&2
    exit 1
  fi
done

if command -v loginctl >/dev/null 2>&1; then
  LINGER="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
  if [ "$LINGER" != "yes" ]; then
    echo "→ enabling lingering for $USER so backup timers run without an active SSH session"
    if ! sudo -n loginctl enable-linger "$USER"; then
      echo "✗ failed to enable lingering with passwordless sudo" >&2
      echo "  run: sudo loginctl enable-linger $USER" >&2
      exit 1
    fi
  fi
fi

mkdir -p "$UNIT_DIR" "$(dirname "$ENV_FILE")"

if [ ! -f "$ENV_FILE" ]; then
  echo "→ writing $ENV_FILE (placeholder — fill in real values)"
  cat > "$ENV_FILE" <<'EOF'
# Populate from /opt/deepmarks-repo/deploy/box-a/.env then chmod 600.
LINODE_ACCESS_KEY=
LINODE_SECRET_KEY=
REDIS_PASSWORD=
S3_ENDPOINT=https://us-southeast-1.linodeobjects.com
S3_BUCKET=deepmarks
# Dedicated backup bucket. Do not point this at the Blossom archive bucket:
# bucket-level versioning/object lock conflicts with user archive deletes.
BACKUP_S3_BUCKET=deepmarks-backups
BACKUP_TMP_PARENT=/var/tmp
RESTORE_TEST_TMP_PARENT=/var/tmp
OBJECT_STORAGE_TMP_PARENT=/var/tmp
REDIS_BGSAVE_TIMEOUT_SECONDS=900
BLOSSOM_PUBLIC_BASE=https://blossom.deepmarks.org
ARCHIVE_BLOB_SAMPLE_LIMIT=3
ARCHIVE_BLOB_MAX_BYTES=104857600
REQUIRE_DEDICATED_BACKUP_BUCKET=1
REQUIRE_BACKUP_BUCKET_VERSIONING=1
REQUIRE_BACKUP_BUCKET_LIFECYCLE=1
EOF
  chmod 600 "$ENV_FILE"
  echo "  ! edit $ENV_FILE before the timer will work."
fi

cat > "$UNIT_DIR/deepmarks-backup.service" <<EOF
[Unit]
Description=Deepmarks nightly Redis snapshot → Linode Object Storage
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStart=$REDIS_BACKUP_SCRIPT
# Backups are silent on success; the journal captures stderr on failure.
StandardOutput=journal
StandardError=journal
EOF

cat > "$UNIT_DIR/deepmarks-backup-strfry.service" <<EOF
[Unit]
Description=Deepmarks nightly strfry export → Linode Object Storage
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStart=$STRFRY_BACKUP_SCRIPT
StandardOutput=journal
StandardError=journal
EOF

cat > "$UNIT_DIR/deepmarks-restore-test.service" <<EOF
[Unit]
Description=Deepmarks non-destructive backup restore test
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStart=$RESTORE_TEST_SCRIPT
StandardOutput=journal
StandardError=journal
EOF

cat > "$UNIT_DIR/deepmarks-object-storage-safety.service" <<EOF
[Unit]
Description=Deepmarks Object Storage safety smoke test
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=$ENV_FILE
ExecStart=$OBJECT_STORAGE_CHECK_SCRIPT
StandardOutput=journal
StandardError=journal
EOF

cat > "$UNIT_DIR/deepmarks-backup.timer" <<'EOF'
[Unit]
Description=Run Deepmarks Redis backup nightly at 03:15 UTC

[Timer]
OnCalendar=*-*-* 03:15:00 UTC
Persistent=true
# Spread load if multiple hosts ever run the same unit: randomize up to
# 5 minutes so nothing is sharply on the hour.
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
EOF

cat > "$UNIT_DIR/deepmarks-backup-strfry.timer" <<'EOF'
[Unit]
Description=Run Deepmarks strfry backup nightly at 03:35 UTC

[Timer]
OnCalendar=*-*-* 03:35:00 UTC
Persistent=true
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
EOF

cat > "$UNIT_DIR/deepmarks-restore-test.timer" <<'EOF'
[Unit]
Description=Run Deepmarks backup restore test nightly at 04:20 UTC

[Timer]
OnCalendar=*-*-* 04:20:00 UTC
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
EOF

cat > "$UNIT_DIR/deepmarks-object-storage-safety.timer" <<'EOF'
[Unit]
Description=Run Deepmarks Object Storage safety smoke test daily

[Timer]
OnCalendar=*-*-* 04:55:00 UTC
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now \
  deepmarks-backup.timer \
  deepmarks-backup-strfry.timer \
  deepmarks-restore-test.timer \
  deepmarks-object-storage-safety.timer

echo "✓ installed. next run:"
systemctl --user list-timers \
  deepmarks-backup.timer \
  deepmarks-backup-strfry.timer \
  deepmarks-restore-test.timer \
  deepmarks-object-storage-safety.timer \
  --no-pager | head -8
