#!/usr/bin/env bash
#
# Agent Relay extension setup for Gemini CLI
#
# Ensures ~/.gemini/settings.json has the required tool permissions
# so background workers can use Relaycast MCP tools.
#

set -euo pipefail

SETTINGS_FILE="$HOME/.gemini/settings.json"
PERMISSIONS=(
  "relaycast.*"
  "mcp_relaycast_*"
)

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required. Install it with: brew install jq (macOS) or apt install jq (Linux)"
  exit 1
fi

if [ ! -f "$SETTINGS_FILE" ]; then
  # Create a basic settings file if it doesn't exist
  mkdir -p "$(dirname "$SETTINGS_FILE")"
  echo '{"tools":{"allowed":[]}}' > "$SETTINGS_FILE"
fi

# Build a JSON array of all permissions
PERMS_JSON=$(printf '%s\n' "${PERMISSIONS[@]}" | jq -R . | jq -s .)

# Check if all permissions are already present
missing=$(jq --argjson perms "$PERMS_JSON" '
  (.tools.allowed // []) as $existing |
  [$perms[] | select(. as $p | $existing | index($p) | not)]
' "$SETTINGS_FILE")

if [ "$missing" = "[]" ]; then
  echo "Relaycast MCP permissions already configured in $SETTINGS_FILE."
else
  # Add missing permissions, preserving existing settings
  tmp=$(mktemp)
  jq --argjson perms "$PERMS_JSON" '
    .tools //= {} |
    .tools.allowed //= [] |
    .tools.allowed += $perms |
    .tools.allowed |= unique
  ' "$SETTINGS_FILE" > "$tmp" && mv "$tmp" "$SETTINGS_FILE"
  echo "Added Relaycast MCP permissions to $SETTINGS_FILE."
fi

echo ""
echo "Done! Gemini sub-agents can now use relay tools without confirmation."
