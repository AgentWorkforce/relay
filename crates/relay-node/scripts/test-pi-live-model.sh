#!/usr/bin/env bash
# Opt-in paid OpenAI test: isolated real Pi sessions with read/bash/write tools.
set -euo pipefail
if [[ -z "${OPENAI_API_KEY:-}" && -z "${RELAY_PI_AUTH_FILE:-}" ]]; then
  echo 'Set OPENAI_API_KEY or RELAY_PI_AUTH_FILE to run the live-model test.' >&2
  exit 1
fi
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/relay-pi-model.XXXXXX")"
trap 'rm -rf "$PI_TEST_ROOT"' EXIT

for package in '@mariozechner/pi-coding-agent@0.68.0' '@earendil-works/pi-coding-agent@1.3.0'; do
  # Its own prefix per version, and no install scripts: the paid key is in
  # this environment, and only the top-level Pi versions are pinned.
  prefix="$(mktemp -d "$PI_TEST_ROOT/install.XXXXXX")"
  npm install --prefix "$prefix" --no-audit --no-fund --ignore-scripts "$package"
  module="${package%@*}"
  version="${package##*@}"
  if [[ -n "${RELAY_PI_EVIDENCE_ROOT:-}" ]]; then
    export RELAY_PI_EVIDENCE_DIR="$RELAY_PI_EVIDENCE_ROOT/$version"
  fi
  RELAY_PI_CLI="$prefix/node_modules/$module/dist/cli.js" \
    cargo test --manifest-path "$REPO_ROOT/Cargo.toml" --locked \
      --test pi_live_model -- --ignored --nocapture
done
