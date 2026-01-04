#!/bin/bash
# Mock CLI for testing OAuth flow prompt handling
# Usage: ./mock-cli.sh <provider> [delay]
#
# This script simulates the interactive prompts of various AI CLI tools
# for testing the onboarding OAuth flow without actual CLI binaries.
#
# When installed as symlinks (e.g., /usr/local/bin/claude -> mock-cli.sh),
# it auto-detects the provider from the command name.

# Detect provider from how the script was called
SCRIPT_NAME=$(basename "$0")

case "$SCRIPT_NAME" in
  claude) PROVIDER="claude" ;;
  codex) PROVIDER="codex" ;;
  gemini) PROVIDER="gemini" ;;
  opencode) PROVIDER="opencode" ;;
  droid) PROVIDER="droid" ;;
  mock-cli.sh|mock-cli|mock-cli-impl.sh)
    PROVIDER="${1:-claude}"
    shift 2>/dev/null || true
    ;;
  *) PROVIDER="${1:-claude}" ;;
esac

# Handle 'login' subcommand for codex
if [ "$PROVIDER" = "codex" ] && [ "$1" = "login" ]; then
  shift
fi

DELAY="${1:-0.3}"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

case "$PROVIDER" in
  claude|anthropic)
    echo -e "${BLUE}Claude Code CLI${NC}"
    echo ""
    sleep "$DELAY"

    # Dark mode prompt
    echo -e "Would you like to use ${YELLOW}dark mode${NC}? (y/n) "
    read -r -n 1 response 2>/dev/null || true
    echo ""
    sleep "$DELAY"

    # Auth method prompt
    echo -e "How would you like to authenticate?"
    echo "  1. Use Claude ${YELLOW}subscription${NC} (recommended)"
    echo "  2. Use ${YELLOW}API key${NC}"
    echo -n "Choice (1-2): "
    read -r -n 1 response 2>/dev/null || true
    echo ""
    sleep "$DELAY"

    # Trust directory prompt
    echo -e "Do you ${YELLOW}trust this directory${NC}? [y/N] "
    read -r -n 1 response 2>/dev/null || true
    echo ""
    sleep "$DELAY"

    # Auth URL
    echo ""
    echo -e "Please visit the following URL to authenticate:"
    echo -e "${GREEN}https://console.anthropic.com/oauth/authorize?client_id=mock-test-123&state=abc${NC}"
    echo ""
    echo "Waiting for authentication..."

    # Wait for completion signal (or timeout)
    read -r -t 30 2>/dev/null || true
    echo -e "${GREEN}Authentication successful!${NC}"
    ;;

  codex|openai)
    echo -e "${BLUE}Codex CLI${NC}"
    echo ""
    sleep "$DELAY"

    # Trust directory prompt
    echo -e "Do you ${YELLOW}trust this workspace${NC}? [y/N] "
    read -r -n 1 response 2>/dev/null || true
    echo ""
    sleep "$DELAY"

    # Auth URL
    echo ""
    echo -e "Open this URL to log in:"
    echo -e "${GREEN}https://auth.openai.com/authorize?client_id=mock-test-456&state=def${NC}"
    echo ""
    echo "Waiting..."

    read -r -t 30 2>/dev/null || true
    echo -e "${GREEN}Logged in successfully${NC}"
    ;;

  gemini|google)
    echo -e "${BLUE}Gemini CLI${NC}"
    echo ""
    sleep "$DELAY"

    # Auth URL
    echo -e "Authenticate at:"
    echo -e "${GREEN}https://accounts.google.com/o/oauth2/v2/auth?client_id=mock-test-789${NC}"
    echo ""

    read -r -t 30 2>/dev/null || true
    echo -e "${GREEN}Authenticated!${NC}"
    ;;

  opencode)
    echo -e "${BLUE}OpenCode CLI${NC}"
    echo ""
    sleep "$DELAY"

    echo -e "Login URL:"
    echo -e "${GREEN}https://opencode.ai/auth?session=mock-session${NC}"
    echo ""

    read -r -t 30 2>/dev/null || true
    echo -e "${GREEN}Success${NC}"
    ;;

  droid)
    echo -e "${BLUE}Droid CLI${NC}"
    echo ""
    sleep "$DELAY"

    echo -e "Visit to authenticate:"
    echo -e "${GREEN}https://factory.ai/droid/auth?id=mock-droid${NC}"
    echo ""

    read -r -t 30 2>/dev/null || true
    echo -e "${GREEN}Authenticated${NC}"
    ;;

  *)
    echo "Unknown provider: $PROVIDER"
    echo "Supported: claude, codex, gemini, opencode, droid"
    exit 1
    ;;
esac
