#!/bin/bash
# Post-publish verification script
# Tests both global npm install and npx installation of agent-relay
#
# Environment variables:
#   PACKAGE_VERSION: Version to install (default: latest)
#   NODE_VERSION: Node version being tested (for logging)

# Don't use set -e so we can collect all test results
# set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[PASS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[FAIL]${NC} $1"; }
log_header() { echo -e "\n${BLUE}========================================${NC}"; echo -e "${BLUE}$1${NC}"; echo -e "${BLUE}========================================${NC}"; }

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0

record_pass() {
    ((TESTS_PASSED++))
    log_success "$1"
}

record_fail() {
    ((TESTS_FAILED++))
    log_error "$1"
}

# Get package specification
PACKAGE_SPEC="agent-relay"
if [ -n "$PACKAGE_VERSION" ] && [ "$PACKAGE_VERSION" != "latest" ]; then
    PACKAGE_SPEC="agent-relay@${PACKAGE_VERSION}"
fi

log_header "Post-Publish Verification"
log_info "Node.js version: $(node --version)"
log_info "npm version: $(npm --version)"
log_info "Package to test: $PACKAGE_SPEC"
log_info "User: $(whoami)"
log_info "Working directory: $(pwd)"
log_info "PATH: $PATH"
log_info "NPM prefix: $(npm config get prefix)"
log_info "NPM bin location: $(npm config get prefix)/bin"

# ============================================
# Test 1: Global npm install
# ============================================
log_header "Test 1: Global npm install"

# Ensure npm global bin is in PATH
NPM_BIN="$(npm config get prefix)/bin"
export PATH="$NPM_BIN:$PATH"
log_info "Updated PATH to include: $NPM_BIN"

# Clean any previous installation
log_info "Cleaning previous global installation..."
npm uninstall -g agent-relay 2>/dev/null || true

# Install globally
log_info "Installing ${PACKAGE_SPEC} globally..."
npm install -g "$PACKAGE_SPEC"
INSTALL_EXIT=$?
log_info "npm install exit code: $INSTALL_EXIT"
if [ $INSTALL_EXIT -eq 0 ]; then
    record_pass "Global npm install succeeded"
else
    record_fail "Global npm install failed with exit code $INSTALL_EXIT"
fi

# Verify the binary exists
log_info "Checking if agent-relay binary exists..."
if [ -f "$NPM_BIN/agent-relay" ]; then
    log_info "Binary found at: $NPM_BIN/agent-relay"
    ls -la "$NPM_BIN/agent-relay"
else
    log_warn "Binary not found at expected location: $NPM_BIN/agent-relay"
    log_info "Contents of $NPM_BIN:"
    ls -la "$NPM_BIN" 2>/dev/null || echo "Directory does not exist"
fi

# Test --version flag
log_info "Testing 'agent-relay --version'..."
GLOBAL_VERSION=$(agent-relay --version 2>&1) || true
if [ -n "$GLOBAL_VERSION" ]; then
    log_info "Output: $GLOBAL_VERSION"
    # Verify it contains a version number pattern
    if echo "$GLOBAL_VERSION" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
        record_pass "Global install --version returns valid version: $GLOBAL_VERSION"
    else
        record_fail "Global install --version output doesn't contain version number"
    fi
else
    record_fail "Global install --version returned empty output"
fi

# Test -V flag (short version flag)
log_info "Testing 'agent-relay -V'..."
GLOBAL_V=$(agent-relay -V 2>&1) || true
if [ -n "$GLOBAL_V" ]; then
    record_pass "Global install -V works: $GLOBAL_V"
else
    record_fail "Global install -V failed"
fi

# Test version command
log_info "Testing 'agent-relay version'..."
GLOBAL_VERSION_CMD=$(agent-relay version 2>&1) || true
if echo "$GLOBAL_VERSION_CMD" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
    record_pass "Global install 'version' command works"
else
    record_fail "Global install 'version' command failed"
fi

# Test help command
log_info "Testing 'agent-relay --help'..."
GLOBAL_HELP=$(agent-relay --help 2>&1) || true
if echo "$GLOBAL_HELP" | grep -q "agent-relay"; then
    record_pass "Global install --help works"
else
    record_fail "Global install --help failed"
fi

# Cleanup global install
log_info "Cleaning up global installation..."
npm uninstall -g agent-relay 2>/dev/null || true

# ============================================
# Test 2: npx execution (without prior install)
# ============================================
log_header "Test 2: npx execution"

# Clear npm cache to ensure fresh download
log_info "Clearing npm cache for npx test..."
npm cache clean --force 2>/dev/null || true

