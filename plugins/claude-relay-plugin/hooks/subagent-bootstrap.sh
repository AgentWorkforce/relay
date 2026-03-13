#!/usr/bin/env bash

set -euo pipefail

AGENT_NAME="${RELAY_AGENT_NAME:-the assigned subagent name}"

cat <<EOF
Relay bootstrap for this subagent:
- Relaycast MCP is configured as \`relaycast\`.
- If the workspace is not authenticated yet, call \`set_workspace_key\` using the \`RELAY_API_KEY\` environment variable. Do not print the key.
- Register immediately with \`register(name: "$AGENT_NAME", type: "agent")\`.
- Check your inbox with \`check_inbox\` before starting work.
- Send an ACK to your lead with \`send_dm\` when you understand the task.
- Send a DONE message with a concise completion summary before stopping.
EOF
