#!/usr/bin/env bash
#
# Agent Relay plugin setup for Claude Code
#
# Ensures .claude/settings.json and .claude/settings.local.json have
# the required permission rules so background workers can use
# Relaycast MCP tools.
#

set -euo pipefail

SETTINGS_DIR=".claude"
PERMISSIONS=(
  "mcp__plugin_agent-relay_relaycast"
)

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required. Install it with: brew install jq (macOS) or apt install jq (Linux)"
  exit 1
fi

# Create .claude dir if needed
mkdir -p "$SETTINGS_DIR"

# Build a JSON array of all permissions
PERMS_JSON=$(printf '%s\n' "${PERMISSIONS[@]}" | jq -R . | jq -s .)

ensure_permissions() {
  local file="$1"

  if [ ! -f "$file" ]; then
    echo "{\"permissions\":{\"allow\":$PERMS_JSON}}" | jq . > "$file"
    echo "Created $file with Relaycast MCP permissions."
    return
  fi

  # Check if all permissions are already present
  local missing
  missing=$(jq --argjson perms "$PERMS_JSON" '
    (.permissions.allow // []) as $existing |
    [$perms[] | select(. as $p | $existing | index($p) | not)]
  ' "$file")

  if [ "$missing" = "[]" ]; then
    echo "Relaycast MCP permissions already configured in $file."
    return
  fi

  # Add missing permissions, preserving existing settings
  local tmp
  tmp=$(mktemp)
  jq --argjson perms "$PERMS_JSON" '
    .permissions //= {} |
    .permissions.allow //= [] |
    .permissions.allow += $perms |
    .permissions.allow |= unique
  ' "$file" > "$tmp" && mv "$tmp" "$file"

  echo "Added Relaycast MCP permissions to $file."
}

ensure_permissions "$SETTINGS_DIR/settings.json"
ensure_permissions "$SETTINGS_DIR/settings.local.json"

echo ""
echo "Done! Background workers can now use relay tools."
echo "You can verify by checking: cat $SETTINGS_DIR/settings.json && cat $SETTINGS_DIR/settings.local.json"
