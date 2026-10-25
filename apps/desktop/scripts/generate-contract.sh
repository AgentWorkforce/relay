#!/usr/bin/env bash
#
# generate-contract.sh -- regenerate the Swift bridge contract types from the
# Rust registry (probe/src/relay/contract):
#
#   macos/Sources/RelayDesktopCore/CoreContract.swift
#
# CI runs this and fails when `git diff --exit-code` shows the checked-in
# file differs from what the registry generates.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cargo run --quiet --locked \
  --manifest-path "$REPO_ROOT/probe/Cargo.toml" \
  --bin relay-contract-codegen -- "$REPO_ROOT"
