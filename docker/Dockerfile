# Claude Code workbench — the base image every task's container starts from.
#
# Modelled on the Claude Code cloud environment: one fixed image with the common
# language runtimes, build tools and databases already installed. It is never
# edited per project; a task's *environment* (variables + setup script) layers
# what a project needs on top, when the task's container is created.
#
# Two deliberate choices:
#   * Claude Code and every global tool live outside /home/claude. The home
#     directory is a per-task Docker volume; anything installed there at build
#     time would be frozen at whatever first populated the volume.
#   * The app builds this file through the Docker Engine API, which uses the
#     classic (non-BuildKit) builder: no heredocs, no `RUN --mount`.
#
# What is inside (see the app's Environments page for the same table):
#   Python     3.x with pip, poetry, uv, black, mypy, pytest, ruff
#   Node.js    20, 21 and 22 under /opt/node<major> (22 on PATH), with npm,
#              yarn, pnpm, bun, eslint, prettier, chromedriver
#   Ruby       3.1, 3.2, 3.3 with gem, bundler, rbenv (/opt/rbenv)
#   PHP        8.3 with Composer
#   Java       OpenJDK 21 with Maven and Gradle
#   Go         latest stable, module mode (/usr/local/go)
#   Rust       rustc and cargo via rustup (/opt/rustup, /opt/cargo)
#   C/C++      GCC, Clang, cmake, ninja, conan
#   Docker     docker, dockerd, docker compose (the daemon needs privileges
#              this container does not have; the CLI works against a daemon
#              reachable through DOCKER_HOST)
#   Databases  PostgreSQL 16, Redis 7 (start with `sudo service <name> start`)
#   Utilities  git, gh, jq, yq, ripgrep, tmux, vim, nano

FROM ubuntu:24.04

ARG NODE_MAJORS="20 21 22"
ARG DEFAULT_NODE=22
ARG RUBY_MINORS="3.1 3.2 3.3"
ARG DEFAULT_RUBY=3.3

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

# --- apt: shell utilities, C/C++, Python, PHP, Java, PostgreSQL, Redis ---------
# libpq/libssl/libyaml/... are the headers ruby-build and native gems, pip
# packages and conan recipes expect to find.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget gnupg lsb-release \
        git openssh-client tmux ripgrep fd-find jq less nano vim man-db \
        procps psmisc htop tree unzip zip xz-utils bzip2 file rsync sudo tini \
        build-essential gdb clang lld cmake ninja-build pkg-config \
        autoconf automake libtool bison \
        libssl-dev libreadline-dev zlib1g-dev libyaml-dev libffi-dev libgdbm-dev \
        libncurses-dev libsqlite3-dev libgmp-dev libxml2-dev libxslt1-dev libpq-dev \
        libxcb1 libdbus-1-3 \
        python3 python3-pip python3-venv python3-dev pipx \
        php-cli php-mbstring php-xml php-curl php-zip php-intl php-sqlite3 php-pgsql composer \
        default-jdk-headless maven \
        postgresql-16 postgresql-client-16 redis-server redis-tools sqlite3 \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

ENV JAVA_HOME=/usr/lib/jvm/default-java

# --- Docker and the GitHub CLI, from their own apt repositories ----------------
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL --retry 5 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
    && curl -fsSL --retry 5 https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod a+r /etc/apt/keyrings/docker.asc /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && arch="$(dpkg --print-architecture)" \
    && codename="$(. /etc/os-release && echo "$VERSION_CODENAME")" \
    && echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
        > /etc/apt/sources.list.d/docker.list \
    && echo "deb [arch=${arch} signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin gh \
    && rm -rf /var/lib/apt/lists/*

# --- yq -----------------------------------------------------------------------
RUN arch="$(dpkg --print-architecture)" \
    && curl -fsSL --retry 5 "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_${arch}" \
        -o /usr/local/bin/yq \
    && chmod 0755 /usr/local/bin/yq

