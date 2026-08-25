#!/usr/bin/env bash
#
# Runs ONCE, at image build time, as root.
#
# This is the equivalent of a Claude Code cloud environment's setup script: what
# it installs is baked into the image, which then acts as the snapshot every new
# session starts from. Put slow, stable things here — toolchains, language
# runtimes, package managers — and they survive "New session" for free.
#
#   Dockerfile      the base image
#   setup.sh        runs at BUILD time  -> baked in, survives a reset   (this file)
#   post-create.sh  runs at START time  -> re-applied on every session
#
# Editing this file marks the image stale; rebuild it from the Image tab.

set -euxo pipefail

# --- extra apt packages ------------------------------------------------------
# apt-get update
# apt-get install -y --no-install-recommends postgresql-client redis-tools
# rm -rf /var/lib/apt/lists/*

# --- global npm packages -----------------------------------------------------
# Installed as root into /usr/local, deliberately outside /home/claude: the home
# directory is a volume, and anything installed there would be frozen at
# whatever first populated it and lost on a reset.
# npm install -g pnpm yarn typescript

# --- python tooling ----------------------------------------------------------
# PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install ruff
# PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install uv

# --- anything else -----------------------------------------------------------
# curl -fsSL https://example.com/tool | sh -s -- --prefix /usr/local

echo "setup: ok"
