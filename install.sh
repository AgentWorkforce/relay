#!/bin/bash
set -e

# Agent Relay Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
#
# Options (set as environment variables):
#   AGENT_RELAY_VERSION              - Specific version to install (default: latest)
#   AGENT_RELAY_INSTALL_DIR          - Installation directory (default: ~/.agent-relay)
#   AGENT_RELAY_BIN_DIR              - Binary directory (default: ~/.local/bin)
#   AGENT_RELAY_NO_DASHBOARD         - Skip dashboard installation (default: false)
#   AGENT_RELAY_TELEMETRY_DISABLED   - Disable anonymous install telemetry (default: false)

REPO_RELAY="AgentWorkforce/relay"
REPO_DASHBOARD="AgentWorkforce/relay-dashboard"
VERSION="${AGENT_RELAY_VERSION:-latest}"
INSTALL_DIR="${AGENT_RELAY_INSTALL_DIR:-$HOME/.agent-relay}"
BIN_DIR="${AGENT_RELAY_BIN_DIR:-$HOME/.local/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info() { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() {
    echo -e "${RED}[error]${NC} $1"
    # Track failure if telemetry is initialized
    if [ -n "$INSTALL_ID" ]; then
        # Escape special characters for JSON (newlines, quotes, backslashes)
        local escaped_error
        escaped_error=$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' ')
        track_event "install_failed" ", \"error\": \"$escaped_error\""
    fi
    exit 1
}
step() { echo -e "\n${CYAN}${BOLD}$1${NC}"; }

# Telemetry (respects AGENT_RELAY_TELEMETRY_DISABLED)
POSTHOG_API_KEY="phc_2uDu01GtnLABJpVkWw4ri1OgScLU90aEmXmDjufGdqr"
POSTHOG_HOST="https://us.i.posthog.com"
INSTALL_ID=""
INSTALL_METHOD=""

telemetry_enabled() {
    # Respect opt-out
    if [ "${AGENT_RELAY_TELEMETRY_DISABLED:-}" = "1" ] || [ "${AGENT_RELAY_TELEMETRY_DISABLED:-}" = "true" ]; then
        return 1
    fi
    # Also check DO_NOT_TRACK (standard env var)
    if [ "${DO_NOT_TRACK:-}" = "1" ]; then
        return 1
    fi
    return 0
}

generate_install_id() {
    # Generate a random ID for this install session
    if command -v uuidgen &> /dev/null; then
        INSTALL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    elif [ -f /proc/sys/kernel/random/uuid ]; then
        INSTALL_ID=$(cat /proc/sys/kernel/random/uuid)
    else
        # Fallback: use timestamp + random
        INSTALL_ID="install-$(date +%s)-$RANDOM"
    fi
}

track_event() {
    if ! telemetry_enabled; then
        return 0
    fi

    local event="$1"
    local extra_props="${2:-}"

    # Send async (don't block install)
    (curl -sS --max-time 5 -X POST "${POSTHOG_HOST}/capture/" \
        -H "Content-Type: application/json" \
        -d "{
            \"api_key\": \"${POSTHOG_API_KEY}\",
            \"event\": \"${event}\",
            \"distinct_id\": \"${INSTALL_ID}\",
            \"properties\": {
                \"platform\": \"${PLATFORM:-unknown}\",
                \"version\": \"${VERSION:-unknown}\",
                \"method\": \"${INSTALL_METHOD:-unknown}\",
                \"os\": \"${OS:-unknown}\",
                \"arch\": \"${ARCH:-unknown}\",
                \"has_node\": \"${HAS_NODE:-false}\"${extra_props}
            }
        }" > /dev/null 2>&1 &) || true
}

# Detect OS and architecture
detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux*)  OS="linux" ;;
        Darwin*) OS="darwin" ;;
        *)       error "Unsupported OS: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             error "Unsupported architecture: $ARCH" ;;
    esac

    PLATFORM="${OS}-${ARCH}"
    info "Detected platform: $PLATFORM"
}