# Test npx --version
log_info "Testing 'npx ${PACKAGE_SPEC} --version'..."
NPX_VERSION=$(npx -y "$PACKAGE_SPEC" --version 2>&1) || true
if [ -n "$NPX_VERSION" ]; then
    log_info "Output: $NPX_VERSION"
    if echo "$NPX_VERSION" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
        record_pass "npx --version returns valid version: $NPX_VERSION"
    else
        record_fail "npx --version output doesn't contain version number"
    fi
else
    record_fail "npx --version returned empty output"
fi

# Test npx help
log_info "Testing 'npx ${PACKAGE_SPEC} --help'..."
NPX_HELP=$(npx -y "$PACKAGE_SPEC" --help 2>&1) || true
if echo "$NPX_HELP" | grep -q "agent-relay"; then
    record_pass "npx --help works"
else
    record_fail "npx --help failed"
fi

# Test npx version command
log_info "Testing 'npx ${PACKAGE_SPEC} version'..."
NPX_VERSION_CMD=$(npx -y "$PACKAGE_SPEC" version 2>&1) || true
if echo "$NPX_VERSION_CMD" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
    record_pass "npx 'version' command works"
else
    record_fail "npx 'version' command failed"
fi

# ============================================
# Test 3: Local project install
# ============================================
log_header "Test 3: Local project install"

# Create a test project
TEST_PROJECT_DIR=$(mktemp -d)
log_info "Created test project at: $TEST_PROJECT_DIR"
cd "$TEST_PROJECT_DIR"

# Initialize package.json
log_info "Initializing package.json..."
npm init -y > /dev/null 2>&1

# Install as local dependency
log_info "Installing ${PACKAGE_SPEC} locally..."
if npm install "$PACKAGE_SPEC" 2>&1; then
    record_pass "Local npm install succeeded"
else
    record_fail "Local npm install failed"
fi

# Test via npx (should use local version)
log_info "Testing 'npx agent-relay --version' (local)..."
LOCAL_VERSION=$(npx agent-relay --version 2>&1) || true
if [ -n "$LOCAL_VERSION" ]; then
    if echo "$LOCAL_VERSION" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
        record_pass "Local install via npx works: $LOCAL_VERSION"
    else
        record_fail "Local install via npx doesn't return version"
    fi
else
    record_fail "Local install via npx failed"
fi

# Test via node_modules/.bin
log_info "Testing './node_modules/.bin/agent-relay --version'..."
if [ -x "./node_modules/.bin/agent-relay" ]; then
    BIN_VERSION=$(./node_modules/.bin/agent-relay --version 2>&1) || true
    if echo "$BIN_VERSION" | grep -qE '[0-9]+\.[0-9]+\.[0-9]+'; then
        record_pass "Local bin executable works: $BIN_VERSION"
    else
        record_fail "Local bin executable doesn't return version"
    fi
else
    record_fail "Local bin executable not found or not executable"
fi

# ============================================
# Test 4: relay-pty binary verification
# ============================================
log_header "Test 4: relay-pty binary verification"

# Check if relay-pty binary exists
log_info "Checking for relay-pty binary..."

# Get the installed package location
PACKAGE_DIR="./node_modules/agent-relay"
BIN_DIR="$PACKAGE_DIR/bin"

if [ -d "$BIN_DIR" ]; then
    log_info "Binary directory found: $BIN_DIR"
    log_info "Contents of bin directory:"
    ls -la "$BIN_DIR"

    # Check for platform-specific binaries
    PLATFORM=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)

    # Map architecture names
    case "$ARCH" in
        x86_64) ARCH_NAME="x64" ;;
        aarch64|arm64) ARCH_NAME="arm64" ;;
        *) ARCH_NAME="$ARCH" ;;
    esac

    log_info "Platform: $PLATFORM, Architecture: $ARCH_NAME"

    # Check for the main relay-pty binary
    if [ -f "$BIN_DIR/relay-pty" ]; then
        record_pass "relay-pty binary exists"

        # Check if executable
        if [ -x "$BIN_DIR/relay-pty" ]; then
            record_pass "relay-pty binary is executable"

            # Test the binary
            log_info "Testing relay-pty --help..."
            PTY_HELP=$("$BIN_DIR/relay-pty" --help 2>&1) || true
            if echo "$PTY_HELP" | grep -q "PTY wrapper"; then
                record_pass "relay-pty --help works"
            else
                log_info "relay-pty output: $PTY_HELP"
                record_fail "relay-pty --help doesn't show expected output"
            fi
        else
            record_fail "relay-pty binary is not executable"
        fi
    else
        record_fail "relay-pty binary not found at $BIN_DIR/relay-pty"
    fi

    # Check for platform-specific binary
    PLATFORM_BINARY="relay-pty-${PLATFORM}-${ARCH_NAME}"
    if [ -f "$BIN_DIR/$PLATFORM_BINARY" ]; then
        log_info "Platform-specific binary found: $PLATFORM_BINARY"
        if [ -x "$BIN_DIR/$PLATFORM_BINARY" ]; then
            record_pass "Platform-specific binary $PLATFORM_BINARY is executable"
        else
            record_fail "Platform-specific binary $PLATFORM_BINARY is not executable"
        fi
    else
        log_warn "Platform-specific binary not found: $PLATFORM_BINARY (may use generic binary)"
    fi
