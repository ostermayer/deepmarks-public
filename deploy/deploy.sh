#!/usr/bin/env bash
# Pull latest from main and rebuild + restart the local box's stack.
# Run from anywhere on the box:
#   /opt/deepmarks-repo/deploy/deploy.sh a   # Box A
#   /opt/deepmarks-repo/deploy/deploy.sh b   # Box B
set -euo pipefail

ROLE="${1:-}"
case "$ROLE" in
  a|b|c) ;;
  *) echo "usage: $0 a|b|c"; exit 2 ;;
esac

REPO="/opt/deepmarks-repo"
DEPLOY_DIR="$REPO/deploy/box-$ROLE"
ENV_FILE="$DEPLOY_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE missing — copy .env.example and fill it in (chmod 600)"
  exit 1
fi

echo "→ git pull"
git -C "$REPO" pull --ff-only

echo "→ docker compose build"
cd "$DEPLOY_DIR"
docker compose build

echo "→ docker compose up -d"
docker compose up -d

echo "→ docker compose ps"
docker compose ps
