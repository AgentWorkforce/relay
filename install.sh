#!/bin/bash
set -e

# Agent Relay Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
#
# Options (set as environment variables):
#   AGENT_RELAY_VERSION              - Specific version to install (default: latest)
#   AGENT_RELAY_BIN_DIR              - Binary directory (default: ~/.local/bin)
#   AGENT_RELAY_TELEMETRY_DISABLED   - Disable anonymous install telemetry (default: false)

REPO="AgentWorkforce/relay"
VERSION="${AGENT_RELAY_VERSION:-latest}"
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
success() { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1"; exit 1; }
step() { echo -e "\n${CYAN}${BOLD}$1${NC}"; }

# Telemetry
POSTHOG_API_KEY="phc_2uDu01GtnLABJpVkWw4ri1OgScLU90aEmXmDjufGdqr"
POSTHOG_HOST="https://us.i.posthog.com"
INSTALL_ID=""

telemetry_enabled() {
    if [ "${AGENT_RELAY_TELEMETRY_DISABLED:-}" = "1" ] || [ "${AGENT_RELAY_TELEMETRY_DISABLED:-}" = "true" ]; then
        return 1
    fi
    if [ "${DO_NOT_TRACK:-}" = "1" ]; then
        return 1
    fi
    return 0
}

generate_install_id() {
    if command -v uuidgen &> /dev/null; then
        INSTALL_ID=$(uuidgen | tr '[:upper:]' '[:lower:]')
    elif [ -f /proc/sys/kernel/random/uuid ]; then
        INSTALL_ID=$(cat /proc/sys/kernel/random/uuid)
    else
        INSTALL_ID="install-$(date +%s)-$RANDOM"
    fi
}

track_event() {
    if ! telemetry_enabled; then return 0; fi
    local event="$1"
    local extra_props="${2:-}"
    (curl -sS --max-time 5 -X POST "${POSTHOG_HOST}/capture/" \
        -H "Content-Type: application/json" \
        -d "{
            \"api_key\": \"${POSTHOG_API_KEY}\",
            \"event\": \"${event}\",
            \"distinct_id\": \"${INSTALL_ID}\",
            \"properties\": {
                \"platform\": \"${PLATFORM:-unknown}\",
                \"version\": \"${VERSION:-unknown}\",
                \"os\": \"${OS:-unknown}\",
                \"arch\": \"${ARCH:-unknown}\"${extra_props}
            }
        }" > /dev/null 2>&1 &) || true
}

detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Linux*)  OS="linux" ;;
        Darwin*) OS="darwin" ;;
        *)       error "Unsupported OS: $OS" ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  ARCH="x86_64" ;;
        arm64|aarch64) ARCH="arm64" ;;
        *)             error "Unsupported architecture: $ARCH" ;;
    esac

    PLATFORM="${OS}-${ARCH}"
    info "Detected platform: $PLATFORM"
}

get_latest_version() {
    if [ "$VERSION" = "latest" ]; then
        local auth_header=""
        if [ -n "${GITHUB_TOKEN:-}" ]; then
            auth_header="-H \"Authorization: token $GITHUB_TOKEN\""
        fi
        VERSION=$(eval curl -fsSL $auth_header "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        if [ -z "$VERSION" ]; then
            error "Failed to fetch latest version"
        fi
    fi
    VERSION="${VERSION#v}"
    info "Installing version: $VERSION"
}

download_binary() {
    step "Downloading agent-relay binary..."

    # Map platform to release asset name
    local asset_name=""
    case "$PLATFORM" in
        linux-x86_64)  asset_name="agent-relay-linux-x86_64" ;;
        darwin-x86_64) asset_name="agent-relay-macos-x86_64" ;;
        darwin-arm64)  asset_name="agent-relay-macos-arm64" ;;
        *)             error "No prebuilt binary for $PLATFORM" ;;
    esac

    local download_url="https://github.com/$REPO/releases/download/v${VERSION}/${asset_name}.tar.gz"
    local target_path="$BIN_DIR/agent-relay"
    local temp_file="/tmp/agent-relay-download-$$"

    mkdir -p "$BIN_DIR"
    trap 'rm -f "${temp_file}.tar.gz" "${temp_file}"' EXIT

    # Download tarball
    if curl -fsSL "$download_url" -o "${temp_file}.tar.gz" 2>/dev/null; then
        tar -xzf "${temp_file}.tar.gz" -C /tmp "$asset_name"
        mv "/tmp/${asset_name}" "$target_path"
        chmod +x "$target_path"
        rm -f "${temp_file}.tar.gz"

        if "$target_path" --help &>/dev/null; then
            success "Downloaded agent-relay binary"
            trap - EXIT
            return 0
        else
            warn "Binary failed verification"
            rm -f "$target_path"
        fi
    fi

    trap - EXIT
    error "Failed to download binary for $PLATFORM"
}

setup_path() {
    if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
        warn "Add to your PATH:"
        echo ""
        echo "  export PATH=\"\$PATH:$BIN_DIR\""
        echo ""
        echo "  # Or add to your shell profile:"
        echo "  echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> ~/.bashrc  # for bash"
        echo "  echo 'export PATH=\"\$PATH:$BIN_DIR\"' >> ~/.zshrc   # for zsh"
        echo ""
    fi
}

verify_installation() {
    step "Verifying installation..."

    if command -v agent-relay &> /dev/null; then
        success "agent-relay installed successfully!"
    elif [ -x "$BIN_DIR/agent-relay" ]; then
        success "agent-relay installed to $BIN_DIR"
        setup_path
    else
        error "Installation verification failed"
    fi
}

print_usage() {
    echo ""
    echo -e "${BOLD}Quick Start:${NC}"
    echo ""
    echo "  # Install the SDK"
    echo "  npm install @agent-relay/sdk"
    echo ""
    echo "  # Or use the CLI directly"
    echo "  agent-relay init"
    echo ""
    echo -e "${BOLD}Documentation:${NC} https://docs.agent-relay.com"
    echo ""
}

main() {
    echo ""
    echo -e "${YELLOW}${BOLD}Agent Relay${NC} Installer"
    echo ""

    generate_install_id
    detect_platform
    get_latest_version

    track_event "install_started"

    download_binary
    verify_installation
    print_usage

    track_event "install_completed"
}

case "${1:-}" in
    --help|-h)
        echo "Agent Relay Installer"
        echo ""
        echo "Usage: curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash"
        echo ""
        echo "Environment variables:"
        echo "  AGENT_RELAY_VERSION              Specific version (default: latest)"
        echo "  AGENT_RELAY_BIN_DIR              Binary directory (default: ~/.local/bin)"
        echo "  AGENT_RELAY_TELEMETRY_DISABLED   Disable telemetry (default: false)"
        exit 0
        ;;
esac

main "$@"
