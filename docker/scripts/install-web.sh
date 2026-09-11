#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"

export PATH="/opt/node/bin:${PATH}"
export NPM_CONFIG_PREFIX=/usr/local
export NPM_CONFIG_UPDATE_NOTIFIER=false

npm install -g --no-fund --no-audit \
  "pnpm@$(cc_lock '.npmGlobals.pnpm')" \
  "yarn@$(cc_lock '.npmGlobals.yarn')" \
  "typescript@$(cc_lock '.npmGlobals.typescript')" \
  "eslint@$(cc_lock '.npmGlobals.eslint')" \
  "prettier@$(cc_lock '.npmGlobals.prettier')"
npm cache clean --force
pnpm --version && yarn --version && tsc --version && eslint --version && prettier --version

bun_url="$(cc_lock_platform_field '.bun.archives' 'url')"
bun_sha="$(cc_lock_platform_field '.bun.archives' 'sha256')"
cc_fetch_verified "$bun_url" "$bun_sha" /tmp/bun.zip
mkdir -p /opt/bun/bin /tmp/bun
unzip -q /tmp/bun.zip -d /tmp/bun
mv /tmp/bun/*/bun /opt/bun/bin/bun
chmod 0755 /opt/bun/bin/bun
ln -sf /opt/bun/bin/bun /opt/bun/bin/bunx
cc_link_bins /opt/bun/bin bun bunx
rm -rf /tmp/bun /tmp/bun.zip
test "$(bun --version)" = "$(cc_lock '.bun.version')"

rm -rf /root/.cache /root/.npm /root/.bun /tmp/*
