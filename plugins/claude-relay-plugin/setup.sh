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
PERMISSION="mcp__plugin_agent-relay_relaycast"

if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq is required. Install it with: brew install jq (macOS) or apt install jq (Linux)"
  exit 1
fi

# Create .claude dir if needed
mkdir -p "$SETTINGS_DIR"

ensure_permission() {
  local file="$1"

  if [ ! -f "$file" ]; then
    cat > "$file" <<EOF
{
  "permissions": {
    "allow": [
      "$PERMISSION"
    ]
  }
}
EOF
    echo "Created $file with Relaycast MCP permissions."
    return
  fi

  # Already configured — nothing to do
  if jq -e ".permissions.allow // [] | index(\"$PERMISSION\")" "$file" >/dev/null 2>&1; then
    echo "Relaycast MCP permissions already configured in $file."
    return
  fi

  # Add the permission, preserving existing settings
  local tmp
  tmp=$(mktemp)
  jq '
    .permissions //= {} |
    .permissions.allow //= [] |
    .permissions.allow += ["'"$PERMISSION"'"] |
    .permissions.allow |= unique
  ' "$file" > "$tmp" && mv "$tmp" "$file"

  echo "Added Relaycast MCP permissions to $file."
}

ensure_permission "$SETTINGS_DIR/settings.json"
ensure_permission "$SETTINGS_DIR/settings.local.json"

echo ""
echo "Done! Background workers can now use relay tools."
echo "You can verify by checking: cat $SETTINGS_DIR/settings.json && cat $SETTINGS_DIR/settings.local.json"
