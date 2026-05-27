#!/usr/bin/env bash
# Pre-flight check for local dev — reports what's installed, what's missing,
# and how to fix each gap. Exits 0 if everything is green.
#
#   ./doctor.sh

set -u
cd "$(dirname "$0")"
ROOT="$(pwd)"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
RESET='\033[0m'

FAIL=0
WARN=0

ok()   { printf "  ${GREEN}✓${RESET} %s\n" "$*"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$*"; FAIL=$((FAIL+1)); }
warn() { printf "  ${YELLOW}!${RESET} %s\n" "$*"; WARN=$((WARN+1)); }
fix()  { printf "     ${DIM}$ %s${RESET}\n" "$*"; }
section() { printf "\n${CYAN}── %s ──${RESET}\n" "$*"; }

# ── toolchain ────────────────────────────────────────────────────────────
section "toolchain"

if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -v | sed 's/^v//')
  NODE_MAJOR=$(echo "$NODE_V" | cut -d. -f1)
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "node $NODE_V (≥20 required)"
  else
    fail "node $NODE_V — need ≥20"
    fix "brew install node"
  fi
else
  fail "node not installed"
  fix "brew install node"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v)"
else
  fail "npm not installed"
fi

# ── redis ────────────────────────────────────────────────────────────────
section "redis"

if (echo >/dev/tcp/127.0.0.1/6379) 2>/dev/null; then
  ok "redis running on :6379"
elif command -v redis-server >/dev/null 2>&1; then
  warn "redis-server installed but not running"
  fix "brew services start redis    (or ./dev.sh will launch it)"
else
  fail "redis-server not installed"
  fix "brew install redis"
fi

# ── per-service installs ─────────────────────────────────────────────────
check_service() {
  local name="$1" dir="$2"
  section "$name"

  if [ ! -f "$dir/package.json" ]; then
    fail "$dir/package.json missing"
    return
  fi

  if [ -d "$dir/node_modules" ]; then
    ok "node_modules installed"
  else
    fail "node_modules missing"
    fix "cd $dir && npm install"
  fi
}

check_service "frontend"       "$ROOT/frontend"
check_service "payment-proxy"  "$ROOT/payment-proxy"
check_service "archive-worker" "$ROOT/archive-worker"

# ── playwright chromium (archive-worker needs it for rendering) ──────────
section "playwright chromium (archive-worker)"

PLAYWRIGHT_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/Library/Caches/ms-playwright}"
if [ -d "$PLAYWRIGHT_CACHE" ] && ls "$PLAYWRIGHT_CACHE" 2>/dev/null | grep -q "^chromium-"; then
  ok "chromium installed at $PLAYWRIGHT_CACHE"
else
  fail "chromium not installed — archive jobs will fail"
  fix "cd $ROOT/archive-worker && npx playwright install chromium"
fi

# ── .env files ───────────────────────────────────────────────────────────
check_env() {
  local name="$1" dir="$2" required_keys="$3"
  section "$name/.env"

  if [ ! -f "$dir/.env" ]; then
    fail ".env missing"
    fix "cp $dir/.env.example $dir/.env   # then edit"
    return
  fi

  ok ".env exists"

  IFS=' ' read -r -a keys <<< "$required_keys"
  for key in "${keys[@]}"; do
    local line value
    line=$(grep -E "^${key}=" "$dir/.env" 2>/dev/null | tail -1 || true)
    if [ -z "$line" ]; then
      fail "$key not in .env"
      continue
    fi
    value="${line#${key}=}"
    if [ -z "$value" ]; then
      warn "$key is blank"
    elif echo "$value" | grep -qE '^(your-|nsec1\.\.\.|0201036c6e64\.\.\.)'; then
      warn "$key still has a placeholder value"
    else
      ok "$key set"
    fi
  done
}

check_env "payment-proxy"  "$ROOT/payment-proxy"  "DEEPMARKS_NSEC REDIS_URL PORT"
check_env "archive-worker" "$ROOT/archive-worker" "REDIS_URL"

# ── ports ────────────────────────────────────────────────────────────────
section "port availability"

check_port() {
  local label="$1" port="$2"
  if (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
    warn "$label port :$port already in use (may collide with dev.sh)"
    fix "lsof -iTCP:$port -sTCP:LISTEN    # find the process"
  else
    ok "$label port :$port free"
  fi
}

check_port "frontend"      5173
check_port "payment-proxy" 4000
# port 6379 checked above under redis.

# ── summary ──────────────────────────────────────────────────────────────
echo ""
if [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  printf "${GREEN}all green — ready to run: ./dev.sh${RESET}\n"
  exit 0
elif [ "$FAIL" -eq 0 ]; then
  printf "${YELLOW}$WARN warning(s) — dev.sh will still run, some features may be degraded${RESET}\n"
  exit 0
else
  printf "${RED}$FAIL blocker(s), $WARN warning(s) — fix the failures above, then re-run ./doctor.sh${RESET}\n"
  exit 1
fi
