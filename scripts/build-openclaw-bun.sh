#!/bin/bash
set -e

# Build standalone relay-openclaw binaries using bun compile
# Creates cross-platform executables that don't require Node.js or Bun to run

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
PKG_DIR="$ROOT_DIR/packages/openclaw"
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

# Get version from packages/openclaw/package.json
VERSION=$(node -p "require('./packages/openclaw/package.json').version")
info "Building relay-openclaw version: $VERSION"

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

# Build TypeScript first
info "Building TypeScript..."
cd "$PKG_DIR" && npm run build
cd "$ROOT_DIR"

# Targets for cross-compilation
TARGETS=(
    "bun-darwin-arm64:darwin-arm64"
    "bun-darwin-x64:darwin-x64"
    "bun-linux-x64:linux-x64"
    "bun-linux-arm64:linux-arm64"
)

# Build for each target
for target_spec in "${TARGETS[@]}"; do
    IFS=':' read -r target suffix <<< "$target_spec"
    output="$RELEASE_DIR/relay-openclaw-$suffix"

    info "Building for $target..."

    if bun build \
        --compile \
        --minify \
        --target="$target" \
        --define="process.env.RELAY_OPENCLAW_VERSION=\"$VERSION\"" \
        --external dockerode \
        "$PKG_DIR/dist/cli.js" \
        --outfile "$output" 2>&1; then

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
CURRENT_OUTPUT="$RELEASE_DIR/relay-openclaw"
if bun build \
    --compile \
    --minify \
    --define="process.env.RELAY_OPENCLAW_VERSION=\"$VERSION\"" \
    --external dockerode \
    "$PKG_DIR/dist/cli.js" \
    --outfile "$CURRENT_OUTPUT" 2>&1; then

    SIZE=$(du -h "$CURRENT_OUTPUT" | cut -f1)
    success "Built $CURRENT_OUTPUT ($SIZE)"

    # Test the binary
    if "$CURRENT_OUTPUT" --version 2>/dev/null; then
        success "Binary works: $("$CURRENT_OUTPUT" --version)"
    fi
else
    warn "Failed to build for current platform"
fi

# Generate SHA256SUMS
info "Generating SHA256SUMS..."
cd "$RELEASE_DIR"
sha256sum relay-openclaw-*.gz > SHA256SUMS 2>/dev/null || shasum -a 256 relay-openclaw-*.gz > SHA256SUMS 2>/dev/null
success "SHA256SUMS generated"
cd "$ROOT_DIR"

# List all built binaries
echo ""
info "Built binaries:"
ls -lh "$RELEASE_DIR"/relay-openclaw* 2>/dev/null || echo "No binaries found"

# Verify at least one binary was built
BINARY_COUNT=$(ls "$RELEASE_DIR"/relay-openclaw-* 2>/dev/null | grep -v '.gz$' | wc -l | tr -d ' ')
if [ "$BINARY_COUNT" -eq 0 ]; then
    warn "No binaries were built!"
    exit 1
fi

# Print compression summary
echo ""
info "Compression summary:"
for uncompressed in "$RELEASE_DIR"/relay-openclaw-*; do
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
info "To test locally: $RELEASE_DIR/relay-openclaw --version"
