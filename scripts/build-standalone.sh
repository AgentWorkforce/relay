#!/bin/bash
set -e

# Build standalone binaries for agent-relay CLI
# Uses esbuild to bundle, then bun to compile

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$ROOT_DIR/bin"
DIST_DIR="$ROOT_DIR/dist"
BUILD_DIR="$ROOT_DIR/.build-standalone"

cd "$ROOT_DIR"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }

# Get version from package.json
VERSION=$(node -p "require('./package.json').version")
info "Building version: $VERSION"

# Ensure TypeScript is compiled
if [ ! -f "$DIST_DIR/src/cli/index.js" ]; then
    info "Building TypeScript..."
    npm run build
fi

# Create build directory
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Use esbuild to bundle everything into a single file
# Externalize native modules that can't be bundled
info "Bundling with esbuild..."

npx esbuild "$DIST_DIR/src/cli/index.js" \
    --bundle \
    --platform=node \
    --target=node18 \
    --format=esm \
    --outfile="$BUILD_DIR/cli-bundle.mjs" \
    --external:better-sqlite3 \
    --external:cpu-features \
    --external:node-pty \
    --external:ssh2 \
    --define:process.env.AGENT_RELAY_VERSION="\"$VERSION\"" \
    --minify \
    2>&1

# Create a wrapper that handles the version
cat > "$BUILD_DIR/standalone.mjs" << EOF
// Agent Relay CLI - Standalone Bundle v$VERSION
// This is a bundled version that doesn't require npm install

const VERSION = "$VERSION";

// Inject version into environment
process.env.AGENT_RELAY_VERSION = VERSION;

// Import the bundled CLI
import './cli-bundle.mjs';
EOF

success "Bundle created"

# Check bundle size
BUNDLE_SIZE=$(du -h "$BUILD_DIR/cli-bundle.mjs" | cut -f1)
info "Bundle size: $BUNDLE_SIZE"

# Try to compile with bun (may fail on native modules)
info "Attempting bun compile..."
mkdir -p "$BIN_DIR"

if bun build "$BUILD_DIR/standalone.mjs" \
    --compile \
    --outfile "$BIN_DIR/agent-relay-standalone" \
    2>&1; then

    success "Compiled standalone binary"

    # Test the binary
    if "$BIN_DIR/agent-relay-standalone" --version 2>/dev/null; then
        success "Binary works: $("$BIN_DIR/agent-relay-standalone" --version)"
    else
        warn "Binary created but may have runtime issues with native modules"
    fi
else
    warn "Bun compile failed (likely due to native modules)"
    info "The bundled JS can still be run with: node $BUILD_DIR/standalone.mjs"
fi

# Create a simple runner script as fallback
cat > "$BIN_DIR/agent-relay-bundle" << EOF
#!/usr/bin/env node
import('$BUILD_DIR/standalone.mjs');
EOF
chmod +x "$BIN_DIR/agent-relay-bundle"

echo ""
info "Build complete!"
info "Bundle: $BUILD_DIR/cli-bundle.mjs ($BUNDLE_SIZE)"
info "Try: node $BUILD_DIR/standalone.mjs --version"

# Cleanup
rm -rf "$BUILD_DIR"/*.bak 2>/dev/null || true