else
    record_fail "Binary directory not found: $BIN_DIR"
fi

# ============================================
# Test 5: Spawn infrastructure verification
# ============================================
log_header "Test 5: Spawn infrastructure verification"

# Verify spawner module can be loaded
log_info "Testing if spawner module is accessible..."
SPAWNER_TEST=$(node -e "
try {
    const pkg = require('agent-relay');
    // Check if key exports exist
    const exports = Object.keys(pkg);
    console.log('Exports:', exports.join(', '));

    // Check for spawn-related functionality
    if (typeof pkg.AgentSpawner === 'function' || typeof pkg.createSpawner === 'function') {
        console.log('SPAWN_OK');
    } else {
        console.log('NO_SPAWNER');
    }
} catch (e) {
    console.log('ERROR:', e.message);
}
" 2>&1) || true

log_info "Spawner test output: $SPAWNER_TEST"
if echo "$SPAWNER_TEST" | grep -q "SPAWN_OK"; then
    record_pass "Spawner module is accessible"
elif echo "$SPAWNER_TEST" | grep -q "NO_SPAWNER"; then
    log_warn "Spawner not in main exports (may be in submodule)"
else
    record_fail "Failed to load agent-relay package: $SPAWNER_TEST"
fi

# Test binary resolution using actual package logic
log_info "Testing actual binary resolution from @agent-relay/utils..."
BINARY_RESOLUTION=$(node -e "
const path = require('path');
const fs = require('fs');

// First, try using the actual findRelayPtyBinary function from the package
try {
    // Try to load from scoped package first (how it's used in production)
    const { findRelayPtyBinary, getLastSearchPaths } = require('@agent-relay/utils');
    const binaryPath = findRelayPtyBinary(__dirname);
    const searchPaths = getLastSearchPaths();

    console.log('Using @agent-relay/utils findRelayPtyBinary');
    console.log('Search paths:', JSON.stringify(searchPaths.slice(0, 5), null, 2));

    if (binaryPath) {
        console.log('Found binary at:', binaryPath);
        console.log('RESOLUTION_OK');
    } else {
        console.log('Binary not found via findRelayPtyBinary');
        console.log('RESOLUTION_FAILED');
    }
} catch (e) {
    console.log('Could not load @agent-relay/utils:', e.message);

    // Fallback: manual check
    const packageDir = path.dirname(require.resolve('agent-relay/package.json'));
    const binDir = path.join(packageDir, 'bin');

    const platform = process.platform;
    const arch = process.arch;

    const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
    const archMap = { x64: 'x64', arm64: 'arm64' };

    const platformName = platformMap[platform] || platform;
    const archName = archMap[arch] || arch;

    const specificBinary = path.join(binDir, 'relay-pty-' + platformName + '-' + archName);
    const genericBinary = path.join(binDir, 'relay-pty');

    console.log('Fallback: manual binary check');
    console.log('Package dir:', packageDir);
    console.log('Looking for:', specificBinary);
    console.log('Fallback:', genericBinary);

    if (fs.existsSync(specificBinary)) {
        console.log('RESOLUTION_OK (platform-specific)');
    } else if (fs.existsSync(genericBinary)) {
        console.log('RESOLUTION_OK (generic)');
    } else {
        console.log('RESOLUTION_FAILED');
    }
}
" 2>&1) || true

log_info "Binary resolution output:"
echo "$BINARY_RESOLUTION"

if echo "$BINARY_RESOLUTION" | grep -q "RESOLUTION_OK"; then
    record_pass "Binary resolution logic finds relay-pty"
else
    record_fail "Binary resolution failed - relay-pty not found"
fi

# Cleanup test project
log_info "Cleaning up test project..."
cd /home/testuser
rm -rf "$TEST_PROJECT_DIR"

# ============================================
# Summary
# ============================================
log_header "Verification Summary"
echo ""
log_info "Node.js: $(node --version)"
log_info "Package: $PACKAGE_SPEC"
echo ""
echo -e "Tests passed: ${GREEN}${TESTS_PASSED}${NC}"
echo -e "Tests failed: ${RED}${TESTS_FAILED}${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    log_success "All tests passed!"
    exit 0
else
    log_error "Some tests failed!"
    exit 1
fi
