#!/usr/bin/env bash
set -euo pipefail

CC_BUILD_DIR="${CC_BUILD_DIR:-/opt/cc-build}"
CC_LOCK="${CC_LOCK:-${CC_BUILD_DIR}/image-versions.lock.json}"

export DEBIAN_FRONTEND=noninteractive

CC_EXTRA_CA="${CC_BUILD_DIR}/extra-ca.crt"
if [ -s "$CC_EXTRA_CA" ]; then
  export CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
  export SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
  export REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
  export PIP_CERT=/etc/ssl/certs/ca-certificates.crt
  export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt
  export CARGO_HTTP_CAINFO=/etc/ssl/certs/ca-certificates.crt
  export GIT_SSL_CAINFO=/etc/ssl/certs/ca-certificates.crt
fi

cc_arch() {
  if [ -n "${TARGETARCH:-}" ]; then
    printf '%s' "$TARGETARCH"
  else
    dpkg --print-architecture
  fi
}

cc_platform() {
  printf 'linux/%s' "$(cc_arch)"
}

cc_lock() {
  jq -er "$1" "$CC_LOCK"
}

cc_lock_platform_field() {
  local path="$1" field="$2"
  jq -er --arg platform "$(cc_platform)" "${path}[\$platform].${field}" "$CC_LOCK"
}

cc_fetch_verified() {
  local url="$1" sha256="$2" out="$3"
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 -o "$out" "$url"
  printf '%s  %s\n' "$sha256" "$out" | sha256sum -c --strict --quiet -
}

cc_apt_install() {
  apt-get update
  apt-get install -y --no-install-recommends "$@"
  rm -rf /var/lib/apt/lists/*
}

cc_profile_append() {
  local file="/etc/profile.d/$1"
  shift
  printf '%s\n' "$@" >> "$file"
  chmod 0644 "$file"
}

cc_link_bins() {
  local dir="$1"
  shift
  local name
  for name in "$@"; do
    ln -sfn "${dir}/${name}" "/usr/local/bin/${name}"
  done
}
