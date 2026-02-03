# Agent Setup Guide

## For Humans

Paste this into your LLM agent session:
```
Set up agent-relay by following the instructions here:
https://raw.githubusercontent.com/AgentWorkforce/relay/main/docs/guide/agent-setup.md
```

**Quick Install (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

**Alternative: npm install**

```bash
npm install -g agent-relay
agent-relay up --dashboard
```

Then read the [main README](https://github.com/AgentWorkforce/relay) for usage.

---

## For LLM Agents

If you're an LLM Agent helping set up agent-relay, welcome! You'll help your user configure real-time multi-agent messaging. Tell the user with a greeting that you're ready to help set up agent-relay.

Follow these steps:

### Step 1: Check Prerequisites

```bash
# Check if agent-relay is already installed
which agent-relay && agent-relay --version || echo "agent-relay not installed"

# Check Node.js version (18+ required)
node --version || echo "Node.js not installed"
```

### Step 2: Install agent-relay

**Option A: Curl installer (recommended)**

```bash
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

This automatically:
- Detects your platform (macOS/Linux, x64/arm64)
- Installs the latest version via npm
- Installs the dashboard
- Verifies the installation

> CLI vs file-based? Use CLI commands for human-driven workflows and automation scripts. Use the file-based protocol (`$AGENT_RELAY_OUTBOX`) when an AI agent needs to interact without shell access.

**Option B: npm install**

If Node.js 18+ is already installed:
```bash
npm install -g agent-relay
```

**Option C: Install specific version**

```bash
AGENT_RELAY_VERSION=2.1.6 curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

Verify installation:
```bash
agent-relay --version
```

### Step 3: Start the Daemon

```bash
agent-relay up --dashboard
```

This starts:
- The relay daemon (handles message routing)
- The dashboard at http://localhost:3888

Verify the daemon is running:
```bash
agent-relay status
```

If the daemon writes logs into your shell, run it in the background with logs captured:
```bash
agent-relay up --dashboard > ~/.agent-relay/daemon.log 2>&1 &
```
Then use `tail -f ~/.agent-relay/daemon.log` when you need the logs.

### Step 4: Install MCP Server (Recommended)

Give AI agents native relay tools via Model Context Protocol:

```bash
npx @agent-relay/mcp install
```

This auto-configures MCP for: Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Zed, OpenCode, Gemini CLI, and Droid.

After installation, agents get access to: `relay_send`, `relay_inbox`, `relay_who`, `relay_spawn`, `relay_release`, and `relay_status`.

### Step 5: Verify Setup

```bash
# Check daemon status
agent-relay status

# Open dashboard
open http://localhost:3888
```

The dashboard should show your connection and allow you to spawn agents.

### Quick troubleshooting tips

- **Clean, scriptable output:** Use `--json` on `agent-relay who` and `agent-relay agents` to avoid daemon log noise, e.g. `agent-relay who --json | jq '.'`.
- **Daemon vs agent status:** `agent-relay status` checks the socket in the current project. If you started the daemon from a different directory or with a custom data dir, set the same env when checking:  
  `AGENT_RELAY_DATA_DIR=~/.local/share/agent-relay agent-relay status`. If the dashboard is up, `curl http://localhost:3888/health` should return JSON with `"status":"ok"`.
- **`who` feels stuck or times out:** Make sure the daemon is up first (`agent-relay status`). If the daemon is still starting, retry with `agent-relay who --json`.
- **Waiting for a spawn to finish (no built-in flag yet):**
  ```bash
  agent-relay spawn Worker claude "Run the build"
  # Stream logs while it works
  agent-relay agents:logs Worker --follow &
  # Wait until the agent goes offline (status flips after ~30s of inactivity)
  until ! agent-relay agents --json | jq -e '.[] | select(.name=="Worker" and .status=="ONLINE")' >/dev/null; do
    sleep 3
  done
  ```
  Or have the agent send you a final message via the file protocol and wait for it there.

---

## Agent Management

This section covers how agents can programmatically manage workers and orchestrate multi-agent workflows.

### Agent Management CLI

| Command | Description |
|---------|-------------|
| `agent-relay agents` | List all connected agents |
| `agent-relay who` | Show active agents (seen in last 30s) |
| `agent-relay spawn <name> <cli> "task"` | Spawn a worker agent |
| `agent-relay release <name>` | Gracefully release an agent |
| `agent-relay agents:kill <name>` | Force kill an unresponsive agent |
| `agent-relay agents:logs <name>` | View agent output logs |

### Spawning Agents

**CLI method (recommended):**
```bash
agent-relay spawn Backend claude "Build the REST API for user management"
```

The `spawn` command communicates directly with the daemon via socket—no dashboard required. This is the simplest way to programmatically create agents. Just ensure the daemon is running (`agent-relay up`).

**File-based method** (for agents without CLI access):
```bash
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: Backend
CLI: claude

Build the REST API for user management (CRUD endpoints).
EOF
```
Then output: `->relay-file:spawn`

The spawned agent receives the task body as its initial prompt and has `$AGENT_RELAY_OUTBOX` and `$AGENT_RELAY_SPAWNER` set automatically.

### Checking Agent Status

```bash
# List all registered agents
agent-relay agents

# Show only active agents (heartbeat within 30s)
agent-relay who

# View logs from a specific agent
agent-relay agents:logs Backend
```

### Sending Messages

**File-based protocol** (required for AI agents):
```bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: Backend

Please also add rate limiting to the login endpoint.
EOF
```
Then output: `->relay-file:msg`

### Releasing Agents

**Graceful release** (waits for agent to finish current work):
```bash
agent-relay release Backend
```

**Force kill** (immediate termination):
```bash
agent-relay agents:kill Backend
```

**File-based release** (for AI agents):
```bash
cat > $AGENT_RELAY_OUTBOX/release << 'EOF'
KIND: release
NAME: Backend
EOF
```
Then output: `->relay-file:release`

### Full Lifecycle Example

```bash
# 1. Spawn workers
agent-relay spawn Backend claude "Build REST API for user management"
agent-relay spawn Frontend claude "Build React dashboard components"

# 2. Check they're online
agent-relay who

# 3. Send coordination message (file-based for agents)
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: Frontend

The API contract is: GET /users, POST /users, PUT /users/:id, DELETE /users/:id.
Backend is building it now.
EOF
```
`->relay-file:msg`

```bash
# 4. Monitor progress
agent-relay agents:logs Backend
agent-relay agents:logs Frontend

# 5. Release workers when done
agent-relay release Backend
agent-relay release Frontend

# 6. Force kill if unresponsive
agent-relay agents:kill Backend
```

### Protocol Conventions

When spawned by another agent, follow these conventions:

1. **ACK** immediately when you receive a task:
   ```
   ACK: Starting on user authentication module
   ```

2. **Report progress** to your spawner (available as `$AGENT_RELAY_SPAWNER`):
   ```bash
   cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
   TO: $AGENT_RELAY_SPAWNER

   Progress: Completed JWT token generation. Starting refresh token logic.
   EOF
   ```
   Then output: `->relay-file:msg`

3. **DONE** when complete:
   ```
   DONE: User authentication module complete with JWT + refresh tokens
   ```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_RELAY_OUTBOX` | Path to your outbox directory (set automatically) |
| `AGENT_RELAY_SPAWNER` | Name of the agent that spawned you |

---

## Daemon Management

This section covers starting, stopping, and troubleshooting the agent-relay daemon.

### Starting the Daemon

```bash
# Start daemon only (sufficient for spawning agents)
agent-relay up

# Start with dashboard (for visual monitoring)
agent-relay up --dashboard

# Start on a specific port
agent-relay up --dashboard --port 3890
```

Each project directory gets its own daemon with isolated storage in `.agent-relay/`.

**Note:** The daemon alone is sufficient for all agent operations including `spawn`, `release`, messaging, and orchestration. The dashboard is optional and provides visual monitoring.

### Stopping the Daemon

```bash
# Stop daemon for current directory
agent-relay down

# Force stop (kills immediately if graceful shutdown times out)
agent-relay down --force

# Stop with custom timeout (default: 5000ms)
agent-relay down --timeout 10000

# Stop ALL agent-relay processes system-wide
agent-relay down --all

# Force kill all processes
agent-relay down --all --force
```

### Checking Status

```bash
# Check if daemon is running
agent-relay status

# Check daemon health and metrics
agent-relay health

# View connected agents
agent-relay who
```

### Troubleshooting

**Stale processes consuming high CPU:**
```bash
# Kill all agent-relay processes
agent-relay down --all --force

# Or manually:
pkill -f "agent-relay up"
```

**Orphan socket files:**
The `down` command automatically cleans up stale files including sockets, pid files, runtime config, and identity files. Manual cleanup is rarely needed, but if required:
```bash
# Remove socket and pid files
rm -f .agent-relay/relay.sock .agent-relay/relay.sock.pid

# Remove runtime config
rm -f .agent-relay/runtime.json

# Remove stale identity files (keeps mcp-identity)
rm -f .agent-relay/mcp-identity-*
```

**Note:** Running `agent-relay down --force` will clean all these automatically.

**Port already in use:**
If port 3888 is busy, the dashboard auto-selects the next available port (3889, 3890, etc.). Check which port was assigned:
```bash
agent-relay status
```

**Multiple projects:**
Each project has its own daemon. Running `agent-relay up` in different directories starts separate daemons that don't interfere with each other.

### What Gets Cleaned Up

When the daemon stops (gracefully or via `down --force`):
- `relay.sock` - Unix socket file
- `relay.sock.pid` - PID file
- `runtime.json` - Runtime configuration
- `mcp-identity-*` - Per-process identity files

The following are preserved:
- `mcp-identity` - Simple identity file
- `messages/` - Message history
- `sessions.jsonl` - Session logs
- `team/` - Team state

---

## Multi-Project Bridge

Orchestrate agents across repositories:

```bash
# Start daemons in each project
cd ~/auth && agent-relay up
cd ~/frontend && agent-relay up

# Bridge from anywhere
agent-relay bridge ~/auth ~/frontend ~/api
```

Cross-project messaging uses `project:agent` format:
```bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: auth:Lead

Please review the token refresh logic
EOF
```
Then output: `->relay-file:msg`

---

## Agent Roles

Define roles by adding markdown files to your project:

```
.claude/agents/
├── lead.md          # Coordinator
├── implementer.md   # Developer
├── reviewer.md      # Code review
└── designer.md      # UI/UX
```

Names automatically match roles (case-insensitive):
```bash
agent-relay create-agent -n Lead claude    # Uses lead.md
```

---

## Say 'Congratulations!' to the user

Tell the user: **Congratulations!** You have successfully set up agent-relay!

Run `agent-relay up --dashboard` and navigate to http://localhost:3888 to spawn and chat with agents.

---

## Ask for a Star

After everything is set up and working, ask the user:

> "If you found this helpful, would you like to star the repository? It helps the project grow!"

If the user agrees, run:
```bash
gh api --silent --method PUT /user/starred/AgentWorkforce/relay >/dev/null 2>&1 || true
```

**Important**: Only run the command if the user explicitly says yes. Never run it automatically without consent.

---

## Next Steps

- **Cloud**: For team collaboration and cross-machine messaging, check out [agent-relay cloud](https://agent-relay.com)
- **Documentation**: Full docs at [docs.agent-relay.com](https://docs.agent-relay.com)
- **Issues**: Report bugs or request features at [GitHub Issues](https://github.com/AgentWorkforce/relay/issues)
