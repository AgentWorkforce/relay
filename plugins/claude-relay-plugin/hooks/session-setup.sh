#!/usr/bin/env bash
#
# SessionStart hook — ensures relay MCP permissions are configured
# in the project's .claude/settings.json and .claude/settings.local.json
# so background workers can use Relaycast tools without manual approval.
#
# Runs silently on every session start. Idempotent.
#

set -euo pipefail

SETTINGS_DIR=".claude"
PERMISSION="mcp__plugin_agent-relay_relaycast"

# jq is required for JSON manipulation
command -v jq >/dev/null 2>&1 || exit 0

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
    return
  fi

  # Already configured — nothing to do
  if jq -e ".permissions.allow // [] | index(\"$PERMISSION\")" "$file" >/dev/null 2>&1; then
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
}

ensure_permission "$SETTINGS_DIR/settings.json"
ensure_permission "$SETTINGS_DIR/settings.local.json"
