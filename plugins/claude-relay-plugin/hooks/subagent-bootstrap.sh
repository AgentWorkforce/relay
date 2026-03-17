#!/usr/bin/env bash

set -euo pipefail

AGENT_NAME="${RELAY_AGENT_NAME:-the assigned subagent name}"

cat <<EOF
MANDATORY relay setup — complete these steps IN ORDER before any other work:

1. Your task prompt contains a workspace key. Call \`set_workspace_key\` with that key to authenticate. Do not print the key.
2. Call \`register(name: "$AGENT_NAME", type: "agent")\` to register with the relay.
3. Call \`check_inbox(as: "$AGENT_NAME")\` to get your task assignment.
4. Send an ACK to your lead via \`send_dm(as: "$AGENT_NAME")\` when you understand the task.
5. When finished, send a DONE message with a concise completion summary via \`send_dm(as: "$AGENT_NAME")\` before stopping.

IMPORTANT: Include \`as: "$AGENT_NAME"\` on EVERY relay tool call to ensure correct message attribution.

Do NOT skip steps 1-2. Without them you cannot send or receive messages.
EOF
