#!/usr/bin/env bash
set -eu

WORKSPACE_KEY=$(cat "${HOME}/.relay/workspace-key" 2>/dev/null || true)
AGENT_NAME="${RELAY_AGENT_NAME:-the assigned worker name}"

cat <<EOF
Relaycast worker setup — complete these steps IN ORDER:

1. Call \`workspace.set_key(api_key: "$WORKSPACE_KEY")\`.
2. Call \`agent.register(name: "$AGENT_NAME", type: "agent")\`.
3. Call \`message.inbox.check()\` to get your task assignment.
4. Send an ACK DM to your lead when you understand the task.
5. When finished, send a DONE DM with results and then send DONE to the system.

Do NOT skip steps 1-2 or you will be disconnected.
EOF
