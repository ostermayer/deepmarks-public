#!/usr/bin/env bash
# Upload the existing Blossom local blob volume into the configured S3 bucket.
# Run from deploy/box-a on Box A before switching blossom-server to S3 storage.
set -euo pipefail

cd "$(dirname "$0")"

container="$(docker compose ps -q blossom-server)"
if [ -z "$container" ]; then
  echo "blossom-server container is not running" >&2
  exit 1
fi

docker cp ./blossom-s3-migrate.ts "$container:/tmp/blossom-s3-migrate.ts"
docker exec \
  -e MIGRATE_CONCURRENCY="${MIGRATE_CONCURRENCY:-3}" \
  "$container" \
  sh -lc 'cd /app && deno run --config /app/deno.json --allow-read=/app/data/blobs,/tmp --allow-env=S3_ENDPOINT,S3_REGION,S3_BUCKET,S3_ACCESS_KEY,S3_SECRET_KEY,MIGRATE_CONCURRENCY --allow-net /tmp/blossom-s3-migrate.ts /app/data/blobs'
