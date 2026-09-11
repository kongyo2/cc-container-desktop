#!/usr/bin/env bash
# Runtime contract v1. The same script is run by CI against every published
# image and by the app (as the claude user, from stdin) before an image is
# registered. It prints one line per check ("ok <name>" or "fail <name>: why")
# and a final "RESULT <passed> <failed>" line; exit code 0 means all passed.
#
# Expected values arrive as environment variables:
#   CC_EXPECT_VARIANT, CC_EXPECT_RELEASE, CC_EXPECT_CONTRACT (default 1)
set -uo pipefail

passed=0
failed=0

ok() { passed=$((passed + 1)); printf 'ok %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'fail %s: %s\n' "$1" "$2"; }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then ok "$name"; else fail "$name" "expected '${expected}', got '${actual}'"; fi
}

check_cmd() {
  local name="$1"
  shift
  if command -v "$1" >/dev/null 2>&1; then ok "$name"; else fail "$name" "$1 is not on PATH"; fi
}

expect_contract="${CC_EXPECT_CONTRACT:-1}"

check_eq user.uid 1000 "$(id -u)"
check_eq user.gid 1000 "$(id -g)"
check_eq user.name claude "$(id -un)"
check_eq home.path /home/claude "${HOME:-}"

if [ -d /home/claude/workspace ] && touch /home/claude/workspace/.cc-verify 2>/dev/null; then
  rm -f /home/claude/workspace/.cc-verify
  ok home.workspace-writable
else
  fail home.workspace-writable "/home/claude/workspace is missing or not writable by claude"
fi

if touch /home/claude/.cc-verify 2>/dev/null; then
  rm -f /home/claude/.cc-verify
  ok home.writable
else
  fail home.writable "/home/claude is not writable by claude"
fi

for tool in bash tmux timeout stat tar git ssh curl jq rg sudo ps pkill; do
  check_cmd "tool.${tool}" "$tool"
done

if node_version="$(node --version 2>/dev/null)"; then ok "node.version ${node_version}"; else fail node.version "node --version failed"; fi
if npm_version="$(npm --version 2>/dev/null)"; then ok "npm.version ${npm_version}"; else fail npm.version "npm --version failed"; fi

node_path="$(command -v node 2>/dev/null || true)"
case "$node_path" in
  /home/*|'') fail node.outside-home "node resolves to '${node_path}'" ;;
  *) ok node.outside-home ;;
esac

claude_path="$(command -v claude 2>/dev/null || true)"
case "$claude_path" in
  /home/*|'') fail claude.outside-home "claude resolves to '${claude_path}'" ;;
  *) ok claude.outside-home ;;
esac

if claude_version="$(timeout 30 claude --version 2>/dev/null | head -n 1)"; then
  ok "claude.version ${claude_version}"
else
  fail claude.version "claude --version did not succeed within 30s"
fi

login_probe="$(bash -lc 'command -v node && command -v npm && command -v claude' 2>/dev/null | wc -l)"
check_eq login-shell.tools 3 "$login_probe"

login_lang="$(bash -lc 'printf %s "${LANG:-}"' 2>/dev/null)"
case "$login_lang" in
  *UTF-8*|*utf8*|*UTF8*) ok "locale.utf8 ${login_lang}" ;;
  *) fail locale.utf8 "LANG is '${login_lang}'" ;;
esac

if tmux -V >/dev/null 2>&1; then
  ok tmux.runs
else
  fail tmux.runs "tmux -V failed"
fi

if sudo -n true 2>/dev/null; then ok sudo.passwordless; else fail sudo.passwordless "sudo -n true failed"; fi

if [ -d /opt/cc ]; then ok opt-cc.exists; else fail opt-cc.exists "/opt/cc is missing"; fi

if [ -r /opt/cc/image-info.json ]; then
  ok image-info.readable
  info_variant="$(jq -er '.variant' /opt/cc/image-info.json 2>/dev/null || true)"
  info_release="$(jq -er '.release' /opt/cc/image-info.json 2>/dev/null || true)"
  info_contract="$(jq -er '.runtimeContract' /opt/cc/image-info.json 2>/dev/null || true)"
  info_project="$(jq -er '.project' /opt/cc/image-info.json 2>/dev/null || true)"
  check_eq image-info.project cc-container-desktop "$info_project"
  check_eq image-info.contract "$expect_contract" "$info_contract"
  if [ -n "${CC_EXPECT_VARIANT:-}" ]; then check_eq image-info.variant "$CC_EXPECT_VARIANT" "$info_variant"; fi
  if [ -n "${CC_EXPECT_RELEASE:-}" ]; then check_eq image-info.release "$CC_EXPECT_RELEASE" "$info_release"; fi
else
  fail image-info.readable "/opt/cc/image-info.json is missing"
fi

check_eq autoupdater.disabled 1 "${DISABLE_AUTOUPDATER:-}"

printf 'RESULT %s %s\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
