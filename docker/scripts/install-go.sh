#!/usr/bin/env bash
set -euo pipefail
. "$(dirname "$0")/lib.sh"

go_url="$(cc_lock_platform_field '.go.archives' 'url')"
go_sha="$(cc_lock_platform_field '.go.archives' 'sha256')"
cc_fetch_verified "$go_url" "$go_sha" /tmp/go.tar.gz
rm -rf /usr/local/go
tar -xz -C /usr/local -f /tmp/go.tar.gz
rm -f /tmp/go.tar.gz
cc_link_bins /usr/local/go/bin go gofmt
test "$(go version | awk '{print $3}')" = "go$(cc_lock '.go.version')"

cc_profile_append cc-go.sh \
  '# cc-container-desktop: go toolchain' \
  'export GOPATH="${GOPATH:-/home/claude/go}"' \
  'export PATH="${PATH}:/usr/local/go/bin:${GOPATH}/bin"'

mkdir -p /home/claude/go/bin && chown -R 1000:1000 /home/claude/go
rm -rf /root/.cache /tmp/*
