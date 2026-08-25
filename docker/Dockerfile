# syntax=docker/dockerfile:1
#
# Claude Code workbench image.
#
# Two deliberate choices:
#   * GitHub CLI is NOT installed. Getting work out of the container is a manual
#     step (the app's "Export workspace" button, or the Files tab).
#   * Claude Code is installed into /usr/local, never into /home/claude. The home
#     directory is a named Docker volume; anything installed there at build time
#     would be frozen at whatever the volume was first populated with, and a
#     rebuild would never reach it.
#
# Everything below is editable from the app's Image tab.

FROM ubuntu:24.04

ARG NODE_MAJOR=24
ARG CLAUDE_CODE_VERSION=latest

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        wget \
        gnupg \
        git \
        openssh-client \
        tmux \
        ripgrep \
        fd-find \
        jq \
        less \
        nano \
        vim-tiny \
        man-db \
        procps \
        psmisc \
        htop \
        tree \
        unzip \
        zip \
        xz-utils \
        build-essential \
        python3 \
        python3-pip \
        python3-venv \
        pipx \
        sudo \
        tini \
    && ln -sf /usr/bin/fdfind /usr/local/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# Node.js from NodeSource.
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Ubuntu 24.04 ships an `ubuntu` account on uid 1000. Reclaim that uid for
# `claude` so files written through the Docker API (which the app addresses by
# numeric uid) land with the right owner.
RUN touch /var/mail/ubuntu \
    && (userdel -r ubuntu 2>/dev/null || true) \
    && groupadd -g 1000 claude \
    && useradd -m -u 1000 -g 1000 -s /bin/bash claude \
    && printf 'claude ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/claude \
    && chmod 0440 /etc/sudoers.d/claude

# Claude Code, global and root-owned so the home volume never shadows it.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && npm cache clean --force

# Scratch space for scripts the app pushes in at container start.
RUN mkdir -p /opt/cc && chmod 0755 /opt/cc

RUN mkdir -p /home/claude/workspace && chown -R 1000:1000 /home/claude

USER claude
WORKDIR /home/claude/workspace

ENV TERM=xterm-256color
ENV EDITOR=nano
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
# The app manages updates by rebuilding the image; an in-place auto-update would
# only write into the container's throwaway layer.
ENV DISABLE_AUTOUPDATER=1

# `tini` reaps the processes tmux leaves behind. The container itself just idles;
# the app opens `docker exec` sessions into it.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
