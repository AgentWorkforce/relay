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

# Install globally (with retry for CDN propagation delays)
log_info "Installing ${PACKAGE_SPEC} globally..."
if retry-command.sh "Global npm install of ${PACKAGE_SPEC}" npm install -g "$PACKAGE_SPEC"; then
    record_pass "Global npm install succeeded"
else
    record_fail "Global npm install failed after retries"
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

# Install as local dependency (with retry for CDN propagation delays)
log_info "Installing ${PACKAGE_SPEC} locally..."
if retry-command.sh "Local npm install of ${PACKAGE_SPEC}" npm install "$PACKAGE_SPEC"; then
    record_pass "Local npm install succeeded"
else
    record_fail "Local npm install failed after retries"
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
# Test 4: broker binary resolution via SDK resolver
# ============================================
# The broker is delivered as a platform-specific optional dependency
# (@agent-relay/broker-<platform>-<arch>). getBrokerBinaryPath() is the
# canonical way clients locate it at runtime.
log_header "Test 4: broker binary resolution"

BROKER_TEST=$(node --input-type=module -e "
import { getBrokerBinaryPath, getOptionalDepPackageName } from '@agent-relay/sdk/broker-path';
import { accessSync, constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
try {
    const expected = getOptionalDepPackageName();
    const p = getBrokerBinaryPath();
    console.log('expected:', expected);
    console.log('resolved:', p);
    if (!p) { console.log('BROKER_FAIL: resolver returned null'); process.exit(0); }
    if (!p.replace(/\\\\/g, '/').includes(expected)) {
        console.log('BROKER_FAIL: not via optional-dep package');
        process.exit(0);
    }
    accessSync(p, constants.X_OK);
    const out = execFileSync(p, ['--help'], { encoding: 'utf8' });
    if (!out.includes('agent-relay-broker')) {
        console.log('BROKER_FAIL: --help output missing agent-relay-broker');
        process.exit(0);
    }
    console.log('BROKER_OK');
} catch (e) {
    console.log('BROKER_FAIL:', e && e.message ? e.message : String(e));
}
" 2>&1) || true

log_info "Broker resolution output:"
echo "$BROKER_TEST"

if echo "$BROKER_TEST" | grep -q "BROKER_OK"; then
    record_pass "broker binary resolves via optional-dep package and --help works"
else
    record_fail "broker binary resolution failed"
fi

# ============================================
# Test 5: SDK exports
# ============================================
log_header "Test 5: SDK exports"

log_info "Testing if SDK exports are accessible..."
SDK_TEST=$(node -e "
try {
    const pkg = require('agent-relay');
    const exports = Object.keys(pkg);
    console.log('Exports:', exports.join(', '));

    if (typeof pkg.AgentRelayClient === 'function') {
        console.log('SDK_OK');
    } else {
        console.log('NO_CLIENT');
    }
} catch (e) {
    console.log('ERROR:', e.message);
}
" 2>&1) || true

log_info "SDK test output: $SDK_TEST"
if echo "$SDK_TEST" | grep -q "SDK_OK"; then
    record_pass "AgentRelayClient is accessible"
elif echo "$SDK_TEST" | grep -q "NO_CLIENT"; then
    record_fail "AgentRelayClient not found in exports"
else
    record_fail "Failed to load agent-relay package: $SDK_TEST"
fi

# ============================================
# Test 6: @agent-relay/utils resolution (regression guard for bundledDependencies)
# ============================================
log_header "Test 6: @agent-relay/utils resolution"

log_info "Verifying @agent-relay/utils resolves from installed agent-relay..."
UTILS_RESOLUTION=$(node -e "
try {
    const path = require('path');
    const pkgDir = path.dirname(require.resolve('agent-relay/package.json'));
    const resolved = require.resolve('@agent-relay/utils', { paths: [pkgDir] });
    console.log('RESOLVED:', resolved);
    console.log('UTILS_RESOLVE_OK');
} catch (e) {
    console.log('UTILS_RESOLVE_FAIL:', e.code || e.message);
}
" 2>&1) || true

log_info "Utils resolution output: $UTILS_RESOLUTION"
if echo "$UTILS_RESOLUTION" | grep -q "UTILS_RESOLVE_OK"; then
    record_pass "@agent-relay/utils resolves from installed agent-relay"
else
    record_fail "@agent-relay/utils is NOT resolvable - bundledDependencies regression"
fi

log_info "Inspecting installed CLI cloud command directory..."
ls -la ./node_modules/agent-relay/dist/cli/commands/cloud/ 2>/dev/null || \
    ls -la ./node_modules/agent-relay/dist/src/cli/commands/cloud/ 2>/dev/null || \
    log_warn "No packaged cloud command directory found; falling back to dist scan"

log_info "Resolving packaged module that imports @agent-relay/utils..."
UTILS_IMPORT_TARGET=$(node -e "
const fs = require('fs');
const path = require('path');

try {
    const pkgDir = path.dirname(require.resolve('agent-relay/package.json'));
    const candidates = [
        path.join(pkgDir, 'dist/cli/commands/cloud/connect.js'),
        path.join(pkgDir, 'dist/src/cli/commands/cloud/connect.js'),
        path.join(pkgDir, 'dist/cli/commands/core.js'),
        path.join(pkgDir, 'dist/src/cli/commands/core.js'),
        path.join(pkgDir, 'dist/cli/bootstrap.js'),
        path.join(pkgDir, 'dist/src/cli/bootstrap.js')
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            console.log(candidate);
            process.exit(0);
        }
    }

    const distDir = path.join(pkgDir, 'dist');
    const stack = [distDir];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current || !fs.existsSync(current)) {
            continue;
        }
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile() || !fullPath.endsWith('.js')) {
                continue;
            }
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes('@agent-relay/utils')) {
                console.log(fullPath);
                process.exit(0);
            }
        }
    }

    console.log('UTILS_IMPORT_TARGET_NOT_FOUND');
} catch (e) {
    console.log('UTILS_IMPORT_TARGET_ERROR:', e.code || e.message);
}
" 2>&1 | tail -n 1) || true