# Get latest version from GitHub
get_latest_version() {
    if [ "$VERSION" = "latest" ]; then
        VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO_RELAY/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        if [ -z "$VERSION" ]; then
            error "Failed to fetch latest version"
        fi
    fi
    # Remove 'v' prefix if present
    VERSION="${VERSION#v}"
    info "Installing version: $VERSION"
}

# Check if Node.js is available
check_node() {
    if command -v node &> /dev/null; then
        NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
        if [ "$NODE_VERSION" -ge 18 ]; then
            HAS_NODE=true
            info "Node.js $(node -v) detected"
            return 0
        fi
    fi
    HAS_NODE=false
    return 1
}

# Download relay-pty binary
download_relay_pty() {
    step "Downloading relay-pty binary..."

    local binary_name="relay-pty-${PLATFORM}"
    local download_url="https://github.com/$REPO_RELAY/releases/download/v${VERSION}/${binary_name}"
    local target_path="$INSTALL_DIR/bin/relay-pty"

    mkdir -p "$INSTALL_DIR/bin"

    # Try to download - curl -f will fail on 404
    if curl -fsSL "$download_url" -o "$target_path" 2>/dev/null; then
        chmod +x "$target_path"
        # Verify binary works
        if "$target_path" --help &>/dev/null; then
            success "Downloaded relay-pty binary"
            return 0
        else
            warn "relay-pty binary failed verification"
            rm -f "$target_path"
            return 1
        fi
    else
        warn "No prebuilt relay-pty binary for $PLATFORM"
        return 1
    fi
}

# Download standalone dashboard-server binary
download_dashboard_binary() {
    if [ "${AGENT_RELAY_NO_DASHBOARD}" = "true" ]; then
        info "Skipping dashboard installation (AGENT_RELAY_NO_DASHBOARD=true)"
        return 0
    fi

    step "Downloading dashboard-server binary..."

    local binary_name="relay-dashboard-server-${PLATFORM}"
    local compressed_url="https://github.com/$REPO_DASHBOARD/releases/latest/download/${binary_name}.gz"
    local uncompressed_url="https://github.com/$REPO_DASHBOARD/releases/latest/download/${binary_name}"
    local target_path="$BIN_DIR/relay-dashboard-server"
    local temp_file="/tmp/dashboard-download-$$"

    mkdir -p "$BIN_DIR"

    # Setup cleanup trap for temp files
    trap 'rm -f "${temp_file}.gz" "${temp_file}"' EXIT

    # Try compressed binary first (faster download)
    if has_command gunzip; then
        info "Trying compressed dashboard binary..."

        if curl -fsSL "$compressed_url" -o "${temp_file}.gz" 2>/dev/null; then
            # Check if we got a valid gzip file
            local is_gzip=false
            if has_command file; then
                file "${temp_file}.gz" 2>/dev/null | grep -q "gzip" && is_gzip=true
            else
                head -c 2 "${temp_file}.gz" 2>/dev/null | od -An -tx1 | grep -q "1f 8b" && is_gzip=true
            fi

            if [ "$is_gzip" = true ]; then
                if gunzip -c "${temp_file}.gz" > "$target_path" 2>/dev/null; then
                    rm -f "${temp_file}.gz"
                    chmod +x "$target_path"

                    if "$target_path" --version &>/dev/null; then
                        success "Downloaded standalone dashboard-server binary"
                        trap - EXIT
                        return 0
                    else
                        warn "Dashboard binary failed verification, trying uncompressed..."
                        rm -f "$target_path"
                    fi
                else
                    rm -f "${temp_file}.gz" "$target_path"
                fi
            else
                rm -f "${temp_file}.gz"
            fi
        fi
    fi

    # Fall back to uncompressed binary
    info "Trying uncompressed dashboard binary..."

    if curl -fsSL "$uncompressed_url" -o "$target_path" 2>/dev/null; then
        local file_size
        file_size=$(stat -f%z "$target_path" 2>/dev/null || stat -c%s "$target_path" 2>/dev/null || echo "0")

        if [ "$file_size" -gt 1000000 ]; then
            chmod +x "$target_path"

            if "$target_path" --version &>/dev/null; then
                success "Downloaded standalone dashboard-server binary"
                trap - EXIT
                return 0
            else
                warn "Dashboard binary failed verification"
                rm -f "$target_path"
            fi
        else
            rm -f "$target_path"
        fi
    fi

    trap - EXIT
    info "No standalone dashboard binary available for $PLATFORM"
    return 1
}

