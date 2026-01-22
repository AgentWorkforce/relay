#!/bin/bash
# Setup script for browser-use integration with agent-relay
#
# This script installs the required Python dependencies for the browser agent.
#
# Usage:
#   ./setup.sh           # Install using pip
#   ./setup.sh --uv      # Install using uv (faster)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REQUIREMENTS_FILE="$SCRIPT_DIR/requirements.txt"

echo "====================================="
echo "  Browser Agent Setup (browser-use)"
echo "====================================="
echo ""

# Check for Python
if ! command -v python3 &> /dev/null; then
    echo "Error: Python 3 is required but not found."
    echo "Please install Python 3.11 or higher."
    exit 1
fi

PYTHON_VERSION=$(python3 --version 2>&1 | awk '{print $2}')
echo "Found Python: $PYTHON_VERSION"

# Check Python version (need 3.11+)
MAJOR=$(echo $PYTHON_VERSION | cut -d. -f1)
MINOR=$(echo $PYTHON_VERSION | cut -d. -f2)
if [ "$MAJOR" -lt 3 ] || ([ "$MAJOR" -eq 3 ] && [ "$MINOR" -lt 11 ]); then
    echo ""
    echo "Warning: browser-use requires Python 3.11+, you have $PYTHON_VERSION"
    echo "Some features may not work correctly."
    echo ""
fi

# Determine installation method
if [ "$1" == "--uv" ] || command -v uv &> /dev/null; then
    echo "Installing with uv..."
    echo ""

    if ! command -v uv &> /dev/null; then
        echo "Installing uv first..."
        curl -LsSf https://astral.sh/uv/install.sh | sh
        source $HOME/.cargo/env 2>/dev/null || true
    fi

    uv pip install -r "$REQUIREMENTS_FILE"

    # Install Chromium for Playwright
    echo ""
    echo "Installing Chromium browser..."
    uvx playwright install chromium
else
    echo "Installing with pip..."
    echo ""

    pip install -r "$REQUIREMENTS_FILE"

    # Install Chromium for Playwright
    echo ""
    echo "Installing Chromium browser..."
    python3 -m playwright install chromium
fi

echo ""
echo "====================================="
echo "  Setup Complete!"
echo "====================================="
echo ""
echo "Next steps:"
echo ""
echo "1. Set your LLM API key:"
echo "   export OPENAI_API_KEY=sk-..."
echo "   # or"
echo "   export ANTHROPIC_API_KEY=sk-ant-..."
echo ""
echo "2. Start the browser agent:"
echo "   agent-relay browser"
echo ""
echo "3. Send tasks from other agents:"
echo "   TO: Browser"
echo "   "
echo "   Navigate to https://example.com and get the page title"
echo ""
