#!/usr/bin/env bash
# Pull latest from main and rebuild + restart the local box's stack.
# Run from anywhere on the box:
#   /opt/deepmarks-repo/deploy/deploy.sh a   # Box A
#   /opt/deepmarks-repo/deploy/deploy.sh b   # Box B
#   /opt/deepmarks-repo/deploy/deploy.sh a payment-proxy
set -euo pipefail

ROLE="${1:-}"
case "$ROLE" in
  a|b|c) ;;
  *) echo "usage: $0 a|b|c [compose-service ...]"; exit 2 ;;
esac
shift || true

SERVICES=("$@")
for service in "${SERVICES[@]}"; do
  if ! [[ "$service" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]]; then
    echo "✗ invalid compose service name: $service" >&2
    exit 2
  fi
done

REPO="/opt/deepmarks-repo"
DEPLOY_DIR="$REPO/deploy/box-$ROLE"
ENV_FILE="$DEPLOY_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "✗ $ENV_FILE missing — copy .env.example and fill it in (chmod 600)"
  exit 1
fi

echo "→ git pull"
git -C "$REPO" pull --ff-only

cd "$DEPLOY_DIR"

if [ "${#SERVICES[@]}" -gt 0 ]; then
  echo "→ docker compose build ${SERVICES[*]}"
  docker compose build "${SERVICES[@]}"

  echo "→ docker compose up -d --no-deps ${SERVICES[*]}"
  docker compose up -d --no-deps "${SERVICES[@]}"
else
  echo "→ docker compose build"
  docker compose build

  echo "→ docker compose up -d"
  docker compose up -d
fi

if [ "$ROLE" = "a" ] && { [ "${#SERVICES[@]}" -eq 0 ] || [[ " ${SERVICES[*]} " == *" caddy "* ]]; }; then
  echo "→ docker compose up -d --force-recreate --no-deps caddy"
  docker compose up -d --force-recreate --no-deps caddy

  echo "→ caddy reload"
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile \
    || docker compose restart caddy
fi

echo "→ docker compose ps"
docker compose ps
