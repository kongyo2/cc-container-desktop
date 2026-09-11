#!/usr/bin/env bash
# Ruby variant: a pinned Ruby built from source into /opt/ruby, plus Bundler.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

cc_apt_install \
  libssl-dev libreadline-dev zlib1g-dev libyaml-dev libffi-dev libgdbm-dev libncurses-dev libgmp-dev \
  autoconf bison

ruby_url="$(cc_lock '.ruby.url')"
ruby_sha="$(cc_lock '.ruby.sha256')"
ruby_version="$(cc_lock '.ruby.version')"
cc_fetch_verified "$ruby_url" "$ruby_sha" /tmp/ruby.tar.xz
mkdir -p /tmp/ruby-src
tar -xJ -C /tmp/ruby-src --strip-components=1 -f /tmp/ruby.tar.xz
(
  cd /tmp/ruby-src
  ./configure --prefix=/opt/ruby --disable-install-doc --enable-shared >/dev/null
  make -j"$(nproc)" >/dev/null
  make install >/dev/null
)
rm -rf /tmp/ruby-src /tmp/ruby.tar.xz

/opt/ruby/bin/gem install bundler --no-document
cc_link_bins /opt/ruby/bin ruby gem bundle bundler irb rake erb rdoc ri
chown -R 1000:1000 /opt/ruby

test "$(ruby -e 'print RUBY_VERSION')" = "$ruby_version"
bundle --version

cc_profile_append cc-ruby.sh \
  '# cc-container-desktop: ruby' \
  'export PATH="${PATH}:/opt/ruby/bin:/home/claude/.local/share/gem/bin"'

rm -rf /root/.cache /root/.gem /tmp/*
