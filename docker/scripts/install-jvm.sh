#!/usr/bin/env bash
# JVM variant: OpenJDK 21 and Maven from apt, Gradle pinned by checksum.
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

cc_apt_install openjdk-21-jdk-headless maven

java_home="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
test -x "${java_home}/bin/java"

gradle_url="$(cc_lock '.gradle.url')"
gradle_sha="$(cc_lock '.gradle.sha256')"
gradle_version="$(cc_lock '.gradle.version')"
cc_fetch_verified "$gradle_url" "$gradle_sha" /tmp/gradle.zip
mkdir -p /opt/gradle
unzip -q /tmp/gradle.zip -d /opt/gradle
rm -f /tmp/gradle.zip
ln -sfn "/opt/gradle/gradle-${gradle_version}/bin/gradle" /usr/local/bin/gradle
test -x "/opt/gradle/gradle-${gradle_version}/bin/gradle"

# /opt/java is a stable, architecture-independent JAVA_HOME the Dockerfile's
# ENV can point at; login shells get the same value from profile.d.
ln -sfn "$java_home" /opt/java
cc_profile_append cc-jvm.sh \
  '# cc-container-desktop: jvm toolchain' \
  'export JAVA_HOME=/opt/java'

java -version 2>&1 | head -n 1
mvn --version | head -n 1
JAVA_HOME=/opt/java gradle --version --quiet | head -n 3

rm -rf /root/.cache /root/.gradle /root/.m2 /tmp/*
