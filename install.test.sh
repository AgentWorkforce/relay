#!/bin/bash
#
# Test cases for install.sh version parsing
#
# This script tests the version parsing logic to prevent regressions like
# the "mentions_count" bug where greedy regex matching extracted incorrect
# values from the GitHub API response.
#
# Usage:
#   ./install.test.sh           # Run all tests
#   ./install.test.sh --verbose # Run with verbose output
#

set -e

# Test utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_COUNT=0
PASS_COUNT=0
FAIL_COUNT=0
VERBOSE=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Parse arguments
if [[ "$1" == "--verbose" ]]; then
    VERBOSE=1
fi

log_verbose() {
    if [[ $VERBOSE -eq 1 ]]; then
        echo -e "${YELLOW}[DEBUG]${NC} $1"
    fi
}

pass() {
    ((PASS_COUNT++)) || true
    echo -e "${GREEN}[PASS]${NC} $1"
}

fail() {
    ((FAIL_COUNT++)) || true
    echo -e "${RED}[FAIL]${NC} $1"
    if [[ -n "$2" ]]; then
        echo -e "       Expected: $2"
    fi
    if [[ -n "$3" ]]; then
        echo -e "       Got:      $3"
    fi
}

run_test() {
    ((TEST_COUNT++)) || true
    local test_name="$1"
    echo ""
    echo "Running: $test_name"
}

