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
    --locked --no-default-features --features history --lib "$verification_case" -- --list --exact |
    grep -Fx "$verification_case: test" >/dev/null
fi

# A filter that matches nothing must fail, not pass with zero tests.
listed="$(env -u CODEX_HOME cargo test --manifest-path "$verification_root/Cargo.toml" \
  --locked --no-default-features --features history --lib "$verification_case" -- --list)"
if ! grep -q ': test$' <<<"$listed"; then
  echo "No test matches $verification_case." >&2
  exit 1
fi

# Retention is part of session history, so the history feature is on; the
# production binaries stay off. This filter invokes only synthetic tests. Each child also requires a
# test-owned marker under the temporary directory. No app, provider sync,
# login credentials, HTTP transport or live history database is involved.
env -u CODEX_HOME cargo test --manifest-path "$verification_root/Cargo.toml" \
  --locked --no-default-features --features history --lib "$verification_case" -- "${verification_flags[@]}"
