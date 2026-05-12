#!/usr/bin/env bash
# One-time system setup on Box C before the first bunker deploy.
# Idempotent — safe to rerun. Creates the bunker system user at a pinned
# uid/gid so Docker bind-mounts align with host ownership, then ensures
# the nsec + audit directories exist with correct permissions.
#
# Usage:
#   sudo bash /opt/deepmarks-repo/deploy/box-c/setup-system.sh
set -euo pipefail

BUNKER_UID=900
BUNKER_GID=900
NSEC_DIR=/opt/deepmarks-bunker/nsecs
LOG_DIR=/var/log/deepmarks-bunker

if [[ $EUID -ne 0 ]]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

# ── user + group ─────────────────────────────────────────────────────
if ! getent group bunker >/dev/null 2>&1; then
  echo "→ creating group bunker (gid $BUNKER_GID)"
  groupadd -r -g "$BUNKER_GID" bunker
fi
if ! id -u bunker >/dev/null 2>&1; then
  echo "→ creating user bunker (uid $BUNKER_UID)"
  useradd -r -u "$BUNKER_UID" -g bunker -M -s /usr/sbin/nologin bunker
fi

# ── directories ──────────────────────────────────────────────────────
echo "→ ensuring $NSEC_DIR chmod 700 bunker:bunker"
mkdir -p "$NSEC_DIR"
chown bunker:bunker "$NSEC_DIR"
chmod 700 "$NSEC_DIR"

echo "→ ensuring $LOG_DIR chmod 750 bunker:bunker"
mkdir -p "$LOG_DIR"
chown bunker:bunker "$LOG_DIR"
chmod 750 "$LOG_DIR"

echo "→ verifying"
ls -ld "$NSEC_DIR" "$LOG_DIR"

echo "✓ box-c system ready."
echo
echo "Next:"
echo "  1. Drop the nsec files at $NSEC_DIR/brand.nsec and $NSEC_DIR/dan.nsec"
echo "     chmod 400, owned by bunker:bunker."
echo "  2. Copy deploy/box-c/.env.example → .env and fill in BUNKER_CLIENT_PUBKEY."
echo "  3. Run /opt/deepmarks-repo/deploy/deploy.sh c"
