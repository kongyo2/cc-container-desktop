#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cc_apt_install python3 python3-venv python3-dev python3-pip

python3 -m venv /opt/pytools
/opt/pytools/bin/pip install --no-cache-dir --upgrade pip
/opt/pytools/bin/pip install --no-cache-dir \
  "uv==$(cc_lock '.python.packages.uv')" \
  "poetry==$(cc_lock '.python.packages.poetry')" \
  "pytest==$(cc_lock '.python.packages.pytest')" \
  "ruff==$(cc_lock '.python.packages.ruff')" \
  "mypy==$(cc_lock '.python.packages.mypy')" \
  "black==$(cc_lock '.python.packages.black')"
cc_link_bins /opt/pytools/bin uv uvx poetry pytest ruff mypy black

uv --version && poetry --version && pytest --version && ruff --version && mypy --version && black --version

cc_profile_append cc-python.sh \
  '# cc-container-desktop: python tooling' \
  'export UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-/home/claude/.local/bin}"' \
  'export PIP_DISABLE_PIP_VERSION_CHECK=1'

rm -rf /root/.cache /tmp/*
