#!/bin/bash
# Ensure the agent-relay daemon is running
# Called on SessionStart by the Claude Code plugin hook

# Find agent-relay binary
RELAY_BIN=""
if command -v agent-relay >/dev/null 2>&1; then
    RELAY_BIN="agent-relay"
elif [ -x "$HOME/.agent-relay/bin/agent-relay" ]; then
    RELAY_BIN="$HOME/.agent-relay/bin/agent-relay"
elif command -v npx >/dev/null 2>&1; then
    # Check if agent-relay is available via npx (installed as npm package)
    if npx --no-install agent-relay --version >/dev/null 2>&1; then
        RELAY_BIN="npx --no-install agent-relay"
    fi
fi

# If not installed, output instructions and exit
if [ -z "$RELAY_BIN" ]; then
    cat << 'EOF'

--- AGENT RELAY ---
agent-relay is not installed. Install it to enable multi-agent coordination:

  npm install -g agent-relay

Or use the standalone installer:

  curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash

After installing, restart Claude Code or run /agent-relay:setup.
--- END ---

EOF
    exit 0
fi

# Check if daemon is already running
# The daemon creates a socket file when active
PROJECT_ROOT="$(pwd)"
SOCKET_PATH="$PROJECT_ROOT/.agent-relay/relay.sock"

# Also check home directory socket as fallback
HOME_SOCKET="$HOME/.agent-relay/relay.sock"

daemon_running() {
    local sock="$1"
    if [ -S "$sock" ]; then
        # Socket exists - try to verify the process is alive via PID file
        local pid_file="${sock}.pid"
        if [ -f "$pid_file" ]; then
            local pid
            pid=$(cat "$pid_file" 2>/dev/null)
            if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
                return 0
            fi
        fi
        # Socket exists but no valid PID - might be stale
        return 1
    fi
    return 1
}

# Check if already running
if daemon_running "$SOCKET_PATH" || daemon_running "$HOME_SOCKET"; then
    # Daemon is running - silently exit
    exit 0
fi

# Start the daemon in the background
# Use nohup to survive terminal close, redirect output to log file
LOG_DIR="$PROJECT_ROOT/.agent-relay"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daemon.log"

nohup $RELAY_BIN up >> "$LOG_FILE" 2>&1 &
DAEMON_PID=$!

# Wait briefly for daemon to initialize
sleep 1

# Verify it started
if kill -0 "$DAEMON_PID" 2>/dev/null; then
    cat << EOF

--- AGENT RELAY ---
Daemon started (PID: $DAEMON_PID)
Socket: $SOCKET_PATH
Log: $LOG_FILE

MCP tools available: relay_send, relay_spawn, relay_inbox, relay_who
Slash commands: /agent-relay:status, /agent-relay:spawn, /agent-relay:team
--- END ---

EOF
else
    cat << EOF

--- AGENT RELAY ---
Warning: Daemon failed to start. Check logs at: $LOG_FILE

Try starting manually:
  agent-relay up

Or with verbose output:
  agent-relay up --verbose
--- END ---

EOF
fi

exit 0
