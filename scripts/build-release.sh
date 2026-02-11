#!/bin/bash
set -e

# Build release artifacts for GitHub releases
# Creates a tarball that can be installed without npm

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$ROOT_DIR/.release"

cd "$ROOT_DIR"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }

# Get version
VERSION=$(node -p "require('./package.json').version")
info "Building release v$VERSION"

# Clean and create release directory
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR/agent-relay"

# Build TypeScript
info "Building TypeScript..."
npm run build

# Copy essential files
info "Copying files..."
cp -r dist "$RELEASE_DIR/agent-relay/"
cp -r bin "$RELEASE_DIR/agent-relay/"
cp package.json "$RELEASE_DIR/agent-relay/"
cp package-lock.json "$RELEASE_DIR/agent-relay/" 2>/dev/null || true

# Install production dependencies only
info "Installing production dependencies..."
cd "$RELEASE_DIR/agent-relay"
npm ci --omit=dev --ignore-scripts 2>/dev/null || npm install --omit=dev --ignore-scripts

# Rebuild native modules
info "Rebuilding native modules..."
npm rebuild better-sqlite3 2>/dev/null || true

# Create runner script
cat > "$RELEASE_DIR/agent-relay/agent-relay" << 'RUNNER'
#!/usr/bin/env node
import('./dist/src/cli/index.js');
RUNNER
chmod +x "$RELEASE_DIR/agent-relay/agent-relay"

# Get size
cd "$RELEASE_DIR"
TOTAL_SIZE=$(du -sh agent-relay | cut -f1)
info "Release size: $TOTAL_SIZE"

# Create tarball
info "Creating tarball..."
tar -czf "agent-relay-v$VERSION.tar.gz" agent-relay

# Create platform-specific tarballs with native binaries
for platform in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
    if [ -f "$ROOT_DIR/bin/agent-relay-$platform" ]; then
        info "Creating $platform tarball..."
        cp "$ROOT_DIR/bin/agent-relay-$platform" agent-relay/bin/agent-relay
        tar -czf "agent-relay-v$VERSION-$platform.tar.gz" agent-relay
        rm agent-relay/bin/agent-relay
    fi
done

success "Release artifacts created in $RELEASE_DIR"
ls -la "$RELEASE_DIR"/*.tar.gz

echo ""
info "To test: tar -xzf $RELEASE_DIR/agent-relay-v$VERSION.tar.gz && ./agent-relay/agent-relay --version"