# Download dashboard UI files (required for standalone binary)
download_dashboard_ui() {
    if [ "${AGENT_RELAY_NO_DASHBOARD}" = "true" ]; then
        return 0
    fi

    step "Downloading dashboard UI files..."

    local ui_url="https://github.com/$REPO_DASHBOARD/releases/latest/download/dashboard-ui.tar.gz"
    local target_dir="$HOME/.relay/dashboard"
    local temp_file="/tmp/dashboard-ui-$$"

    mkdir -p "$target_dir"

    # Setup cleanup trap for temp files
    trap 'rm -f "${temp_file}.tar.gz"' EXIT

    if curl -fsSL "$ui_url" -o "${temp_file}.tar.gz" 2>/dev/null; then
        # Check if we got a valid gzip file
        local is_gzip=false
        if has_command file; then
            file "${temp_file}.tar.gz" 2>/dev/null | grep -q "gzip" && is_gzip=true
        else
            head -c 2 "${temp_file}.tar.gz" 2>/dev/null | od -An -tx1 | grep -q "1f 8b" && is_gzip=true
        fi

        if [ "$is_gzip" = true ]; then
            # Remove old UI files if they exist
            rm -rf "$target_dir/out"

            # Extract to target directory
            if tar -xzf "${temp_file}.tar.gz" -C "$target_dir" 2>/dev/null; then
                rm -f "${temp_file}.tar.gz"
                trap - EXIT

                # Verify extraction
                if [ -f "$target_dir/out/index.html" ]; then
                    success "Downloaded dashboard UI files"
                    return 0
                else
                    warn "Dashboard UI extraction incomplete"
                    return 1
                fi
            else
                warn "Failed to extract dashboard UI"
                rm -f "${temp_file}.tar.gz"
            fi
        else
            rm -f "${temp_file}.tar.gz"
        fi
    fi

    trap - EXIT
    info "Dashboard UI files not available (dashboard API will still work)"
    return 1
}

# Check if a command exists
has_command() {
    command -v "$1" &> /dev/null
}

# Download with progress indicator
download_with_progress() {
    local url="$1"
    local output="$2"

    if [ -t 1 ]; then
        # TTY available - show progress bar
        curl -fSL --progress-bar "$url" -o "$output"
    else
        # No TTY - silent download
        curl -fsSL "$url" -o "$output"
    fi
}

