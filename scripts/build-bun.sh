#!/bin/bash
set -e

# Build standalone binaries using bun compile
# Creates cross-platform executables that don't require Node.js or Bun to run

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
RELEASE_DIR="$ROOT_DIR/.release"

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

# Check for bun
if ! command -v bun &> /dev/null; then
    warn "Bun not found. Installing..."
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
fi

info "Using bun $(bun --version)"

# Clean and create release directory
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

# Build TypeScript first (for type checking)
info "Building TypeScript..."
npm run build

# Targets for cross-compilation
# Format: "target:output-suffix"
TARGETS=(
    "bun-darwin-arm64:darwin-arm64"
    "bun-darwin-x64:darwin-x64"
    "bun-linux-x64:linux-x64"
    "bun-linux-arm64:linux-arm64"
)

# Build for each target
for target_spec in "${TARGETS[@]}"; do
    IFS=':' read -r target suffix <<< "$target_spec"
    output="$RELEASE_DIR/agent-relay-$suffix"

    info "Building for $target..."

    if bun build \
        --compile \
        --minify \
        --target="$target" \
        --define="process.env.AGENT_RELAY_VERSION=\"$VERSION\"" \
        --external better-sqlite3 \
        --external cpu-features \
        --external node-pty \
        --external ssh2 \
        ./dist/src/cli/index.js \
        --outfile "$output" 2>&1; then

        # Get file size
        if [ -f "$output" ]; then
            SIZE=$(du -h "$output" | cut -f1)
            success "Built $output ($SIZE)"

            # Compress with gzip for faster downloads
            info "Compressing $output..."
            gzip -9 -k "$output"
            COMPRESSED_SIZE=$(du -h "${output}.gz" | cut -f1)
            success "Compressed to ${output}.gz ($COMPRESSED_SIZE)"
        else
            warn "Build completed but output not found: $output"
        fi
    else
        warn "Failed to build for $target (may not be available on this platform)"
    fi
done

# Also build for current platform without cross-compilation (most reliable)
info "Building for current platform..."
CURRENT_OUTPUT="$RELEASE_DIR/agent-relay"
if bun build \
    --compile \
    --minify \
    --define="process.env.AGENT_RELAY_VERSION=\"$VERSION\"" \
    --external better-sqlite3 \
    --external cpu-features \
    --external node-pty \
    --external ssh2 \
    ./dist/src/cli/index.js \
    --outfile "$CURRENT_OUTPUT" 2>&1; then

    SIZE=$(du -h "$CURRENT_OUTPUT" | cut -f1)
    success "Built $CURRENT_OUTPUT ($SIZE)"

    # Test the binary
    if "$CURRENT_OUTPUT" --version 2>/dev/null; then
        success "Binary works: $("$CURRENT_OUTPUT" --version)"
    fi

    # Compress with gzip for faster downloads
    info "Compressing $CURRENT_OUTPUT..."
    gzip -9 -k "$CURRENT_OUTPUT"
    COMPRESSED_SIZE=$(du -h "${CURRENT_OUTPUT}.gz" | cut -f1)
    success "Compressed to ${CURRENT_OUTPUT}.gz ($COMPRESSED_SIZE)"
fi

# List all built binaries
echo ""
info "Built binaries:"
ls -lh "$RELEASE_DIR"/agent-relay* 2>/dev/null || echo "No binaries found"

# Verify at least one binary was built
BINARY_COUNT=$(ls "$RELEASE_DIR"/agent-relay* 2>/dev/null | grep -v '.gz$' | wc -l | tr -d ' ')
if [ "$BINARY_COUNT" -eq 0 ]; then
    warn "No binaries were built!"
    exit 1
fi

# Print compression summary
echo ""
info "Compression summary:"
for uncompressed in "$RELEASE_DIR"/agent-relay-*; do
    if [[ "$uncompressed" != *.gz ]] && [ -f "$uncompressed" ] && [ -f "${uncompressed}.gz" ]; then
        UN_SIZE=$(stat -f%z "$uncompressed" 2>/dev/null || stat -c%s "$uncompressed")
        GZ_SIZE=$(stat -f%z "${uncompressed}.gz" 2>/dev/null || stat -c%s "${uncompressed}.gz")
        RATIO=$(echo "scale=0; 100 - ($GZ_SIZE * 100 / $UN_SIZE)" | bc)
        UN_MB=$(echo "scale=1; $UN_SIZE / 1048576" | bc)
        GZ_MB=$(echo "scale=1; $GZ_SIZE / 1048576" | bc)
        echo "  $(basename "$uncompressed"): ${UN_MB}MB -> ${GZ_MB}MB (${RATIO}% reduction)"
    fi
done

echo ""
info "Build complete!"
info "Binaries are in: $RELEASE_DIR"
echo ""
info "To test locally: $RELEASE_DIR/agent-relay --version"