log_info "Selected smoke-test target: $UTILS_IMPORT_TARGET"
log_info "Dynamic-import smoke test for packaged module that imports @agent-relay/utils..."
CLOUD_CONNECT_SMOKE=$(node --input-type=module -e "
import { pathToFileURL } from 'node:url';

try {
    const target = process.argv[1];
    if (!target || target === 'UTILS_IMPORT_TARGET_NOT_FOUND' || target.startsWith('UTILS_IMPORT_TARGET_ERROR:')) {
        console.log('CLOUD_CONNECT_IMPORT_FAIL:', target || 'missing target');
    } else {
        await import(pathToFileURL(target).href);
        console.log('CLOUD_CONNECT_IMPORT_OK');
    }
} catch (e) {
    if (e && e.code === 'ERR_MODULE_NOT_FOUND') {
        console.log('CLOUD_CONNECT_IMPORT_FAIL:', e.message);
    } else {
        // A different error (e.g. expecting argv) is fine - the module loaded
        console.log('CLOUD_CONNECT_IMPORT_OK_WITH_RUNTIME_ERR');
    }
}
" "$UTILS_IMPORT_TARGET" 2>&1) || true

log_info "Cloud connect import output: $CLOUD_CONNECT_SMOKE"
if echo "$CLOUD_CONNECT_SMOKE" | grep -q "CLOUD_CONNECT_IMPORT_OK"; then
    record_pass "cloud connect module imports without ERR_MODULE_NOT_FOUND"
elif echo "$CLOUD_CONNECT_SMOKE" | grep -q "CLOUD_CONNECT_IMPORT_FAIL"; then
    record_fail "cloud connect import FAILED with ERR_MODULE_NOT_FOUND: $CLOUD_CONNECT_SMOKE"
else
    log_warn "cloud connect import had unknown outcome: $CLOUD_CONNECT_SMOKE"
    record_fail "cloud connect import indeterminate"
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
