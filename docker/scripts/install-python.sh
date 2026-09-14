#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cc_apt_install python3 python3-venv python3-dev

python3 -m venv /opt/pytools
/opt/pytools/bin/pip install --no-cache-dir --upgrade "pip==$(cc_lock '.python.packages.pip')"
/opt/pytools/bin/pip install --no-cache-dir \
  "uv==$(cc_lock '.python.packages.uv')" \
  "poetry==$(cc_lock '.python.packages.poetry')" \
  "pytest==$(cc_lock '.python.packages.pytest')" \
  "ruff==$(cc_lock '.python.packages.ruff')" \
  "mypy==$(cc_lock '.python.packages.mypy')" \
  "black==$(cc_lock '.python.packages.black')"
cc_link_bins /opt/pytools/bin pip pip3 uv uvx poetry pytest ruff mypy black
chown -R 1000:1000 /opt/pytools

export PATH="/opt/pytools/bin:${PATH}"
test "$(python3 -c 'import sys; print(sys.prefix)')" = /opt/pytools
test "$(pip --version | awk '{print $2}')" = "$(cc_lock '.python.packages.pip')"
test "$(/usr/local/bin/pip --version | awk '{print $2}')" = "$(cc_lock '.python.packages.pip')"
uv --version && poetry --version && pytest --version && ruff --version && mypy --version && black --version

cc_profile_append cc-python.sh \
  '# cc-container-desktop: python tooling (python3, pip and the tools are the /opt/pytools venv)' \
  'export PATH="/home/claude/.local/bin:/opt/pytools/bin:${PATH}"' \
  'export UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-/home/claude/.local/bin}"' \
  'export PIP_DISABLE_PIP_VERSION_CHECK=1'

rm -rf /root/.cache /tmp/*
