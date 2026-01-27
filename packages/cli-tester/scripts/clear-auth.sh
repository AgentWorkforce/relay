#!/bin/bash
# Clear CLI credentials for fresh testing
# Usage: ./clear-auth.sh <cli|all>
# Example: ./clear-auth.sh claude
#          ./clear-auth.sh all

CLI=${1:-}

if [ -z "$CLI" ]; then
    echo "Usage: ./clear-auth.sh <cli|all>"
    echo ""
    echo "Options:"
    echo "  claude   - Clear Claude credentials"
    echo "  codex    - Clear Codex credentials"
    echo "  gemini   - Clear Gemini credentials"
    echo "  cursor   - Clear Cursor credentials"
    echo "  opencode - Clear OpenCode credentials"
    echo "  droid    - Clear Droid credentials"
    echo "  copilot  - Clear GitHub Copilot credentials"
    echo "  all      - Clear all credentials"
    exit 1
fi

clear_cli() {
    local cli=$1
    local dir=""
    local files=()

    case $cli in
        claude)
            dir="$HOME/.claude"
            files=(".credentials.json" "settings.json" "settings.local.json")
            ;;
        codex)
            dir="$HOME/.codex"
            files=("auth.json" "config.json" "config.toml")
            ;;
        gemini)
            dir="$HOME/.gemini"
            files=("credentials.json" "settings.json")
            # Also check gcloud location
            if [ -f "$HOME/.config/gcloud/application_default_credentials.json" ]; then
                echo "  Removing: $HOME/.config/gcloud/application_default_credentials.json"
                rm -f "$HOME/.config/gcloud/application_default_credentials.json"
            fi
            ;;
        cursor|agent)
            # Cursor CLI installs as 'agent', credentials in ~/.cursor/
            dir="$HOME/.cursor"
            files=("auth.json" "settings.json")
            ;;
        opencode)
            dir="$HOME/.local/share/opencode"
            files=("auth.json")
            ;;
        droid)
            dir="$HOME/.droid"
            files=("auth.json")
            ;;
        copilot)
            # GitHub Copilot uses gh CLI auth - stored in ~/.config/gh/
            dir="$HOME/.config/gh"
            files=("hosts.yml" "config.yml")
            ;;
        *)
            echo "Unknown CLI: $cli"
            return 1
            ;;
    esac

    echo "Clearing credentials for: $cli"

    if [ -d "$dir" ]; then
        for file in "${files[@]}"; do
            if [ -f "$dir/$file" ]; then
                echo "  Removing: $dir/$file"
                rm -f "$dir/$file"
            fi
        done
        echo "  ✓ Done"
    else
        echo "  (no config directory found)"
    fi
}

echo "========================================"
echo "  Clearing CLI Credentials"
echo "========================================"
echo ""

if [ "$CLI" = "all" ]; then
    for c in claude codex gemini cursor opencode droid copilot; do
        clear_cli "$c"
        echo ""
    done
else
    clear_cli "$CLI"
fi

echo ""
echo "Credentials cleared. Run test-cli.sh to test fresh authentication."
