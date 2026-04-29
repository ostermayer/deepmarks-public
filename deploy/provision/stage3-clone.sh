#!/usr/bin/env bash
# Stage 3 — generate a deploy key, clone the repo, wire SSH config.
# Run as the non-root user (dan) after stage 1 + 2.
#
# Usage:
#   ./stage3-clone.sh
# Prints the public key at the end — add it to GitHub as a read-only
# deploy key, then re-run this script to finish the clone.
set -euo pipefail

REPO_URL="git@github.com:ostermayer/deepmarks-public.git"
REPO_DIR="/opt/deepmarks-repo"
KEY="$HOME/.ssh/github-deploy"

if [ ! -f "$KEY" ]; then
  echo "→ generating deploy key"
  ssh-keygen -t ed25519 -N '' -f "$KEY" -C "$(hostname)@deepmarks" >/dev/null
fi

if ! grep -q '^Host github.com' "$HOME/.ssh/config" 2>/dev/null; then
  echo "→ writing ~/.ssh/config"
  cat >> "$HOME/.ssh/config" <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
EOF
  chmod 600 "$HOME/.ssh/config"
fi

# Probe github auth before attempting the clone. GitHub always returns
# exit code 1 from `ssh -T` (it closes the connection after the greeting),
# which combined with `set -o pipefail` would incorrectly flag a *successful*
# auth as failed. Capture the output first, then grep the stored value.
probe_output=$(ssh -o StrictHostKeyChecking=accept-new -T git@github.com 2>&1 || true)
if ! echo "$probe_output" | grep -q 'successfully authenticated'; then
  echo
  echo "✗ GitHub deploy key not yet registered. Add this public key at:"
  echo "   https://github.com/ostermayer/deepmarks-public/settings/keys"
  echo "   (leave 'Allow write access' UNCHECKED)"
  echo
  cat "$KEY.pub"
  echo
  echo "Then re-run this script to finish the clone."
  exit 1
fi

if [ ! -d "$REPO_DIR/.git" ]; then
  echo "→ cloning $REPO_URL to $REPO_DIR"
  sudo mkdir -p "$REPO_DIR"
  sudo chown "$USER:$USER" "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
else
  echo "→ $REPO_DIR already cloned; pulling latest"
  git -C "$REPO_DIR" pull --ff-only
fi

echo "✓ stage 3 complete. Next: copy deploy/box-{a,b}/.env.example → .env,"
echo "  fill in secrets (chmod 600), then run $REPO_DIR/deploy/deploy.sh {a|b}."
