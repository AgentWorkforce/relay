#!/bin/bash
# Verify CLI credentials exist and show (redacted) contents
# Usage: ./verify-auth.sh <cli>
# Example: ./verify-auth.sh claude

CLI=${1:-claude}

# Map CLI to credential file path
case $CLI in
    claude)
        CRED_FILE="$HOME/.claude/.credentials.json"
        ;;
    codex)
        CRED_FILE="$HOME/.codex/auth.json"
        ;;
    gemini)
        # Gemini stores in application_default_credentials.json
        CRED_FILE="$HOME/.config/gcloud/application_default_credentials.json"
        ALT_FILE="$HOME/.gemini/credentials.json"
        ;;
    cursor|agent)
        # Cursor CLI installs as 'agent', credentials in ~/.cursor/
        CRED_FILE="$HOME/.cursor/auth.json"
        CLI="cursor"  # Normalize name
        ;;
    opencode)
        CRED_FILE="$HOME/.local/share/opencode/auth.json"
        ;;
    droid)
        CRED_FILE="$HOME/.droid/auth.json"
        ;;
    copilot)
        # GitHub Copilot uses gh CLI auth - stored in YAML format
        CRED_FILE="$HOME/.config/gh/hosts.yml"
        ;;
    *)
        echo "Unknown CLI: $CLI"
        echo "Supported: claude, codex, gemini, cursor, opencode, droid, copilot"
        exit 1
        ;;
esac

echo "========================================"
echo "  Checking credentials for: $CLI"
echo "========================================"
echo ""

# Check primary credential file
if [ -f "$CRED_FILE" ]; then
    echo "✓ Credentials found: $CRED_FILE"
    echo ""
    echo "Contents (tokens redacted):"
    echo "----------------------------------------"
    # Redact any values that look like tokens (long strings, JWTs, etc.)
    cat "$CRED_FILE" | jq '.' 2>/dev/null | \
        sed -E 's/"([^"]*[Tt]oken[^"]*|[Aa]ccess[^"]*|[Rr]efresh[^"]*|[Ss]ecret[^"]*)": "[^"]{20,}"/"***\1***": "[REDACTED]"/g' || \
        cat "$CRED_FILE" | sed -E 's/"[^"]{40,}"/"[REDACTED]"/g'
    echo "----------------------------------------"
    echo ""

    # Check for specific fields
    if command -v jq &> /dev/null && [ -f "$CRED_FILE" ]; then
        echo "Token check:"
        if jq -e '.claudeAiOauth.accessToken' "$CRED_FILE" &>/dev/null; then
            echo "  ✓ Access token present (Claude format)"
        elif jq -e '.tokens.access_token' "$CRED_FILE" &>/dev/null; then
            echo "  ✓ Access token present (Codex format)"
        elif jq -e '.accessToken' "$CRED_FILE" &>/dev/null; then
            echo "  ✓ Access token present (generic format)"
        elif jq -e '.access_token' "$CRED_FILE" &>/dev/null; then
            echo "  ✓ Access token present (OAuth format)"
        else
            echo "  ? Access token format unknown"
        fi

        if jq -e '.claudeAiOauth.refreshToken' "$CRED_FILE" &>/dev/null || \
           jq -e '.tokens.refresh_token' "$CRED_FILE" &>/dev/null || \
           jq -e '.refreshToken' "$CRED_FILE" &>/dev/null || \
           jq -e '.refresh_token' "$CRED_FILE" &>/dev/null; then
            echo "  ✓ Refresh token present"
        else
            echo "  ✗ No refresh token found"
        fi
    fi

    exit 0
else
    echo "✗ No credentials found at: $CRED_FILE"

    # Check alternate location for Gemini
    if [ -n "$ALT_FILE" ] && [ -f "$ALT_FILE" ]; then
        echo ""
        echo "✓ Found alternate credentials: $ALT_FILE"
        cat "$ALT_FILE" | jq '.' 2>/dev/null | \
            sed -E 's/"[^"]{40,}"/"[REDACTED]"/g' || \
            cat "$ALT_FILE"
        exit 0
    fi

    # Show what files exist in the CLI's config directory
    CLI_DIR=$(dirname "$CRED_FILE")
    if [ -d "$CLI_DIR" ]; then
        echo ""
        echo "Files in $CLI_DIR:"
        ls -la "$CLI_DIR" 2>/dev/null || echo "  (directory exists but is empty or unreadable)"
    else
        echo ""
        echo "Config directory does not exist: $CLI_DIR"
    fi

    exit 1
fi
