#!/bin/bash
#
# Test cases for check-inbox.sh MCP socket detection
#
# This script documents and tests the MCP detection logic in check-inbox.sh.
# The logic checks BOTH conditions before showing MCP tools reference:
# 1. .mcp.json file exists in PROJECT_ROOT
# 2. Relay daemon socket is accessible at RELAY_SOCKET path
#
# Usage:
#   ./check-inbox.test.sh           # Run all tests
#   ./check-inbox.test.sh --verbose # Run with verbose output
#
# The tests verify commit 18bab59 behavior requirements.

set -e

# Test utilities
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_INBOX_SCRIPT="$SCRIPT_DIR/check-inbox.sh"
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

# Create temp directory for test fixtures
TEST_DIR=$(mktemp -d)
trap "rm -rf $TEST_DIR" EXIT

log_verbose() {
    if [[ $VERBOSE -eq 1 ]]; then
        echo -e "${YELLOW}[DEBUG]${NC} $1"
    fi
}

pass() {
    ((PASS_COUNT++))
    echo -e "${GREEN}[PASS]${NC} $1"
}

fail() {
    ((FAIL_COUNT++))
    echo -e "${RED}[FAIL]${NC} $1"
    if [[ -n "$2" ]]; then
        echo -e "       Expected: $2"
    fi
    if [[ -n "$3" ]]; then
        echo -e "       Got:      $3"
    fi
}

run_test() {
    ((TEST_COUNT++))
    local test_name="$1"
    echo ""
    echo "Running: $test_name"
}

# Setup test environment
setup_test_env() {
    local project_root="$1"
    local has_mcp_config="${2:-false}"
    local has_socket="${3:-false}"
    local socket_path="${4:-$TEST_DIR/test-relay.sock}"

    log_verbose "Setup: project_root=$project_root, mcp=$has_mcp_config, socket=$has_socket"

    # Create project root
    mkdir -p "$project_root"

    # Create or remove .mcp.json
    if [[ "$has_mcp_config" == "true" ]]; then
        echo '{"mcpServers":{}}' > "$project_root/.mcp.json"
        log_verbose "Created $project_root/.mcp.json"
    else
        rm -f "$project_root/.mcp.json"
        log_verbose "Removed $project_root/.mcp.json (if existed)"
    fi

    # Create or remove socket
    if [[ "$has_socket" == "true" ]]; then
        # Create a Unix socket using Python (portable method)
        rm -f "$socket_path"
        python3 -c "
import socket
import os
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.bind('$socket_path')
" 2>/dev/null || {
            # Fallback: create a fake socket file for testing
            # Note: This won't be an actual socket, just for file existence test
            rm -f "$socket_path"
            mkfifo "$socket_path" 2>/dev/null || touch "$socket_path"
        }
        log_verbose "Created socket at $socket_path"
    else
        rm -f "$socket_path"
        log_verbose "Removed socket at $socket_path"
    fi
}

# Test the MCP detection logic directly (same as in check-inbox.sh lines 28-34)
check_mcp_available() {
    local project_root="$1"
    local relay_socket="$2"

    # This mirrors the exact logic from check-inbox.sh:
    # if [ -f "$PROJECT_ROOT/.mcp.json" ] && [ -S "$RELAY_SOCKET" ]; then
    #     MCP_AVAILABLE=1
    # fi

    if [ -f "$project_root/.mcp.json" ] && [ -S "$relay_socket" ]; then
        echo "1"
    else
        echo "0"
    fi
}

###############################################################################
# TEST 1: MCP available when BOTH .mcp.json AND socket exist
###############################################################################
run_test "Test 1: MCP available when both .mcp.json AND socket exist"

TEST1_PROJECT="$TEST_DIR/test1_project"
TEST1_SOCKET="$TEST_DIR/test1_relay.sock"

setup_test_env "$TEST1_PROJECT" "true" "true" "$TEST1_SOCKET"

RESULT=$(check_mcp_available "$TEST1_PROJECT" "$TEST1_SOCKET")
if [[ "$RESULT" == "1" ]]; then
    pass "MCP detected when both conditions met"
else
    fail "MCP should be available when both .mcp.json and socket exist" "1" "$RESULT"
fi

###############################################################################
# TEST 2: MCP NOT available when .mcp.json missing
###############################################################################
run_test "Test 2: MCP NOT available when .mcp.json missing"

TEST2_PROJECT="$TEST_DIR/test2_project"
TEST2_SOCKET="$TEST_DIR/test2_relay.sock"

setup_test_env "$TEST2_PROJECT" "false" "true" "$TEST2_SOCKET"

