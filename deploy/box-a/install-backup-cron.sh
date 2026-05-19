#!/usr/bin/env bash
# One-shot install of the nightly Redis backup job.
#
# Run this once on Box A after deploying backup-redis.sh (it's already
# there if /opt/deepmarks-repo is pulled fresh). It writes a systemd
# timer + service pair — preferred over cron because it inherits the
# dan user's docker group membership cleanly and logs to the journal.
#
# Usage:
#   ./install-backup-cron.sh
#
# After install, check status:
#   systemctl --user status deepmarks-backup.timer
#   journalctl --user -u deepmarks-backup.service -n 100
#
# The envfile path is intentionally separate from compose's .env so we
# don't hand the backup job a VOLTAGE_INVOICE_MACAROON it doesn't need.

set -euo pipefail

UNIT_DIR="${HOME}/.config/systemd/user"
ENV_FILE="${HOME}/.config/deepmarks-backup.env"
SCRIPT_PATH="/opt/deepmarks-repo/deploy/box-a/backup-redis.sh"

if [ ! -x "$SCRIPT_PATH" ]; then
  echo "✗ $SCRIPT_PATH not found or not executable" >&2
  exit 1
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
S3_BUCKET=deepmarks-backups
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
ExecStart=$SCRIPT_PATH
# Backups are silent on success; the journal captures stderr on failure.
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

systemctl --user daemon-reload
systemctl --user enable --now deepmarks-backup.timer

echo "✓ installed. next run:"
systemctl --user list-timers deepmarks-backup.timer --no-pager | head -5
