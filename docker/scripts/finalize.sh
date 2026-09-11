#!/usr/bin/env bash
# Runs last in every final target: records what actually got installed into
# /opt/cc/image-info.json (the app and CI compare it with the catalog), keeps a
# copy of the lock for reference, and removes the build scripts.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

variant="${1:?variant}"
release="${IMAGE_RELEASE:?IMAGE_RELEASE}"
revision="${SOURCE_REVISION:-unknown}"
built_at="${BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

# Every version is read the way a user would see it: as the claude user, in a
# login shell, so PATH problems show up here rather than in a task.
probe() {
  local name="$1"
  shift
  local out
  if out="$(su - claude -c "$*" 2>/dev/null | head -n 1)"; then
    printf '%s\t%s\n' "$name" "$out"
  fi
}

versions="$(
  probe node 'node --version'
  probe npm 'npm --version'
  probe claude-code 'claude --version'
  probe git 'git --version'
  probe git-lfs 'git lfs version'
  probe gh 'gh --version'
  probe tmux 'tmux -V'
  probe ripgrep 'rg --version'
  probe fd 'fd --version'
  probe jq 'jq --version'
  probe yq 'yq --version'
  probe curl 'curl --version'
  probe ssh 'ssh -V 2>&1'
  probe build-essential 'gcc --version'
  probe python3-system '/usr/bin/python3 --version'
  probe pnpm 'pnpm --version'
  probe yarn 'yarn --version'
  probe bun 'bun --version'
  probe typescript 'tsc --version'
  probe eslint 'eslint --version'
  probe prettier 'prettier --version'
  probe python3 'python3 --version'
  probe pip '/opt/pytools/bin/pip --version'
  probe venv 'python3 -c "import venv, sys; print(sys.version.split()[0])"'
  probe uv 'uv --version'
  probe poetry 'poetry --version'
  probe pytest 'pytest --version'
  probe ruff 'ruff --version'
  probe mypy 'mypy --version'
  probe black 'black --version'
  probe go 'go version'
  probe rust 'rustc --version'
  probe rustfmt 'rustfmt --version'
  probe clippy 'cargo clippy --version'
  probe openjdk 'java -version 2>&1'
  probe maven 'mvn --version'
  probe gradle 'gradle --version --quiet 2>/dev/null | grep -m1 Gradle'
  probe ruby 'ruby --version'
  probe bundler 'bundle --version'
  probe php 'php --version'
  probe composer 'composer --version --no-ansi 2>/dev/null'
  probe clang 'clang --version'
  probe cmake 'cmake --version'
  probe ninja 'ninja --version'
  probe conan 'conan --version'
  probe postgresql 'psql --version'
  probe redis 'redis-server --version'
  probe sqlite3 'sqlite3 --version'
  probe docker-cli 'docker --version'
  probe docker-compose 'docker compose version'
  probe docker-buildx 'docker buildx version'
)"

# The first version-looking token of each probe line, so "git version 2.43.0"
# becomes "2.43.0" and "go version go1.27.1 linux/amd64" becomes "1.27.1".
tools_json="$(
  printf '%s\n' "$versions" | jq -R -s '
    split("\n") | map(select(length > 0) | split("\t")) |
    map((.[1] // "") as $raw | {
      key: .[0],
      value: (([$raw | match("[0-9]+\\.[0-9]+(\\.[0-9]+)?([-+.][0-9A-Za-z]+)*")] | .[0].string) // $raw)
    }) | from_entries'
)"

base_digest="$(jq -r --arg p "$(cc_platform)" '.base.platforms[$p] // ""' "$CC_LOCK")"

mkdir -p /opt/cc
cp "$CC_LOCK" /opt/cc/image-versions.lock.json
jq -n \
  --arg variant "$variant" \
  --arg release "$release" \
  --arg revision "$revision" \
  --arg builtAt "$built_at" \
  --arg platform "$(cc_platform)" \
  --arg baseImage "$(cc_lock '.base.image')" \
  --arg baseTag "$(cc_lock '.base.tag')" \
  --arg baseDigest "$base_digest" \
  --argjson tools "$tools_json" \
  '{
    schemaVersion: 1,
    project: "cc-container-desktop",
    variant: $variant,
    release: $release,
    runtimeContract: 1,
    sourceRevision: $revision,
    builtAt: $builtAt,
    platform: $platform,
    base: { image: $baseImage, tag: $baseTag, digest: $baseDigest },
    tools: $tools
  }' > /opt/cc/image-info.json
chmod 0644 /opt/cc/image-info.json /opt/cc/image-versions.lock.json

# Record apt package versions for the provenance trail (not read by the app).
dpkg-query -W -f='${Package}\t${Version}\n' | sort > /opt/cc/apt-packages.txt
chmod 0644 /opt/cc/apt-packages.txt

rm -rf /opt/cc-build /root/.cache /root/.npm /tmp/* /var/lib/apt/lists/*
cat /opt/cc/image-info.json
