#!/usr/bin/env bash
#
# Runs inside the container as the `claude` user, every time the app starts it.
# Keep it idempotent — it is not a one-shot bootstrap.
#
# This is your hook for anything that belongs to the *running* container rather
# than the image: extra npm globals, pip packages, git identity, dotfiles.
# Edit it from the app's Image tab; it is pushed in and executed on each start.

set -euo pipefail

# --- git identity -----------------------------------------------------------
# git config --global user.name  "Your Name"
# git config --global user.email "you@example.com"
git config --global --get init.defaultBranch >/dev/null 2>&1 || git config --global init.defaultBranch main
git config --global --get safe.directory >/dev/null 2>&1 || git config --global --add safe.directory '*'

# --- extra tooling ----------------------------------------------------------
# npm install -g pnpm typescript
# pipx install ruff

# --- shell niceties ---------------------------------------------------------
if ! grep -q 'cc-workbench' "${HOME}/.bashrc" 2>/dev/null; then
  cat >> "${HOME}/.bashrc" <<'EOF'

# --- cc-workbench ---
export PATH="${HOME}/.local/bin:${PATH}"
alias ll='ls -alF'
alias cc='claude'
# --- /cc-workbench ---
EOF
fi

echo "post-create: ok ($(claude --version 2>/dev/null || echo 'claude not on PATH'))"