# Download standalone agent-relay binary (no Node.js required)
download_standalone_binary() {
    step "Checking for standalone binary..."

    local binary_name="agent-relay-${PLATFORM}"
    local compressed_url="https://github.com/$REPO_RELAY/releases/download/v${VERSION}/${binary_name}.gz"
    local uncompressed_url="https://github.com/$REPO_RELAY/releases/download/v${VERSION}/${binary_name}"
    local target_path="$BIN_DIR/agent-relay"
    local temp_file="/tmp/agent-relay-download-$$"

    mkdir -p "$BIN_DIR"

    # Setup cleanup trap for temp files
    trap 'rm -f "${temp_file}.gz" "${temp_file}"' EXIT

    # Try compressed binary first (faster download, ~60-70% smaller)
    # Only if gunzip is available
    if has_command gunzip; then
        if curl -fsSL "$compressed_url" -o "${temp_file}.gz" 2>/dev/null; then
            # Check if we got a valid gzip file (not an error page)
            # Use file command if available, otherwise check magic bytes
            local is_gzip=false
            if has_command file; then
                file "${temp_file}.gz" 2>/dev/null | grep -q "gzip" && is_gzip=true
            else
                # Check gzip magic bytes (1f 8b)
                head -c 2 "${temp_file}.gz" 2>/dev/null | od -An -tx1 | grep -q "1f 8b" && is_gzip=true
            fi

            if [ "$is_gzip" = true ]; then
                # Decompress
                if gunzip -c "${temp_file}.gz" > "$target_path" 2>/dev/null; then
                    rm -f "${temp_file}.gz"
                    chmod +x "$target_path"

                    # Verify the binary works
                    if "$target_path" --version &>/dev/null; then
                        success "Downloaded standalone agent-relay binary"
                        trap - EXIT  # Clear trap
                        return 0
                    else
                        warn "Downloaded binary failed verification, trying uncompressed..."
                        rm -f "$target_path"
                    fi
                else
                    warn "Decompression failed, trying uncompressed binary..."
                    rm -f "${temp_file}.gz" "$target_path"
                fi
            else
                info "Compressed binary not available, trying uncompressed..."
                rm -f "${temp_file}.gz"
            fi
        else
            info "Compressed binary not available, trying uncompressed..."
            rm -f "${temp_file}.gz"
        fi
    else
        info "gunzip not available, trying uncompressed binary..."
    fi

    # Fall back to uncompressed binary
    info "Downloading standalone binary..."

    if curl -fsSL "$uncompressed_url" -o "$target_path" 2>/dev/null; then
        # Check file size - error pages are typically small (<1MB)
        local file_size
        file_size=$(stat -f%z "$target_path" 2>/dev/null || stat -c%s "$target_path" 2>/dev/null || echo "0")

        if [ "$file_size" -gt 1000000 ]; then
            chmod +x "$target_path"

            # Verify the binary works
            if "$target_path" --version &>/dev/null; then
                success "Downloaded standalone agent-relay binary (no Node.js required!)"
                trap - EXIT  # Clear trap
                return 0
            else
                warn "Downloaded binary failed verification"
                rm -f "$target_path"
            fi
        else
            info "Uncompressed binary not available (file too small: ${file_size} bytes)"
            rm -f "$target_path"
        fi
    fi

    trap - EXIT  # Clear trap
    info "No standalone binary available for $PLATFORM, falling back to npm"
    return 1
}

# Install via npm (fallback or primary method)
install_via_npm() {
    step "Installing via npm..."

    if ! check_node; then
        error "Node.js 18+ is required for npm installation. Please install Node.js first:

  macOS:   brew install node
  Linux:   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs

Or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
    fi

    # Install agent-relay globally
    info "Installing agent-relay..."

    # Try installation - capture output and exit code separately
    local npm_log="/tmp/npm-install-$$.log"
    local npm_exit=0

    npm install -g agent-relay@"$VERSION" > "$npm_log" 2>&1 || npm_exit=$?

    if [ $npm_exit -ne 0 ]; then
        # First attempt failed, try without version
        npm install -g agent-relay >> "$npm_log" 2>&1 || npm_exit=$?
    fi

    if [ $npm_exit -ne 0 ]; then
        # Show the error output
        cat "$npm_log"

        # Check if it's a native module compilation failure
        if grep -q "Unable to detect compiler type\|node-gyp\|prebuild-install\|gyp ERR" "$npm_log" 2>/dev/null; then
            warn "Native module compilation failed. This is usually due to missing build tools."
            echo ""
            echo "Please install build tools and try again:"
            echo ""
            if [ "$OS" = "darwin" ]; then
                echo "  xcode-select --install"
            elif command -v apt-get &> /dev/null; then
                echo "  sudo apt-get install build-essential python3"
            elif command -v dnf &> /dev/null; then
                echo "  sudo dnf install gcc gcc-c++ make python3"
            elif command -v apk &> /dev/null; then
                echo "  apk add build-base python3"
            else
                echo "  Install gcc, g++, make, and python3"
            fi
            echo ""
            echo "Retrying installation with optional native modules disabled..."
            if npm install -g --ignore-scripts agent-relay@"$VERSION" 2>/dev/null || npm install -g --ignore-scripts agent-relay 2>/dev/null; then
                warn "Installed with native module compilation skipped"
                rm -f "$npm_log"
            else
                rm -f "$npm_log"
                error "Installation failed. Please install build tools and try again."
            fi
        else
            rm -f "$npm_log"
            error "npm installation failed. Please check the error messages above."
        fi
    else
        rm -f "$npm_log"
    fi

    # Install dashboard if not skipped
    if [ "${AGENT_RELAY_NO_DASHBOARD}" != "true" ]; then
        # Try binary first, fall back to npm
        if download_dashboard_binary; then
            # Binary downloaded - also need UI files since they're not embedded
            download_dashboard_ui || true
        else
            info "Installing dashboard via npm..."
            npm install -g @agent-relay/dashboard-server 2>/dev/null || true
        fi
    fi

    success "Installed via npm"
}

