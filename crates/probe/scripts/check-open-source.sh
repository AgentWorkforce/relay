#!/usr/bin/env bash
# Fails when the tracked relay core (crates/probe) would leak something into
# the public source: a key-shaped credential that is not an obvious fixture,
# an embedded PostHog project key, a developer's home path, a link into a
# private AgentWorkforce repository, or a missing Apache-2.0 license. It prints
# file names and line numbers only, never the matching text, so a hit cannot
# itself leak a value.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CRATE_DIR"
REPO_ROOT="$(git rev-parse --show-toplevel)"
SELF="scripts/check-open-source.sh"
status=0

fail() {
  echo "::error::$1" >&2
  status=1
}

hits() { # MESSAGE PATTERN
  local message="$1" pattern="$2" found
  found="$(git grep -n -I -E "$pattern" -- . ":!$SELF" | cut -d: -f1,2 || true)"
  if [ -n "$found" ]; then
    fail "$message"
    printf '  crates/probe/%s\n' $found >&2
  fi
}

grep -qs "Apache License" "$REPO_ROOT/LICENSE" || fail "The repository LICENSE must hold the Apache License 2.0."
grep -qs "Apache License" LICENSE || fail "crates/probe/LICENSE must hold the Apache License 2.0."
grep -q '^license = "Apache-2.0"' Cargo.toml || fail 'crates/probe/Cargo.toml must declare license = "Apache-2.0".'

hits "Embedded PostHog project key; supply it at build time (AGENT_RELAY_POSTHOG_API_KEY)." \
  'phc_[A-Za-z0-9]{20,}'
hits "Link into a private AgentWorkforce repository." \
  'github\.com[/:]AgentWorkforce/(cloud|relaycast-cloud|relayhistory-cloud|relay-desktop)([/.#"'"'"' ]|$)'
hits "Developer home path; use a neutral fixture such as /Users/me." \
  '/(Users|home)/(will|khaliq|khaliqgant|miya|barry)/'
hits "GitHub, Anthropic, OpenAI, Slack, AWS or Stripe credential." \
  'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk_live_[A-Za-z0-9]{16,}|BEGIN [A-Z ]*PRIVATE KEY'

# Relaycast (rk_/at_/nt_/ar_) keys: fixtures are short, repeated or sequential
# (rk_live_aaaa…, rk_live_abcdefgh…). A long value with no such pattern
# looks like a real key.
key_hits="$(git grep -n -I -o -E '((rk|at|nt)_(live|test)|ar_(ws|ag))_[A-Za-z0-9_-]{20,}' -- . ":!$SELF" \
  | python3 -c '
import sys
def patterned(value):
    if len(set(value)) <= 4:
        return True
    steps = sum(1 for a, b in zip(value, value[1:]) if ord(b) - ord(a) in (0, 1))
    return steps >= 0.8 * (len(value) - 1)
for line in sys.stdin:
    path, number, match = line.rstrip("\n").split(":", 2)
    value = match.split("_", 2)[2]
    if not patterned(value):
        print(f"{path}:{number}")
' || true)"
if [ -n "$key_hits" ]; then
  fail "Relaycast key-shaped value that is not an obvious fixture."
  printf '  crates/probe/%s\n' $key_hits >&2
fi

exit "$status"