# --- Node.js 20 / 21 / 22 -----------------------------------------------------
# Each major lives in its own prefix; the default one is put on PATH below. To
# work with another version, prepend its bin directory (e.g. /opt/node20/bin).
#
# Multi-step RUNs below are written as `set -eu; a; b; for ...` rather than an
# `a && b && for ...` chain on purpose: bash suspends errexit inside any
# compound command that is not the last link of a && chain, so a failure
# inside such a loop would go unnoticed and the layer would build half-empty.
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    mkdir -p /tmp/node; \
    for major in $NODE_MAJORS; do \
      dist="https://nodejs.org/dist/latest-v${major}.x"; \
      sums="$(curl -fsSL --retry 5 "${dist}/SHASUMS256.txt")"; \
      entry="$(grep -E " node-v[0-9.]+-linux-${node_arch}[.]tar[.]xz$" <<< "$sums" | head -n 1)"; \
      test -n "$entry"; \
      file="${entry##* }"; \
      curl -fsSL --retry 5 -o "/tmp/node/${file}" "${dist}/${file}"; \
      (cd /tmp/node && sha256sum -c --strict <<< "$entry"); \
      mkdir -p "/opt/node${major}"; \
      tar -xJ -C "/opt/node${major}" --strip-components=1 -f "/tmp/node/${file}"; \
      rm -f "/tmp/node/${file}"; \
      "/opt/node${major}/bin/node" --version; \
    done; \
    rmdir /tmp/node

ENV PATH="/opt/node${DEFAULT_NODE}/bin:${PATH}"
# One global prefix shared by every Node version, so `npm install -g` lands on
# PATH whichever /opt/node<major> is active. Root-owned: use sudo.
ENV NPM_CONFIG_PREFIX=/usr/local
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# --- bun ----------------------------------------------------------------------
RUN curl -fsSL --retry 5 https://bun.sh/install | BUN_INSTALL=/opt/bun bash \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bunx

# --- Go -----------------------------------------------------------------------
RUN set -eu; \
    arch="$(dpkg --print-architecture)"; \
    listing="$(curl -fsSL --retry 5 'https://go.dev/VERSION?m=text')"; \
    version="$(sed -n 1p <<< "$listing")"; \
    test -n "$version"; \
    curl -fsSL --retry 5 "https://go.dev/dl/${version}.linux-${arch}.tar.gz" | tar -xz -C /usr/local; \
    /usr/local/go/bin/go version

ENV PATH="/usr/local/go/bin:${PATH}"

# --- Ruby 3.1 / 3.2 / 3.3 through rbenv ----------------------------------------
# The slowest layer: each Ruby is compiled by ruby-build. It sits before the
# layers that change more often so a rebuild rarely has to redo it. The newest
# patch of every minor is taken from `--list-all`, since `--list` drops a minor
# once it reaches end of life.
ENV RBENV_ROOT=/opt/rbenv
RUN set -eu; \
    git clone --depth 1 https://github.com/rbenv/rbenv.git "$RBENV_ROOT"; \
    git clone --depth 1 https://github.com/rbenv/ruby-build.git "$RBENV_ROOT/plugins/ruby-build"; \
    export PATH="$RBENV_ROOT/bin:$PATH"; \
    available="$(rbenv install --list-all 2>/dev/null)"; \
    for minor in $RUBY_MINORS; do \
      version="$(grep -E "^${minor}[.][0-9]+$" <<< "$available" | tail -n 1)"; \
      test -n "$version"; \
      MAKE_OPTS="-j$(nproc)" RUBY_CONFIGURE_OPTS="--disable-install-doc" rbenv install "$version"; \
    done; \
    installed="$(rbenv versions --bare)"; \
    test "$(wc -l <<< "$installed")" -eq "$(wc -w <<< "$RUBY_MINORS")"; \
    rbenv global "$(grep -E "^${DEFAULT_RUBY}[.]" <<< "$installed" | tail -n 1)"; \
    for version in $installed; do \
      RBENV_VERSION="$version" rbenv exec gem install bundler --no-document; \
    done; \
    rbenv rehash; \
    rm -rf /tmp/ruby-build* "$RBENV_ROOT"/.git "$RBENV_ROOT"/plugins/ruby-build/.git; \
    rbenv versions

