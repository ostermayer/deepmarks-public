#!/usr/bin/env bash
# Single-command local launcher. Boots Redis (if not already running),
# payment-proxy, archive-worker, and frontend. Ctrl+C cleans up everything.
#
#   ./dev.sh             # runs all four
#   ./dev.sh --no-worker # skip archive-worker (needs Playwright + Chromium)
#   ./dev.sh --web-only  # just the frontend

set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(pwd)"
LOG_DIR="$ROOT/.dev-logs"
mkdir -p "$LOG_DIR"

WEB_ONLY=false
RUN_WORKER=true
for arg in "$@"; do
  case "$arg" in
    --web-only) WEB_ONLY=true ;;
    --no-worker) RUN_WORKER=false ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

PIDS=()
cleanup() {
  echo ""
  echo "── shutting down ──"
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  # Give children a beat to exit; then force.
  sleep 1
  for pid in "${PIDS[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  echo "done."
}
trap cleanup INT TERM EXIT

launch() {
  local name="$1"; shift
  local dir="$1"; shift
  local log="$LOG_DIR/$name.log"
  echo "  ▸ $name → $log"
  ( cd "$dir" && "$@" >"$log" 2>&1 ) &
  PIDS+=($!)
}

wait_for_port() {
  local label="$1" port="$2" tries=30
  while (( tries-- > 0 )); do
    if (echo >"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      echo "  ✓ $label up on :$port"
      return 0
    fi
    sleep 0.3
  done
  echo "  ✗ $label did not come up on :$port (check $LOG_DIR)"
  return 1
}

echo ""
echo "━━━ deepmarks dev stack ━━━"

if [ "$WEB_ONLY" = false ]; then
  # ── Redis ─────────────────────────────────────────────────────────────
  if (echo >/dev/tcp/127.0.0.1/6379) 2>/dev/null; then
    echo "  ✓ redis already running on :6379"
  elif command -v redis-server >/dev/null 2>&1; then
    echo "  ▸ starting redis-server → $LOG_DIR/redis.log"
    redis-server --port 6379 --save "" --appendonly no >"$LOG_DIR/redis.log" 2>&1 &
    PIDS+=($!)
    wait_for_port "redis" 6379 || exit 1
  else
    echo "  ✗ redis not running and redis-server not installed."
    echo "    brew install redis   (then re-run ./dev.sh)"
    exit 1
  fi

  # ── payment-proxy ─────────────────────────────────────────────────────
  launch "payment-proxy" "$ROOT/payment-proxy" npm run dev
  wait_for_port "payment-proxy" 4000 || true

  # ── archive-worker ────────────────────────────────────────────────────
  if [ "$RUN_WORKER" = true ]; then
    launch "archive-worker" "$ROOT/archive-worker" npm run dev
    # No port — worker pulls from Redis.
    sleep 1
  else
    echo "  ▸ archive-worker skipped (--no-worker)"
  fi
fi

# ── frontend ──────────────────────────────────────────────────────────
launch "frontend" "$ROOT/frontend" npm run dev
wait_for_port "frontend" 5173 || true

echo ""
echo "── tailing all logs (Ctrl+C to stop everything) ──"
echo ""

# Tail whatever logs exist so the user sees everything in one stream.
# `tail -F` keeps following files that don't exist yet / rotate.
tail -F "$LOG_DIR"/*.log 2>/dev/null
