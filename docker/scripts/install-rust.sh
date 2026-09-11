#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"

cc_apt_install libssl-dev pkg-config

rustup_url="$(cc_lock_platform_field '.rust.rustup.binaries' 'url')"
rustup_sha="$(cc_lock_platform_field '.rust.rustup.binaries' 'sha256')"
cc_fetch_verified "$rustup_url" "$rustup_sha" /tmp/rustup-init
chmod 0755 /tmp/rustup-init

export RUSTUP_HOME=/opt/rustup
export CARGO_HOME=/opt/cargo
/tmp/rustup-init -y --no-modify-path --profile minimal \
  --default-toolchain "$(cc_lock '.rust.toolchain')" \
  --component rustfmt --component clippy
rm -f /tmp/rustup-init

cc_link_bins /opt/cargo/bin cargo rustc rustup rustfmt cargo-fmt cargo-clippy clippy-driver rustdoc rust-gdb rust-lldb
chown -R 1000:1000 /opt/rustup /opt/cargo
rm -rf /opt/cargo/registry /opt/cargo/git

test "$(/opt/cargo/bin/rustc --version | awk '{print $2}')" = "$(cc_lock '.rust.toolchain')"

cc_profile_append cc-rust.sh \
  '# cc-container-desktop: rust toolchain (rustup proxies live in /opt/cargo/bin)' \
  'export RUSTUP_HOME=/opt/rustup' \
  'export PATH="${PATH}:/home/claude/.cargo/bin"'

rm -rf /root/.cache /tmp/*
