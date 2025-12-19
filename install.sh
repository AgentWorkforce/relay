#!/bin/bash
set -e

# Agent Relay Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/khaliqgant/agent-relay/main/install.sh | bash

REPO="khaliqgant/agent-relay"
INSTALL_DIR="${AGENT_RELAY_INSTALL_DIR:-$HOME/.agent-relay}"
BIN_DIR="${AGENT_RELAY_BIN_DIR:-$HOME/.local/bin}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}[info]${NC} $1"; }
success() { echo -e "${GREEN}[success]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
error() { echo -e "${RED}[error]${NC} $1"; exit 1; }

check_requirements() {
    if ! command -v node &> /dev/null; then
        error "Node.js is required. Please install Node.js 20+ first."
    fi

    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        error "Node.js 20+ required. Found: $(node -v)"
    fi
    info "Node.js $(node -v) detected"
}

install_source() {
    info "Installing from source..."
    mkdir -p "$INSTALL_DIR" "$BIN_DIR"

    if command -v git &> /dev/null; then
        [ -d "$INSTALL_DIR/.git" ] && cd "$INSTALL_DIR" && git pull || git clone "https://github.com/$REPO.git" "$INSTALL_DIR"
    else
        curl -fsSL "https://github.com/$REPO/archive/main.tar.gz" | tar -xz -C "$INSTALL_DIR" --strip-components=1
    fi

    cd "$INSTALL_DIR" && npm ci && npm run build
    ln -sf "$INSTALL_DIR/dist/cli/index.js" "$BIN_DIR/agent-relay"
    chmod +x "$BIN_DIR/agent-relay"

    [[ ":$PATH:" != *":$BIN_DIR:"* ]] && warn "Add to PATH: export PATH=\"\$PATH:$BIN_DIR\""
    success "Installed to $INSTALL_DIR"
}

main() {
    echo -e "\n${YELLOW}⚡ Agent Relay${NC} Installer\n"
    check_requirements
    install_source
    echo -e "\nQuick Start:"
    echo -e "  # Start the daemon"
    echo -e "  agent-relay start -f"
    echo -e ""
    echo -e "  # Wrap an agent (tmux mode is default)"
    echo -e "  agent-relay wrap -n MyAgent \"claude\""
    echo -e ""
    echo -e "  # Open the dashboard"
    echo -e "  agent-relay dashboard"
    echo -e ""
}

main "$@"
