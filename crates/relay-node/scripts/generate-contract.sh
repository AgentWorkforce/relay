#!/usr/bin/env bash
#
# generate-contract.sh -- regenerate the Swift bridge contract types from the
# Rust registry (crates/relay-node/src/relay/contract) into the checked-in
#
#   crates/relay-node/contract/CoreContract.swift
#
# CI (.github/workflows/relay-node-ci.yml) runs this and fails when
# `git diff --exit-code` shows the checked-in file differs from what the
# registry generates. The desktop apps consume that file; relay-desktop can
# also write its macOS copy directly:
#
#   cargo run --locked --manifest-path crates/relay-node/Cargo.toml \
#     --bin relay-contract-codegen -- --app-root /path/to/relay-desktop
#
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cargo run --quiet --locked \
  --manifest-path "$CRATE_DIR/Cargo.toml" \
  --bin relay-contract-codegen -- "$@"