# Install from source (for development or when npm fails)
install_from_source() {
    step "Installing from source..."

    if ! check_node; then
        error "Node.js 18+ is required for source installation"
    fi

    mkdir -p "$INSTALL_DIR"

    if command -v git &> /dev/null; then
        if [ -d "$INSTALL_DIR/.git" ]; then
            info "Updating existing installation..."
            cd "$INSTALL_DIR" && git fetch && git checkout "v$VERSION" 2>/dev/null || git pull
        else
            info "Cloning repository..."
            rm -rf "$INSTALL_DIR"
            git clone --depth 1 --branch "v$VERSION" "https://github.com/$REPO_RELAY.git" "$INSTALL_DIR" 2>/dev/null || \
            git clone --depth 1 "https://github.com/$REPO_RELAY.git" "$INSTALL_DIR"
        fi
    else
        info "Downloading source tarball..."
        curl -fsSL "https://github.com/$REPO_RELAY/archive/v$VERSION.tar.gz" -o /tmp/relay.tar.gz 2>/dev/null || \
        curl -fsSL "https://github.com/$REPO_RELAY/archive/main.tar.gz" -o /tmp/relay.tar.gz
        rm -rf "$INSTALL_DIR"
        mkdir -p "$INSTALL_DIR"
        tar -xzf /tmp/relay.tar.gz -C "$INSTALL_DIR" --strip-components=1
        rm /tmp/relay.tar.gz
    fi

    cd "$INSTALL_DIR"

    # Install dependencies and build
    info "Installing dependencies..."
    if command -v pnpm &> /dev/null; then
        pnpm install --frozen-lockfile 2>/dev/null || pnpm install
    else
        npm ci 2>/dev/null || npm install
    fi

    info "Building..."
    npm run build

    # Create wrapper script
    mkdir -p "$BIN_DIR"
    rm -f "$BIN_DIR/agent-relay"

    cat > "$BIN_DIR/agent-relay" << WRAPPER
#!/usr/bin/env bash
cd "$INSTALL_DIR" && exec node dist/src/cli/index.js "\$@"
WRAPPER
    chmod +x "$BIN_DIR/agent-relay"

    success "Installed from source"
}

# Setup PATH
setup_path() {
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        warn "Add to your PATH by running:"
        echo ""
        echo "  export PATH=\"\$PATH:$BIN_DIR\""
        echo ""
        echo "  # Or add to your shell profile:"
        echo "  echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> ~/.bashrc  # for bash"
        echo "  echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> ~/.zshrc   # for zsh"
        echo ""
    fi
}

# Verify installation
verify_installation() {
    step "Verifying installation..."

    # Check if agent-relay is available
    if command -v agent-relay &> /dev/null; then
        local installed_version=$(agent-relay --version 2>/dev/null || echo "unknown")
        success "agent-relay $installed_version installed successfully!"
    elif [ -x "$BIN_DIR/agent-relay" ]; then
        local installed_version=$("$BIN_DIR/agent-relay" --version 2>/dev/null || echo "unknown")
        success "agent-relay $installed_version installed to $BIN_DIR"
        setup_path
    else
        error "Installation verification failed"
    fi
}

# Print usage instructions
print_usage() {
    echo ""
    echo -e "${BOLD}Quick Start:${NC}"
    echo ""
    echo "  # Start the daemon with dashboard"
    echo "  agent-relay up --dashboard"
    echo ""
    echo "  # Check status"
    echo "  agent-relay status"
    echo ""
    echo "  # Open dashboard"
    echo "  open http://localhost:3888"
    echo ""
    echo "  # Stop daemon"
    echo "  agent-relay down"
    echo ""
    echo -e "${BOLD}Documentation:${NC} https://github.com/AgentWorkforce/relay"
    echo ""
}

