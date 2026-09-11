#!/usr/bin/env bash
# Full variant extras (on top of web + python + go + rust + jvm + ruby):
# PHP, C/C++ toolchain, Conan, PostgreSQL, Redis, SQLite, Docker CLI.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

cc_apt_install \
  php-cli php-mbstring php-xml php-curl php-zip php-intl php-sqlite3 php-pgsql composer \
  gdb clang lld cmake ninja-build autoconf automake libtool bison \
  libsqlite3-dev libpq-dev libxml2-dev libxslt1-dev \
  postgresql-16 postgresql-client-16 redis-server redis-tools sqlite3

/opt/pytools/bin/pip install --no-cache-dir "conan==$(cc_lock '.python.packages.conan')"
cc_link_bins /opt/pytools/bin conan
conan --version

# Docker CLI, Compose and Buildx from Docker's apt repository. No daemon.
install -m 0755 -d /etc/apt/keyrings
curl -fsSL --retry 5 --retry-all-errors "$(cc_lock '.apt.repositories.docker')/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
codename="$(. /etc/os-release && echo "$VERSION_CODENAME")"
echo "deb [arch=$(cc_arch) signed-by=/etc/apt/keyrings/docker.asc] $(cc_lock '.apt.repositories.docker') ${codename} stable" \
  > /etc/apt/sources.list.d/docker.list
cc_apt_install docker-ce-cli docker-buildx-plugin docker-compose-plugin
docker --version && docker compose version && docker buildx version

# PostgreSQL / Redis are installed but not started; the README explains how.
service postgresql stop 2>/dev/null || true
service redis-server stop 2>/dev/null || true

rm -rf /root/.cache /root/.composer /tmp/*
