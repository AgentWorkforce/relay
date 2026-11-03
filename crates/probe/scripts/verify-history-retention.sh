#!/usr/bin/env bash
# W1-V: synthetic policy -> durable receiver -> retention -> restart checks.
set -euo pipefail

verification_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
verification_case='retention::verification::scenarios::'
verification_flags=(--nocapture)
verify_exact=false

case "${1:-}" in
  '') ;;
  --reproduce-680)
    verification_case='retention::tests::interrupted_consumer_rotation_must_not_reuse_a_higher_acknowledgement'
    verification_flags+=(--exact)
    verify_exact=true
    ;;
  *)
    echo 'Usage: scripts/verify-history-retention.sh [--reproduce-680]' >&2
    exit 2
    ;;
esac

if [[ "$verify_exact" == true ]]; then
  env -u CODEX_HOME cargo test --manifest-path "$verification_root/Cargo.toml" \
    --locked --no-default-features --lib "$verification_case" -- --list --exact |
    grep -Fqx "$verification_case: test"
fi

# This filter invokes only synthetic tests. Each child also requires a
# test-owned marker under the temporary directory. No app, provider sync,
# login credentials, HTTP transport or live history database is involved.
env -u CODEX_HOME cargo test --manifest-path "$verification_root/Cargo.toml" \
  --locked --no-default-features --lib "$verification_case" -- "${verification_flags[@]}"
