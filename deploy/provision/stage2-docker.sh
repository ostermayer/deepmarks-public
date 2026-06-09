#!/usr/bin/env bash
# Stage 2 — install Docker Engine + Compose plugin on Deepmarks boxes.
# Idempotent: skips install if already present. Adds `dan` to the docker group.
#
# Run via: ssh dan@BOX 'sudo bash -s' < stage2.sh
set -euo pipefail

HUMAN_USER="dan"

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "✓ docker + compose already installed ($(docker --version))"
else
  echo "→ installing Docker via official script"
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://get.docker.com | sh
fi

echo "→ adding $HUMAN_USER to docker group"
usermod -aG docker "$HUMAN_USER"

echo "→ enabling docker to start on boot"
systemctl enable --now docker >/dev/null

echo "→ verifying"
docker --version
docker compose version

echo "✓ stage 2 complete. Log out + back in as $HUMAN_USER so group membership takes effect."
