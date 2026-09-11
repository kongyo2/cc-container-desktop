#!/usr/bin/env bash
set -euo pipefail

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg lsb-release \
  git git-lfs openssh-client tmux ripgrep fd-find jq less nano vim \
  procps psmisc htop tree unzip zip xz-utils bzip2 file rsync sudo \
  build-essential pkg-config python3
rm -rf /var/lib/apt/lists/*

if [ -s /run/secrets/build-ca-bundle ]; then
  install -m 0644 /run/secrets/build-ca-bundle /opt/cc-build/extra-ca.crt
  install -m 0644 /run/secrets/build-ca-bundle /usr/local/share/ca-certificates/cc-build-extra-ca.crt
  update-ca-certificates >/dev/null
fi

. "$(dirname "$0")/lib.sh"

ln -sf /usr/bin/fdfind /usr/local/bin/fd

install -m 0755 -d /etc/apt/keyrings
curl -fsSL --retry 5 --retry-all-errors "$(cc_lock '.apt.repositories.githubCli')/githubcli-archive-keyring.gpg" \
  -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
chmod a+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(cc_arch) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] $(cc_lock '.apt.repositories.githubCli') stable main" \
  > /etc/apt/sources.list.d/github-cli.list
cc_apt_install gh

node_url="$(cc_lock_platform_field '.node.archives' 'url')"
node_sha="$(cc_lock_platform_field '.node.archives' 'sha256')"
cc_fetch_verified "$node_url" "$node_sha" /tmp/node.tar.xz
mkdir -p /opt/node
tar -xJ -C /opt/node --strip-components=1 -f /tmp/node.tar.xz
rm -f /tmp/node.tar.xz
cc_link_bins /opt/node/bin node npm npx corepack
test "$(/opt/node/bin/node --version)" = "v$(cc_lock '.node.version')"

export PATH="/opt/node/bin:${PATH}"
export NPM_CONFIG_PREFIX=/usr/local
export NPM_CONFIG_UPDATE_NOTIFIER=false

claude_version="$(cc_lock '.claudeCode.version')"
npm install -g --no-fund --no-audit "$(cc_lock '.claudeCode.package')@${claude_version}"
npm cache clean --force
test -x /usr/local/bin/claude
claude_reported="$(claude --version 2>/dev/null | head -n 1 || true)"
case "$claude_reported" in
  *"$claude_version"*) ;;
  *) echo "claude --version reported '${claude_reported}', expected ${claude_version}" >&2; exit 1 ;;
esac

yq_url="$(cc_lock_platform_field '.yq.binaries' 'url')"
yq_sha="$(cc_lock_platform_field '.yq.binaries' 'sha256')"
cc_fetch_verified "$yq_url" "$yq_sha" /usr/local/bin/yq
chmod 0755 /usr/local/bin/yq
yq --version

touch /var/mail/ubuntu
userdel -r ubuntu 2>/dev/null || true
groupadd -g 1000 claude
useradd -m -u 1000 -g 1000 -s /bin/bash claude
printf 'claude ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/claude
chmod 0440 /etc/sudoers.d/claude
git config --system init.defaultBranch main
git config --system --add safe.directory '*'
git lfs install --system --skip-repo

mkdir -p /opt/cc && chmod 0755 /opt/cc
mkdir -p /home/claude/workspace /home/claude/.local/bin
chown -R 1000:1000 /home/claude

cc_profile_append cc-container-desktop.sh \
  '# cc-container-desktop: paths of the tools this image ships' \
  'export PATH="/home/claude/.local/bin:/usr/local/bin:/opt/node/bin:${PATH}"' \
  'export NPM_CONFIG_PREFIX=/usr/local' \
  'export NPM_CONFIG_UPDATE_NOTIFIER=false' \
  'export DISABLE_AUTOUPDATER=1' \
  'export LANG="${LANG:-C.UTF-8}"'

printf '%s\n' '' '# --- cc-container-desktop ---' "alias ll='ls -alF'" "alias cc='claude'" '# --- /cc-container-desktop ---' \
  >> /etc/bash.bashrc

rm -rf /root/.cache /root/.npm /tmp/*
