#!/usr/bin/env bash
# Install deepmarks-* monitoring scripts on the current box.
#
# What this does:
#   1. Copies deepmarks-alert + deepmarks-resource-check to /usr/local/bin
#   2. On Box C only, also copies deepmarks-uptime-check
#   3. Creates /etc/deepmarks-monitoring.env from MONITORING_ENV passed in,
#      OR prints a template to stderr and refuses to overwrite if the file
#      already exists (caller fills in secrets)
#   4. Installs cron entries
#
# Run as root on each box.
#
#   sudo BOX=a ./install.sh        # box A
#   sudo BOX=b ./install.sh        # box B
#   sudo BOX=c ./install.sh        # box C (uptime checker installed)

set -euo pipefail

BOX="${BOX:-}"
case "$BOX" in
  a|b|c) ;;
  *) echo "set BOX=a|b|c" >&2; exit 1 ;;
esac

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (sudo)" >&2
  exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)

install -m 755 "$SCRIPT_DIR/deepmarks-alert"          /usr/local/bin/deepmarks-alert
install -m 755 "$SCRIPT_DIR/deepmarks-resource-check" /usr/local/bin/deepmarks-resource-check
if [ "$BOX" = "c" ]; then
  install -m 755 "$SCRIPT_DIR/deepmarks-uptime-check" /usr/local/bin/deepmarks-uptime-check
fi

ENVF=/etc/deepmarks-monitoring.env
if [ ! -f "$ENVF" ]; then
  cat > "$ENVF" <<EOF
# deepmarks-monitoring config — fill in and save with chmod 600.
RESEND_API_KEY=
ALERT_EMAIL=dan@deepmarks.org
# Quote any value containing '<' or '>' — the env file is sourced
# via `.` so unquoted angle brackets become shell redirections.
EMAIL_FROM="Deepmarks Alerts <alerts@deepmarks.org>"
DEDUP_SECONDS=600
# Box C only — used by deepmarks-uptime-check to probe Box A's redis
# for archive-worker heartbeat. Box A's REDIS_PASSWORD must match.
REDIS_HOST=10.0.0.2
REDIS_PORT=6379
REDIS_PASSWORD=
ARCHIVE_WORKER_HEARTBEAT_KEY=dm:archive:worker-heartbeat
# Box A only — set if you want macaroon-age alerts from
# deepmarks-resource-check. Leave empty to skip.
VOLTAGE_MACAROON_PATH=
EOF
  chmod 600 "$ENVF"
  echo "wrote template $ENVF — fill in RESEND_API_KEY (and REDIS_PASSWORD on Box C) before cron fires"
else
  echo "kept existing $ENVF"
fi

# Cron entries. Use root's crontab so the scripts inherit the env file's
# mode 600 readability.
CRON_TAG="# deepmarks-monitoring"
( crontab -l 2>/dev/null | grep -v "$CRON_TAG" ) > /tmp/dm-cron.tmp || true
{
  cat /tmp/dm-cron.tmp
  echo "$CRON_TAG"
  echo "*/15 * * * * /usr/local/bin/deepmarks-resource-check >/dev/null 2>&1 $CRON_TAG"
  if [ "$BOX" = "c" ]; then
    echo "*/5 * * * * /usr/local/bin/deepmarks-uptime-check >/dev/null 2>&1 $CRON_TAG"
  fi
} > /tmp/dm-cron.new
crontab /tmp/dm-cron.new
rm /tmp/dm-cron.tmp /tmp/dm-cron.new
echo "cron installed:"
crontab -l | grep "$CRON_TAG"

echo
echo "DONE. Edit $ENVF to fill in secrets, then test:"
echo "  /usr/local/bin/deepmarks-alert info test 'install verified' 'Install ran on \$(hostname)'"
