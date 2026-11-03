#!/usr/bin/env bash
# Real Pi TUI compatibility: isolated packages and conversations, no API credentials.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/relay-pi-live.XXXXXX")"
trap 'rm -rf "$PI_TEST_ROOT"' EXIT

node --test "$REPO_ROOT/src/relay/pi/extension.test.mjs"
for package in '@mariozechner/pi-coding-agent@0.68.0' '@earendil-works/pi-coding-agent@1.3.0'; do
  # Each version in its own prefix, so neither reuses the other's tree.
  prefix="$(mktemp -d "$PI_TEST_ROOT/install.XXXXXX")"
  npm install --prefix "$prefix" --no-audit --no-fund "$package"
  module="${package%@*}"
  RELAY_PI_CLI="$prefix/node_modules/$module/dist/cli.js" \
    cargo test --manifest-path "$REPO_ROOT/Cargo.toml" --locked \
      --test pi_live_session -- --ignored --nocapture
done
