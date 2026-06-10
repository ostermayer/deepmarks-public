#!/usr/bin/env bash
# push-deploy.sh — one-command path from local changes to live boxes.
#   1. optional: stage-all + commit with a message
#   2. git push to main
#   3. for each selected box, SSH in and run the server-side deploy.sh
#
# Usage:
#   ./deploy/push-deploy.sh                   # push only (commit yourself first)
#   ./deploy/push-deploy.sh -m "fix x"        # add+commit everything then push
#   ./deploy/push-deploy.sh -m "..." --only a # push + deploy Box A only
#   ./deploy/push-deploy.sh --skip-remote     # push but don't poke boxes
#
# Boxes don't affect CF Pages — Pages auto-rebuilds from GitHub on every push.
# This script only matters for the docker stacks on Box A / Box B / Box C.

set -euo pipefail

# Box SSH targets live in deploy/.env.local (gitignored). Copy
# deploy/.env.local.example → deploy/.env.local and fill in.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_ENV="$SCRIPT_DIR/.env.local"
if [ ! -f "$LOCAL_ENV" ]; then
  echo "✗ $LOCAL_ENV missing — copy .env.local.example and fill in box SSH targets." >&2
  exit 1
fi
set -a
# shellcheck source=/dev/null
. "$LOCAL_ENV"
set +a
: "${BOX_A_SSH:?BOX_A_SSH not set in $LOCAL_ENV}"
: "${BOX_B_SSH:?BOX_B_SSH not set in $LOCAL_ENV}"
: "${BOX_C_SSH:?BOX_C_SSH not set in $LOCAL_ENV}"

MESSAGE=""
ONLY=""
SKIP_REMOTE=0

while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message) MESSAGE="$2"; shift 2 ;;
    --only)       ONLY="$2"; shift 2 ;;
    --skip-remote) SKIP_REMOTE=1; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $1"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

# ── 1. commit (optional) ────────────────────────────────────────────────
if [ -n "$MESSAGE" ]; then
  echo "→ git add + commit"
  git add -A
  if git diff --cached --quiet; then
    echo "  (no staged changes — skipping commit)"
  else
    git commit -m "$MESSAGE"
  fi
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "✗ working tree has uncommitted changes. Commit them or pass -m \"msg\"."
  git status --short
  exit 1
fi

# ── 2. push ─────────────────────────────────────────────────────────────
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "→ git push origin $BRANCH"
git push origin "$BRANCH"

if [ "$SKIP_REMOTE" = "1" ]; then
  echo "✓ pushed. Skipping remote deploy per --skip-remote."
  exit 0
fi

# ── 3. pull + compose up on each box ────────────────────────────────────
deploy_box() {
  local role="$1" host="$2"
  echo
  echo "══ Box $(echo "$role" | tr a-z A-Z): $host ══"
  # shellcheck disable=SC2029
  ssh -o ConnectTimeout=10 "$host" "/opt/deepmarks-repo/deploy/deploy.sh $role"
}

case "$ONLY" in
  a) deploy_box a "$BOX_A_SSH" ;;
  b) deploy_box b "$BOX_B_SSH" ;;
  c) deploy_box c "$BOX_C_SSH" ;;
  "")
    deploy_box a "$BOX_A_SSH"
    deploy_box b "$BOX_B_SSH"
    deploy_box c "$BOX_C_SSH"
    ;;
  *) echo "unknown --only value: $ONLY (expected a, b, or c)"; exit 2 ;;
esac

echo
echo "✓ push-deploy complete."
