# syntax=docker/dockerfile:1
#
# CC Workbench images. One shared foundation (core), eight final targets.
# Build with docker buildx bake (see docker-bake.hcl); every version comes from
# image-versions.lock.json and every download is checksum-verified.

ARG UBUNTU_REF=docker.io/library/ubuntu@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254

FROM ${UBUNTU_REF} AS core
ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV LC_ALL=C.UTF-8
# Each stage copies only the scripts it runs, so editing one variant's
# installer never invalidates the (slow) shared foundation in the build cache.
COPY --chmod=0755 scripts/lib.sh scripts/install-base.sh /opt/cc-build/scripts/
COPY image-versions.lock.json /opt/cc-build/image-versions.lock.json
# The optional secret "build-ca-bundle" (a PEM bundle) is only for builds behind a
# TLS-inspecting proxy; the publish workflow never provides it.
RUN --mount=type=secret,id=build-ca-bundle,required=false /opt/cc-build/scripts/install-base.sh
ENV PATH="/home/claude/.local/bin:/usr/local/bin:/opt/node/bin:${PATH}"
ENV NPM_CONFIG_PREFIX=/usr/local
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV TERM=xterm-256color
ENV EDITOR=nano
ENV DISABLE_AUTOUPDATER=1

# ---------------------------------------------------------------- base
FROM core AS base
ARG TARGETARCH
ARG IMAGE_RELEASE=0.0.0-dev
ARG SOURCE_REVISION=unknown
ARG BUILT_AT=1970-01-01T00:00:00Z
COPY --chmod=0755 scripts/finalize.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/finalize.sh base
LABEL org.opencontainers.image.title="CC Workbench (base)" \
      org.opencontainers.image.description="Claude Code runtime for CC Container Desktop: shell, git, Node.js and Claude Code" \
      org.opencontainers.image.source="https://github.com/kongyo2/cc-container-desktop" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_RELEASE}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.licenses="MIT" \
      com.cc-container-desktop.project="cc-workbench" \
      com.cc-container-desktop.image.variant="base" \
      com.cc-container-desktop.image.release="${IMAGE_RELEASE}" \
      com.cc-container-desktop.image.runtime-contract="1"
USER claude
WORKDIR /home/claude/workspace
CMD ["sleep", "infinity"]

# ---------------------------------------------------------------- web
FROM core AS web-tools
ARG TARGETARCH
COPY --chmod=0755 scripts/install-web.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-web.sh

FROM web-tools AS web
ARG TARGETARCH
ARG IMAGE_RELEASE=0.0.0-dev
ARG SOURCE_REVISION=unknown
ARG BUILT_AT=1970-01-01T00:00:00Z
COPY --chmod=0755 scripts/finalize.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/finalize.sh web
LABEL org.opencontainers.image.title="CC Workbench (web)" \
      org.opencontainers.image.description="Claude Code runtime for CC Container Desktop: JavaScript / TypeScript tooling" \
      org.opencontainers.image.source="https://github.com/kongyo2/cc-container-desktop" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_RELEASE}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.licenses="MIT" \
      com.cc-container-desktop.project="cc-workbench" \
      com.cc-container-desktop.image.variant="web" \
      com.cc-container-desktop.image.release="${IMAGE_RELEASE}" \
      com.cc-container-desktop.image.runtime-contract="1"
USER claude
WORKDIR /home/claude/workspace
CMD ["sleep", "infinity"]

# ---------------------------------------------------------------- python
FROM core AS python
ARG TARGETARCH
ARG IMAGE_RELEASE=0.0.0-dev
ARG SOURCE_REVISION=unknown
ARG BUILT_AT=1970-01-01T00:00:00Z
COPY --chmod=0755 scripts/install-python.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-python.sh
COPY --chmod=0755 scripts/finalize.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/finalize.sh python
LABEL org.opencontainers.image.title="CC Workbench (python)" \
      org.opencontainers.image.description="Claude Code runtime for CC Container Desktop: Python 3 development tooling" \
      org.opencontainers.image.source="https://github.com/kongyo2/cc-container-desktop" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_RELEASE}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.licenses="MIT" \
      com.cc-container-desktop.project="cc-workbench" \
      com.cc-container-desktop.image.variant="python" \
      com.cc-container-desktop.image.release="${IMAGE_RELEASE}" \
      com.cc-container-desktop.image.runtime-contract="1"
USER claude
WORKDIR /home/claude/workspace
CMD ["sleep", "infinity"]

# ---------------------------------------------------------------- go
FROM core AS go
ARG TARGETARCH
ARG IMAGE_RELEASE=0.0.0-dev
ARG SOURCE_REVISION=unknown
ARG BUILT_AT=1970-01-01T00:00:00Z
COPY --chmod=0755 scripts/install-go.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-go.sh
COPY --chmod=0755 scripts/finalize.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/finalize.sh go
ENV GOPATH=/home/claude/go
ENV PATH="${PATH}:/usr/local/go/bin:/home/claude/go/bin"
LABEL org.opencontainers.image.title="CC Workbench (go)" \
      org.opencontainers.image.description="Claude Code runtime for CC Container Desktop: Go toolchain" \
      org.opencontainers.image.source="https://github.com/kongyo2/cc-container-desktop" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_RELEASE}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.licenses="MIT" \
      com.cc-container-desktop.project="cc-workbench" \
      com.cc-container-desktop.image.variant="go" \
      com.cc-container-desktop.image.release="${IMAGE_RELEASE}" \
      com.cc-container-desktop.image.runtime-contract="1"
