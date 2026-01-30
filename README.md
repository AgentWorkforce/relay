# agent-relay

Real-time messaging between AI agents. Sub-5ms latency, any CLI, any language.

## Install

```bash
npm install -g agent-relay
```

**Requirements:** Node.js 20+

**Linux:** Install build tools first:
```bash
sudo apt-get update && sudo apt-get install -y build-essential
```

## Quick Start

```bash
# Start with your preferred CLI
agent-relay claude
agent-relay codex
agent-relay opencode
agent-relay gemini
agent-relay droid
```

This starts the relay daemon, a dashboard at http://localhost:3888, and a coordinator agent.

## How It Works

Agents communicate via a file-based protocol. The relay daemon routes messages between agents over Unix domain sockets with sub-5ms latency.

```bash
# Send a message (AGENT_RELAY_OUTBOX is set automatically)
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: Bob

Hey, can you help with this task?
EOF
```
Then output: `->relay-file:msg`

Broadcast to all agents:
```bash
cat > $AGENT_RELAY_OUTBOX/broadcast << 'EOF'
TO: *

Message to all agents
EOF
```
Then output: `->relay-file:broadcast`

Wait for acknowledgment:
```
->relay:Bob [await] Please confirm
->relay:Bob [await:30s] Please confirm within 30 seconds
```

## CLI Reference

| Command | Description |
|---------|-------------|
| `agent-relay <cli>` | Start daemon + coordinator (claude, codex, gemini, etc.) |
| `agent-relay up` | Start daemon + dashboard |
| `agent-relay down` | Stop daemon |
| `agent-relay status` | Check daemon status |
| `agent-relay create-agent -n Name <cmd>` | Create a named agent |
| `agent-relay bridge <projects...>` | Bridge multiple projects |
| `agent-relay doctor` | Diagnose issues |

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

## MCP Server

Give AI agents native relay tools via [Model Context Protocol](https://modelcontextprotocol.io):

```bash
npx @agent-relay/mcp install
```

Supports Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Zed, OpenCode, Gemini CLI, and Droid.

Once configured, agents get access to: `relay_send`, `relay_inbox`, `relay_who`, `relay_spawn`, `relay_release`, and `relay_status`.

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

## Cloud

For team collaboration and cross-machine messaging, use [agent-relay cloud](https://agent-relay.com):

```bash
agent-relay cloud link      # Link your machine
agent-relay cloud status    # Check cloud status
agent-relay cloud agents    # List agents across machines
agent-relay cloud send AgentName "Your message"
```

## Teaching Agents

Install the messaging protocol snippet for your agents via [prpm](https://prpm.dev):

```bash
npx prpm install @agent-relay/agent-relay-snippet
```

View all packages on our [prpm organization page](https://prpm.dev/orgs?name=Agent%20Relay).

## Platform Support

| Platform | Status |
|----------|--------|
| macOS (Apple Silicon & Intel) | Full support |
| Linux x64 | Full support |
| Linux arm64 | Fallback (uses tmux) |
| Windows | Fallback (uses tmux via WSL) |

<details>
<summary><h2>For Agents</h2></summary>

This section covers how agents can programmatically run relay, spawn workers, and orchestrate multi-agent workflows.

### Starting Relay

Agents can start the relay daemon and immediately begin orchestrating:

```bash
# Start daemon + dashboard (no coordinator agent)
agent-relay up

# Start daemon with a coordinator agent
agent-relay claude
```

### Spawning Agents

Spawn worker agents by writing a spawn file to your outbox:

```bash
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: Implementer
CLI: claude

Implement the user authentication module.
Use JWT tokens with refresh support.
EOF
```
Then output: `->relay-file:spawn`

The spawned agent receives the task body as its initial prompt and has `$AGENT_RELAY_OUTBOX` and `$AGENT_RELAY_SPAWNER` set automatically.

### Sending Messages to Agents

```bash
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: Implementer

Please also add rate limiting to the login endpoint.
EOF
```
Then output: `->relay-file:msg`

### Releasing Agents

When a worker is done, release it:

```bash
cat > $AGENT_RELAY_OUTBOX/release << 'EOF'
KIND: release
NAME: Implementer
EOF
```
Then output: `->relay-file:release`

### Full Lifecycle Example

Here's a complete orchestration flow — spawn workers, assign tasks, and clean up:

```bash
# 1. Spawn a backend worker
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: Backend
CLI: claude

Build the REST API for user management (CRUD endpoints).
EOF
```
`->relay-file:spawn`

```bash
# 2. Spawn a frontend worker
cat > $AGENT_RELAY_OUTBOX/spawn << 'EOF'
KIND: spawn
NAME: Frontend
CLI: claude

Build the React components for the user management dashboard.
EOF
```
`->relay-file:spawn`

```bash
# 3. Coordinate between workers
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: Frontend

The API contract is: GET /users, POST /users, PUT /users/:id, DELETE /users/:id.
Backend is building it now.
EOF
```
`->relay-file:msg`

```bash
# 4. Check who's online
cat > $AGENT_RELAY_OUTBOX/msg << 'EOF'
TO: *

Status check — reply with your progress.
EOF
```
`->relay-file:msg`

```bash
# 5. Release workers when done
cat > $AGENT_RELAY_OUTBOX/release << 'EOF'
KIND: release
NAME: Backend
EOF
```
`->relay-file:release`

```bash
cat > $AGENT_RELAY_OUTBOX/release << 'EOF'
KIND: release
NAME: Frontend
EOF
```
`->relay-file:release`

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

</details>

## Development

```bash
git clone https://github.com/AgentWorkforce/relay.git
cd relay
npm install && npm run build
npm run dev  # Start daemon + dashboard in dev mode
```

## Philosophy

**Do one thing well**: Real-time agent messaging with sub-5ms latency.

agent-relay is a messaging layer, not a framework. It works with any CLI tool, any orchestration system, and any memory layer.

## License

Apache-2.0 — Copyright 2025 Agent Workforce Incorporated

---

**Links:** [Documentation](https://github.com/AgentWorkforce/relay/tree/main/docs) · [Issues](https://github.com/AgentWorkforce/relay/issues) · [Cloud](https://agent-relay.com)
