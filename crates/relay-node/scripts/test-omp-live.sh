#!/usr/bin/env bash
# Real Oh My Pi TUI compatibility: an isolated package and conversations, no API credentials.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMP_TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/relay-omp-live.XXXXXX")"
trap 'rm -rf "$OMP_TEST_ROOT"' EXIT

package='@oh-my-pi/pi-coding-agent@18.12.6'
(cd "$OMP_TEST_ROOT" && bun init -y >/dev/null && bun add --exact "$package")
RELAY_OMP_CLI="$OMP_TEST_ROOT/node_modules/.bin/omp" \
  cargo test --manifest-path "$REPO_ROOT/Cargo.toml" --locked \
    --test omp_live_session -- --ignored --nocapture