USER claude
WORKDIR /home/claude/workspace
CMD ["sleep", "infinity"]

# ---------------------------------------------------------------- rust
FROM core AS rust
ARG TARGETARCH
ARG IMAGE_RELEASE=0.0.0-dev
ARG SOURCE_REVISION=unknown
ARG BUILT_AT=1970-01-01T00:00:00Z
COPY --chmod=0755 scripts/install-rust.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-rust.sh
COPY --chmod=0755 scripts/finalize.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/finalize.sh rust
ENV RUSTUP_HOME=/opt/rustup
ENV PATH="${PATH}:/home/claude/.cargo/bin"
LABEL org.opencontainers.image.title="CC Workbench (rust)" \
      org.opencontainers.image.description="Claude Code runtime for CC Container Desktop: Rust toolchain" \
      org.opencontainers.image.source="https://github.com/kongyo2/cc-container-desktop" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_RELEASE}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.licenses="MIT" \
      com.cc-container-desktop.project="cc-workbench" \
      com.cc-container-desktop.image.variant="rust" \
      com.cc-container-desktop.image.release="${IMAGE_RELEASE}" \
      com.cc-container-desktop.image.runtime-contract="1"
USER claude
WORKDIR /home/claude/workspace
CMD ["sleep", "infinity"]

# ---------------------------------------------------------------- jvm
FROM core AS jvm
ARG TARGETARCH
ARG IMAGE_RELEASE=0.0.0-dev
ARG SOURCE_REVISION=unknown
ARG BUILT_AT=1970-01-01T00:00:00Z
COPY --chmod=0755 scripts/install-jvm.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-jvm.sh
COPY --chmod=0755 scripts/finalize.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/finalize.sh jvm
ENV JAVA_HOME=/opt/java
LABEL org.opencontainers.image.title="CC Workbench (jvm)" \
      org.opencontainers.image.description="Claude Code runtime for CC Container Desktop: OpenJDK 21, Maven and Gradle" \
      org.opencontainers.image.source="https://github.com/kongyo2/cc-container-desktop" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_RELEASE}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.licenses="MIT" \
      com.cc-container-desktop.project="cc-workbench" \
      com.cc-container-desktop.image.variant="jvm" \
      com.cc-container-desktop.image.release="${IMAGE_RELEASE}" \
      com.cc-container-desktop.image.runtime-contract="1"
USER claude
WORKDIR /home/claude/workspace
CMD ["sleep", "infinity"]

# ---------------------------------------------------------------- ruby
FROM core AS ruby
ARG TARGETARCH
ARG IMAGE_RELEASE=0.0.0-dev
ARG SOURCE_REVISION=unknown
ARG BUILT_AT=1970-01-01T00:00:00Z
COPY --chmod=0755 scripts/install-ruby.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-ruby.sh
COPY --chmod=0755 scripts/finalize.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/finalize.sh ruby
ENV PATH="${PATH}:/opt/ruby/bin:/home/claude/.local/share/gem/bin"
LABEL org.opencontainers.image.title="CC Workbench (ruby)" \
      org.opencontainers.image.description="Claude Code runtime for CC Container Desktop: Ruby and Bundler" \
      org.opencontainers.image.source="https://github.com/kongyo2/cc-container-desktop" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_RELEASE}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.licenses="MIT" \
      com.cc-container-desktop.project="cc-workbench" \
      com.cc-container-desktop.image.variant="ruby" \
      com.cc-container-desktop.image.release="${IMAGE_RELEASE}" \
      com.cc-container-desktop.image.runtime-contract="1"
USER claude
WORKDIR /home/claude/workspace
CMD ["sleep", "infinity"]

# ---------------------------------------------------------------- full
FROM web-tools AS full
ARG TARGETARCH
ARG IMAGE_RELEASE=0.0.0-dev
ARG SOURCE_REVISION=unknown
ARG BUILT_AT=1970-01-01T00:00:00Z
COPY --chmod=0755 scripts/install-python.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-python.sh
COPY --chmod=0755 scripts/install-go.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-go.sh
COPY --chmod=0755 scripts/install-rust.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-rust.sh
COPY --chmod=0755 scripts/install-jvm.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-jvm.sh
COPY --chmod=0755 scripts/install-ruby.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-ruby.sh
COPY --chmod=0755 scripts/install-full.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/install-full.sh
COPY --chmod=0755 scripts/finalize.sh /opt/cc-build/scripts/
RUN /opt/cc-build/scripts/finalize.sh full
ENV GOPATH=/home/claude/go
ENV RUSTUP_HOME=/opt/rustup
ENV JAVA_HOME=/opt/java
ENV PATH="${PATH}:/usr/local/go/bin:/home/claude/go/bin:/home/claude/.cargo/bin:/opt/ruby/bin:/home/claude/.local/share/gem/bin"
LABEL org.opencontainers.image.title="CC Workbench (full)" \
      org.opencontainers.image.description="Claude Code runtime for CC Container Desktop: every toolchain" \
      org.opencontainers.image.source="https://github.com/kongyo2/cc-container-desktop" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      org.opencontainers.image.version="${IMAGE_RELEASE}" \
      org.opencontainers.image.created="${BUILT_AT}" \
      org.opencontainers.image.licenses="MIT" \
      com.cc-container-desktop.project="cc-workbench" \
      com.cc-container-desktop.image.variant="full" \
      com.cc-container-desktop.image.release="${IMAGE_RELEASE}" \
      com.cc-container-desktop.image.runtime-contract="1"
USER claude
WORKDIR /home/claude/workspace
CMD ["sleep", "infinity"]