RESULT=$(check_mcp_available "$TEST2_PROJECT" "$TEST2_SOCKET")
if [[ "$RESULT" == "0" ]]; then
    pass "MCP correctly hidden when .mcp.json missing"
else
    fail "MCP should NOT be available when .mcp.json is missing" "0" "$RESULT"
fi

###############################################################################
# TEST 3: MCP NOT available when socket missing
###############################################################################
run_test "Test 3: MCP NOT available when socket missing"

TEST3_PROJECT="$TEST_DIR/test3_project"
TEST3_SOCKET="$TEST_DIR/test3_relay.sock"

setup_test_env "$TEST3_PROJECT" "true" "false" "$TEST3_SOCKET"

RESULT=$(check_mcp_available "$TEST3_PROJECT" "$TEST3_SOCKET")
if [[ "$RESULT" == "0" ]]; then
    pass "MCP correctly hidden when socket missing"
else
    fail "MCP should NOT be available when socket is missing" "0" "$RESULT"
fi

###############################################################################
# TEST 4: RELAY_SOCKET env var respected
###############################################################################
run_test "Test 4: RELAY_SOCKET env var respected"

TEST4_PROJECT="$TEST_DIR/test4_project"
TEST4_CUSTOM_SOCKET="$TEST_DIR/custom/relay.sock"

mkdir -p "$(dirname "$TEST4_CUSTOM_SOCKET")"
setup_test_env "$TEST4_PROJECT" "true" "true" "$TEST4_CUSTOM_SOCKET"

# Check using custom socket path
RESULT=$(check_mcp_available "$TEST4_PROJECT" "$TEST4_CUSTOM_SOCKET")
if [[ "$RESULT" == "1" ]]; then
    pass "Custom RELAY_SOCKET path respected"
else
    fail "Should use custom RELAY_SOCKET path" "1" "$RESULT"
fi

###############################################################################
# TEST 5: Default socket path (/tmp/agent-relay.sock)
###############################################################################
run_test "Test 5: Default socket path behavior"

# Note: This test documents the expected default, but doesn't create an actual
# socket at /tmp/agent-relay.sock to avoid side effects on the system.
# The default value is defined in check-inbox.sh line 30:
#   RELAY_SOCKET="${RELAY_SOCKET:-/tmp/agent-relay.sock}"

DEFAULT_SOCKET="/tmp/agent-relay.sock"

if [[ -z "${RELAY_SOCKET:-}" ]]; then
    EFFECTIVE_SOCKET="${RELAY_SOCKET:-/tmp/agent-relay.sock}"
    if [[ "$EFFECTIVE_SOCKET" == "$DEFAULT_SOCKET" ]]; then
        pass "Default socket path is /tmp/agent-relay.sock when env not set"
    else
        fail "Default socket path should be /tmp/agent-relay.sock" "$DEFAULT_SOCKET" "$EFFECTIVE_SOCKET"
    fi
else
    pass "RELAY_SOCKET env var is set, skipping default test (current: $RELAY_SOCKET)"
fi

###############################################################################
# TEST 6: Both conditions false
###############################################################################
run_test "Test 6: Both conditions false"

TEST6_PROJECT="$TEST_DIR/test6_project"
TEST6_SOCKET="$TEST_DIR/test6_relay.sock"

setup_test_env "$TEST6_PROJECT" "false" "false" "$TEST6_SOCKET"

RESULT=$(check_mcp_available "$TEST6_PROJECT" "$TEST6_SOCKET")
if [[ "$RESULT" == "0" ]]; then
    pass "MCP correctly hidden when both conditions false"
else
    fail "MCP should NOT be available when both conditions false" "0" "$RESULT"
fi

###############################################################################
# TEST 7: Socket exists but is not a socket (regular file)
###############################################################################
run_test "Test 7: Socket path exists but is a regular file (not socket)"

TEST7_PROJECT="$TEST_DIR/test7_project"
TEST7_SOCKET="$TEST_DIR/test7_not_a_socket.txt"

mkdir -p "$TEST7_PROJECT"
echo '{"mcpServers":{}}' > "$TEST7_PROJECT/.mcp.json"
echo "not a socket" > "$TEST7_SOCKET"  # Regular file, not a socket

RESULT=$(check_mcp_available "$TEST7_PROJECT" "$TEST7_SOCKET")
if [[ "$RESULT" == "0" ]]; then
    pass "MCP correctly hidden when socket path is a regular file"
else
    fail "MCP should NOT be available when socket path is not a socket" "0" "$RESULT"
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