# Extract the version parsing logic from install.sh for testing
# This must match the exact pattern used in install.sh
parse_version() {
    local json_input="$1"
    echo "$json_input" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

###############################################################################
# TEST 1: Parse version from simple JSON
###############################################################################
run_test "Test 1: Parse version from simple JSON"

SIMPLE_JSON='{"tag_name":"v2.1.7","name":"v2.1.7"}'
RESULT=$(parse_version "$SIMPLE_JSON")
if [[ "$RESULT" == "v2.1.7" ]]; then
    pass "Correctly parsed v2.1.7 from simple JSON"
else
    fail "Should parse v2.1.7 from simple JSON" "v2.1.7" "$RESULT"
fi

###############################################################################
# TEST 2: Ensure mentions_count is NOT extracted (the original bug)
###############################################################################
run_test "Test 2: Regression test - should NOT extract mentions_count"

# This is a real (truncated) GitHub API response that caused the bug
JSON_WITH_MENTIONS='{"tag_name":"v2.1.7","name":"v2.1.7","body":"Release notes","mentions_count":1}'

RESULT=$(parse_version "$JSON_WITH_MENTIONS")
log_verbose "Parsed result: '$RESULT'"

if [[ "$RESULT" == "v2.1.7" ]]; then
    pass "Correctly parsed v2.1.7, not mentions_count"
elif [[ "$RESULT" == "mentions_count" ]]; then
    fail "REGRESSION: Extracted 'mentions_count' instead of version" "v2.1.7" "mentions_count"
else
    fail "Unexpected parse result" "v2.1.7" "$RESULT"
fi

###############################################################################
# TEST 3: Parse version from full GitHub API response
###############################################################################
run_test "Test 3: Parse version from realistic GitHub API response"

# Realistic (but truncated) GitHub API response
FULL_JSON='{"url":"https://api.github.com/repos/test/test/releases/123","tag_name":"v1.2.3","name":"Release v1.2.3","draft":false,"prerelease":false,"author":{"login":"test"},"body":"Changes here","mentions_count":5}'

RESULT=$(parse_version "$FULL_JSON")
if [[ "$RESULT" == "v1.2.3" ]]; then
    pass "Correctly parsed v1.2.3 from full JSON"
else
    fail "Should parse v1.2.3 from full JSON" "v1.2.3" "$RESULT"
fi

###############################################################################
# TEST 4: Handle version without 'v' prefix
###############################################################################
run_test "Test 4: Handle version without 'v' prefix"

JSON_NO_V='{"tag_name":"2.0.0","name":"2.0.0"}'
RESULT=$(parse_version "$JSON_NO_V")
if [[ "$RESULT" == "2.0.0" ]]; then
    pass "Correctly parsed 2.0.0 (no v prefix)"
else
    fail "Should parse version without v prefix" "2.0.0" "$RESULT"
fi

###############################################################################
# TEST 5: Handle prerelease versions
###############################################################################
run_test "Test 5: Handle prerelease versions"

JSON_PRERELEASE='{"tag_name":"v3.0.0-beta.1","name":"Beta Release"}'
RESULT=$(parse_version "$JSON_PRERELEASE")
if [[ "$RESULT" == "v3.0.0-beta.1" ]]; then
    pass "Correctly parsed prerelease version"
else
    fail "Should parse prerelease version" "v3.0.0-beta.1" "$RESULT"
fi

###############################################################################
# TEST 6: Multiple quoted strings after tag_name should not confuse parser
###############################################################################
run_test "Test 6: Multiple quoted fields should not confuse parser"

# JSON with many quoted strings after tag_name
JSON_MANY_FIELDS='{"tag_name":"v4.5.6","target_commitish":"main","name":"v4.5.6","draft":false,"body":"test","author":{"login":"user","type":"User"},"reactions":{"url":"test","heart":0},"mentions_count":10}'

RESULT=$(parse_version "$JSON_MANY_FIELDS")
if [[ "$RESULT" == "v4.5.6" ]]; then
    pass "Correctly parsed version despite many following quoted fields"
else
    fail "Should parse version correctly" "v4.5.6" "$RESULT"
fi

###############################################################################
# TEST 7: Whitespace handling in JSON
###############################################################################
run_test "Test 7: Handle whitespace variations in JSON"

JSON_WITH_SPACES='{"tag_name" : "v5.0.0" , "name" : "Test"}'
RESULT=$(parse_version "$JSON_WITH_SPACES")
if [[ "$RESULT" == "v5.0.0" ]]; then
    pass "Correctly handled whitespace in JSON"
else
    fail "Should handle whitespace variations" "v5.0.0" "$RESULT"
fi

###############################################################################
# TEST 8: Empty or malformed JSON returns empty
###############################################################################
run_test "Test 8: Empty/malformed JSON returns empty"

EMPTY_JSON='{}'
RESULT=$(parse_version "$EMPTY_JSON")
if [[ -z "$RESULT" ]]; then
    pass "Correctly returned empty for JSON without tag_name"
else
    fail "Should return empty for JSON without tag_name" "(empty)" "$RESULT"
fi

###############################################################################
# TEST 9: Live API test (optional, requires network)
###############################################################################
run_test "Test 9: Live GitHub API test"

if command -v curl &> /dev/null; then
    # Disable set -e for this test to handle API failures gracefully
    set +e
    LIVE_RESULT=$(curl -fsSL "https://api.github.com/repos/AgentWorkforce/relay/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
    CURL_EXIT=$?
    set -e

    if [[ $CURL_EXIT -ne 0 ]] || [[ -z "$LIVE_RESULT" ]]; then
        echo -e "${YELLOW}[SKIP]${NC} Could not reach GitHub API (network issue or rate limited)"
    elif [[ "$LIVE_RESULT" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        pass "Live API returned valid version: $LIVE_RESULT"
    else
        fail "Live API returned unexpected format" "v*.*.* pattern" "$LIVE_RESULT"
    fi
else
    echo -e "${YELLOW}[SKIP]${NC} curl not available for live test"
fi

###############################################################################
# Summary
###############################################################################
echo ""
echo "============================================="
echo "Test Summary"
echo "============================================="
echo "Total:  $TEST_COUNT"
echo -e "Passed: ${GREEN}$PASS_COUNT${NC}"
if [[ $FAIL_COUNT -gt 0 ]]; then
    echo -e "Failed: ${RED}$FAIL_COUNT${NC}"
    exit 1
else
    echo -e "Failed: $FAIL_COUNT"
    echo ""
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
fi