ENV PATH="${RBENV_ROOT}/shims:${RBENV_ROOT}/bin:${PATH}"

# --- Rust ---------------------------------------------------------------------
ENV RUSTUP_HOME=/opt/rustup
ENV CARGO_HOME=/opt/cargo
RUN curl -fsSL --retry 5 https://sh.rustup.rs \
        | sh -s -- -y --no-modify-path --profile minimal --component rustfmt --component clippy \
    && /opt/cargo/bin/rustc --version

ENV PATH="/opt/cargo/bin:${PATH}"

# --- Gradle -------------------------------------------------------------------
RUN set -eu; \
    url="$(curl -fsSL --retry 5 https://services.gradle.org/versions/current | jq -r .downloadUrl)"; \
    test -n "$url"; \
    curl -fsSL --retry 5 "$url" -o /tmp/gradle.zip; \
    mkdir -p /opt/gradle; \
    unzip -q /tmp/gradle.zip -d /opt/gradle; \
    rm -f /tmp/gradle.zip; \
    ln -sf /opt/gradle/gradle-*/bin/gradle /usr/local/bin/gradle; \
    gradle --version

# --- Python tooling -----------------------------------------------------------
# uv, black, mypy, pytest and ruff go into the system interpreter so they are
# importable and on PATH; poetry and conan get their own pipx venvs.
RUN pip3 install --no-cache-dir --break-system-packages uv black mypy pytest ruff \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install poetry \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install conan \
    && rm -rf /root/.cache

# --- Global npm tools and Claude Code -----------------------------------------
# CLAUDE_CODE_REFRESH is a cache key only: the app passes a fresh value to
# reinstall Claude Code without rebuilding the layers above.
ARG CLAUDE_CODE_VERSION=latest
ARG CLAUDE_CODE_REFRESH=0
RUN echo "claude-code refresh token: ${CLAUDE_CODE_REFRESH}" \
    && npm install -g yarn pnpm eslint prettier chromedriver "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force \
    && test -x /usr/local/bin/claude \
    && chromedriver --version

# --- The claude user (uid 1000) -----------------------------------------------
# Ubuntu 24.04 ships an `ubuntu` account on uid 1000. Reclaim that uid so files
# written through the Docker API (which the app addresses by numeric uid) land
# with the right owner. Toolchains that install into their own trees at run
# time (gem, cargo, rustup) are handed to the user; the rest stays root-owned
# and reachable through passwordless sudo.
RUN touch /var/mail/ubuntu \
    && (userdel -r ubuntu 2>/dev/null || true) \
    && groupadd -g 1000 claude \
    && useradd -m -u 1000 -g 1000 -s /bin/bash claude \
    && usermod -aG docker claude \
    && printf 'claude ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/claude \
    && chmod 0440 /etc/sudoers.d/claude \
    && chown -R claude:claude "$RBENV_ROOT" "$RUSTUP_HOME" "$CARGO_HOME" \
    && git config --system init.defaultBranch main \
    && git config --system --add safe.directory '*' \
    && printf '%s\n' \
        '' \
        '# --- cc-container-desktop ---' \
        "alias ll='ls -alF'" \
        "alias cc='claude'" \
        '# --- /cc-container-desktop ---' \
        >> /etc/bash.bashrc

# Scratch space for the scripts the app pushes in (launcher, onboarding patch,
# the environment's setup script and its done-marker).
RUN mkdir -p /opt/cc && chmod 0755 /opt/cc

RUN mkdir -p /home/claude/workspace /home/claude/.local/bin /home/claude/go/bin \
    && chown -R 1000:1000 /home/claude

USER claude
WORKDIR /home/claude/workspace

ENV PATH="/home/claude/.local/bin:/home/claude/go/bin:${PATH}"
ENV TERM=xterm-256color
ENV EDITOR=nano
# The app manages updates by rebuilding the image; an in-place auto-update would
# only write into the container's throwaway layer.
ENV DISABLE_AUTOUPDATER=1

# `tini` reaps the processes tmux leaves behind. The container itself just idles;
# the app opens `docker exec` sessions into it.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