# Main installation flow
main() {
    echo ""
    echo -e "${YELLOW}${BOLD}⚡ Agent Relay${NC} Installer"
    echo ""

    # Initialize telemetry
    generate_install_id

    detect_platform
    get_latest_version

    # Track install started
    track_event "install_started"

    # Try installation methods in order of preference:
    # 1. Standalone binary (no dependencies required!)
    # 2. npm (if Node.js available)
    # 3. source (fallback)

    # Try standalone binary first - works without Node.js
    if download_standalone_binary; then
        INSTALL_METHOD="binary"
        # Also download relay-pty binary if available
        download_relay_pty || true
        # Download dashboard-server binary if available
        download_dashboard_binary || true
        # Download dashboard UI files (required for standalone binary to serve the UI)
        download_dashboard_ui || true
        verify_installation && print_usage && track_event "install_completed" && exit 0
    fi

    # Fall back to npm if Node.js is available
    if check_node; then
        INSTALL_METHOD="npm"
        install_via_npm && verify_installation && print_usage && track_event "install_completed" && exit 0
        warn "npm installation failed, trying source..."
        INSTALL_METHOD="source"
        install_from_source && verify_installation && print_usage && track_event "install_completed" && exit 0
    else
        echo ""
        warn "No standalone binary available and Node.js not found."
        echo ""
        echo -e "${BOLD}Options:${NC}"
        echo ""
        echo "  1. Wait for standalone binaries (coming soon for your platform)"
        echo ""
        echo "  2. Install Node.js 18+ using one of these methods:"
        echo ""
        echo "     # Using nvm (recommended - works on macOS and Linux)"
        echo "     curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
        echo "     source ~/.bashrc  # or ~/.zshrc"
        echo "     nvm install 20"
        echo ""

        if [ "$OS" = "darwin" ]; then
            echo "     # macOS - Official installer"
            echo "     https://nodejs.org/en/download"
            echo ""
            echo "     # macOS - via Homebrew (if installed)"
            echo "     brew install node"
        elif [ "$OS" = "linux" ]; then
            # Detect package manager
            if command -v apt-get &> /dev/null; then
                echo "     # Ubuntu/Debian"
                echo "     curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
                echo "     sudo apt-get install -y nodejs"
            elif command -v dnf &> /dev/null; then
                echo "     # Fedora/RHEL"
                echo "     sudo dnf install nodejs npm"
            elif command -v pacman &> /dev/null; then
                echo "     # Arch Linux"
                echo "     sudo pacman -S nodejs npm"
            elif command -v apk &> /dev/null; then
                echo "     # Alpine Linux"
                echo "     apk add nodejs npm"
            else
                echo "     # Download from nodejs.org"
                echo "     https://nodejs.org/en/download"
            fi
        fi

        echo ""
        echo "Then re-run this installer."
        track_event "install_failed" ", \"error\": \"no_nodejs_or_binary\""
        exit 1
    fi
}

# Handle command line arguments
case "${1:-}" in
    --help|-h)
        echo "Agent Relay Installer"
        echo ""
        echo "Usage: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash"
        echo ""
        echo "Environment variables:"
        echo "  AGENT_RELAY_VERSION              Specific version to install (default: latest)"
        echo "  AGENT_RELAY_INSTALL_DIR          Installation directory (default: ~/.agent-relay)"
        echo "  AGENT_RELAY_BIN_DIR              Binary directory (default: ~/.local/bin)"
        echo "  AGENT_RELAY_NO_DASHBOARD         Skip dashboard installation (default: false)"
        echo "  AGENT_RELAY_TELEMETRY_DISABLED   Disable anonymous install telemetry (default: false)"
        echo ""
        echo "Telemetry: This installer collects anonymous usage data to improve the product."
        echo "           Set AGENT_RELAY_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1 to opt out."
        exit 0
        ;;
    --version|-v)
        echo "Installer for Agent Relay"
        echo "Repository: https://github.com/AgentWorkforce/relay"
        exit 0
        ;;
esac

main "$@"
