#!/usr/bin/env bash
# Fails when the tracked tree would leak something into the public source:
# an embedded PostHog project key, a developer's home path, a link into a
# private AgentWorkforce repository, a missing project license, or a file
# that was removed for being internal. It prints file names and line numbers
# only, never the matching text, so a hit cannot itself leak a value.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
status=0

fail() {
  echo "::error::$1" >&2
  status=1
}

hits() { # MESSAGE PATTERN [PATHSPEC...]
  local message="$1" pattern="$2"
  shift 2
  local found
  found="$(git grep -n -I -E "$pattern" -- "$@" | cut -d: -f1,2 || true)"
  if [ -n "$found" ]; then
    fail "$message"
    printf '  %s\n' "$found" >&2
  fi
}

if ! grep -qs "Apache License" LICENSE; then
  fail "LICENSE must hold the Apache License 2.0."
fi
grep -q 'license = "Apache-2.0"' probe/Cargo.toml || fail "probe/Cargo.toml must declare license = \"Apache-2.0\"."
if grep -q "All rights reserved" macos/Info.plist.template; then
  fail "macos/Info.plist.template must not claim all rights reserved."
fi

hits "Embedded PostHog project key; supply it from the release secrets." \
  'phc_[A-Za-z0-9]{20,}' . ':!scripts/check-open-source.sh'
hits "Link into a private AgentWorkforce repository." \
  'github\.com[/:]AgentWorkforce/(cloud|relaycast-cloud|relayhistory-cloud)([/.#]|$)' . ':!scripts/check-open-source.sh'
hits "Developer home path; use a neutral fixture such as /Users/me." \
  '/Users/(will|khaliq|khaliqgant|miya|barry)/' . ':!scripts/check-open-source.sh'

for removed in .claude/launch.json config/posthog.json docs/contractor-access.md \
  docs/macos-core-startup-incident.md docs/spawn-restart-dogfood.md docs/quota.md \
  docs/cloud-receiver.md docs/spawn-validation.md docs/machine-address-verification.md \
  docs/hosted-mcp-desktop-identity-live-check.md; do
  if git ls-files --error-unmatch "$removed" > /dev/null 2>&1; then
    fail "$removed was removed as internal and must not be tracked again."
  fi
done

exit "$status"
