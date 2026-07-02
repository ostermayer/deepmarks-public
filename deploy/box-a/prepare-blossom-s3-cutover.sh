#!/usr/bin/env bash
# Prepare the named Blossom data volume for S3 mode by copying only the
# SQLite index from the old anonymous /app/data volume. Blob bytes should
# already have been uploaded by migrate-blossom-to-s3.sh.
set -euo pipefail

cd "$(dirname "$0")"

container="$(docker compose ps -q blossom-server)"
if [ -z "$container" ]; then
  echo "blossom-server container is not running" >&2
  exit 1
fi

old_volume="$(
  docker inspect "$container" \
    --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}'
)"
if [ -z "$old_volume" ]; then
  echo "could not find current /app/data volume" >&2
  exit 1
fi

project="${COMPOSE_PROJECT_NAME:-$(basename "$PWD")}"
new_volume="${project}_blossom-data"

echo "old volume: $old_volume"
echo "new volume: $new_volume"

docker volume create "$new_volume" >/dev/null

echo "stopping blossom-server for a consistent SQLite copy"
docker compose stop blossom-server

docker run --rm \
  -v "$old_volume:/from:ro" \
  -v "$new_volume:/to" \
  redis:7-alpine \
  sh -lc 'set -e; cp -a /from/sqlite.db* /to/ 2>/dev/null || true; mkdir -p /to/s3-tmp; chmod 755 /to /to/s3-tmp'

echo "$old_volume" > .blossom-old-volume
echo "copied SQLite index. Old volume recorded in deploy/box-a/.blossom-old-volume"
