#!/usr/bin/env bash
#
# Test suite for git-credential-relay fallback chain
# Run with: bash deploy/workspace/git-credential-relay.test.sh
#

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CREDENTIAL_HELPER="$SCRIPT_DIR/git-credential-relay"

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Test helper functions
pass() {
  echo -e "${GREEN}✓${NC} $1"
  TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
  echo -e "${RED}✗${NC} $1"
  echo "  Expected: $2"
  echo "  Got: $3"
  TESTS_FAILED=$((TESTS_FAILED + 1))
}

# Create temp directory for test fixtures
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

# ============================================================
# TEST 1: GH_TOKEN env var takes priority
# ============================================================
test_gh_token_env() {
  local output
  output=$(echo -e "protocol=https\nhost=github.com\n" | \
    GH_TOKEN=ghp_env_token \
    WORKSPACE_ID="" \
    CLOUD_API_URL="" \
    WORKSPACE_TOKEN="" \
    "$CREDENTIAL_HELPER" get 2>/dev/null)

  if echo "$output" | grep -q "password=ghp_env_token"; then
    pass "GH_TOKEN env var is used"
  else
    fail "GH_TOKEN env var" "password=ghp_env_token" "$output"
  fi
}

# ============================================================
# TEST 2: GITHUB_TOKEN env var works when GH_TOKEN not set
# ============================================================
test_github_token_env() {
  local output
  output=$(echo -e "protocol=https\nhost=github.com\n" | \
    GH_TOKEN="" \
    GITHUB_TOKEN=ghp_github_token \
    WORKSPACE_ID="" \
    CLOUD_API_URL="" \
    WORKSPACE_TOKEN="" \
    "$CREDENTIAL_HELPER" get 2>/dev/null)

  if echo "$output" | grep -q "password=ghp_github_token"; then
    pass "GITHUB_TOKEN env var is used when GH_TOKEN not set"
  else
    fail "GITHUB_TOKEN env var" "password=ghp_github_token" "$output"
  fi
}

# ============================================================
# TEST 3: hosts.yml file is parsed correctly
# ============================================================
test_hosts_yml() {
  # Create mock hosts.yml
  mkdir -p "$TEST_DIR/gh"
  cat > "$TEST_DIR/gh/hosts.yml" << 'EOF'
github.com:
    user: testuser
    oauth_token: gho_hostsfile_token
    git_protocol: https
EOF

  local output
  output=$(echo -e "protocol=https\nhost=github.com\n" | \
    GH_TOKEN="" \
    GITHUB_TOKEN="" \
    XDG_CONFIG_HOME="$TEST_DIR" \
    WORKSPACE_ID="" \
    CLOUD_API_URL="" \
    WORKSPACE_TOKEN="" \
    "$CREDENTIAL_HELPER" get 2>/dev/null)

  if echo "$output" | grep -q "password=gho_hostsfile_token"; then
    pass "hosts.yml file is parsed and token extracted"
  else
    fail "hosts.yml parsing" "password=gho_hostsfile_token" "$output"
  fi
}

# ============================================================
# TEST 4: hosts.yml with 'token' field (alternative format)
# ============================================================
test_hosts_yml_token_field() {
  # Create mock hosts.yml with 'token' instead of 'oauth_token'
  # Note: XDG_CONFIG_HOME should point to parent of gh/ directory
  mkdir -p "$TEST_DIR/config2/gh"
  cat > "$TEST_DIR/config2/gh/hosts.yml" << 'EOF'
github.com:
    user: anotheruser
    token: gho_token_field
    git_protocol: https
EOF

  local output
  output=$(echo -e "protocol=https\nhost=github.com\n" | \
    GH_TOKEN="" \
    GITHUB_TOKEN="" \
    XDG_CONFIG_HOME="$TEST_DIR/config2" \
    WORKSPACE_ID="" \
    CLOUD_API_URL="" \
    WORKSPACE_TOKEN="" \
    "$CREDENTIAL_HELPER" get 2>/dev/null)

  if echo "$output" | grep -q "password=gho_token_field"; then
    pass "hosts.yml with 'token' field works"
  else
    fail "hosts.yml token field" "password=gho_token_field" "$output"
  fi
}

# ============================================================
# TEST 5: Non-github.com hosts are ignored
# ============================================================
test_non_github_host() {
  local output
  local exit_code=0
  output=$(echo -e "protocol=https\nhost=gitlab.com\n" | \
    GH_TOKEN="should_not_be_used" \
    "$CREDENTIAL_HELPER" get 2>/dev/null) || exit_code=$?

  # Should exit 0 but produce no credentials
  if [[ $exit_code -eq 0 ]] && [[ -z "$output" || ! "$output" =~ "password=" ]]; then
    pass "Non-github.com hosts are ignored"
  else
    fail "Non-github.com handling" "empty output" "$output (exit: $exit_code)"
  fi
}

# ============================================================
# TEST 6: Clear error message when no credentials found
# ============================================================
test_error_message() {
  local output
  local exit_code=0
  output=$(echo -e "protocol=https\nhost=github.com\n" | \
    GH_TOKEN="" \
    GITHUB_TOKEN="" \
    XDG_CONFIG_HOME="/nonexistent" \
    HOME="/nonexistent" \
    WORKSPACE_ID="" \
    CLOUD_API_URL="" \
    WORKSPACE_TOKEN="" \
    "$CREDENTIAL_HELPER" get 2>&1) || exit_code=$?

  if [[ $exit_code -ne 0 ]] && echo "$output" | grep -q "Fallback chain tried"; then
    pass "Clear error message shows fallback chain"
  else
    fail "Error message" "Contains 'Fallback chain tried'" "$output"
  fi
}

# ============================================================
# TEST 7: GH_TOKEN takes priority over hosts.yml
# ============================================================
test_env_priority_over_file() {
  # Create mock hosts.yml
  mkdir -p "$TEST_DIR/gh3"
  cat > "$TEST_DIR/gh3/hosts.yml" << 'EOF'
github.com:
    oauth_token: gho_should_not_use_this
EOF

  local output
  output=$(echo -e "protocol=https\nhost=github.com\n" | \
    GH_TOKEN=ghp_env_wins \
    GITHUB_TOKEN="" \
    XDG_CONFIG_HOME="$TEST_DIR/gh3" \
    WORKSPACE_ID="" \
    CLOUD_API_URL="" \
    WORKSPACE_TOKEN="" \
    "$CREDENTIAL_HELPER" get 2>/dev/null)

  if echo "$output" | grep -q "password=ghp_env_wins"; then
    pass "GH_TOKEN env takes priority over hosts.yml"
  else
    fail "Priority: env > file" "password=ghp_env_wins" "$output"
  fi
}

# ============================================================
# Run all tests
# ============================================================
echo "=========================================="
echo "git-credential-relay Fallback Chain Tests"
echo "=========================================="
echo ""

test_gh_token_env
test_github_token_env
test_hosts_yml
test_hosts_yml_token_field
test_non_github_host
test_error_message
test_env_priority_over_file

echo ""
echo "=========================================="
echo "Results: $TESTS_PASSED passed, $TESTS_FAILED failed"
echo "=========================================="

if [[ $TESTS_FAILED -gt 0 ]]; then
  exit 1
fi
