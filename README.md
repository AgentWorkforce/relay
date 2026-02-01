# agent-relay

> Real-time messaging between AI agents. Sub-5ms latency, any CLI, any language.

[![npm](https://img.shields.io/npm/v/agent-relay)](https://www.npmjs.com/package/agent-relay)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

---

## Install

```bash
npm install -g agent-relay
```

**Requirements:** Node.js 20+

## Getting Started

```bash
agent-relay up --dashboard
```

Navigate to **http://localhost:3888** to:
- 🤖 Spawn and chat with agents using your locally installed CLI tools
- 👀 View real-time agent presence and status
- 💬 Message history and threading
- 📜 Log streaming from all agents

---

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
Agents spawned by that name in the dashboard automatically assume that role.

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

Connect your CLI tool to your own private workspace and unlock agents working 24/7 against your GitHub repository in their own private sandbox.

## Teaching Agents

> **Note:** On `agent-relay up` initialization this step happens automatically. If there is already an existing `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md`, it will append the protocol instructions to that file.

Install the messaging protocol snippet for your agents via [prpm](https://prpm.dev):

```bash
npx prpm install @agent-relay/agent-relay-snippet

# for Claude
npx prpm install @agent-relay/agent-relay-snippet --location CLAUDE.md
```

Prefer skills?
```bash
npx prpm install @agent-relay/using-agent-relay
```

View all packages on our [prpm organization page](https://prpm.dev/orgs?name=Agent%20Relay).

---

<details>
<summary><h2>For Agents</h2></summary>

This section covers how agents can programmatically manage workers and orchestrate multi-agent workflows.

### Prerequisites

```bash
npm install -g agent-relay
agent-relay up
```

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

</details>

## Using the Agent Relay SDK

The easiest way to develop against relay:

```bash
# Install globally and start daemon
npm install -g agent-relay
agent-relay up

# In your project
npm install agent-relay
```

```typescript
import { RelayClient } from 'agent-relay';

const client = new RelayClient({ name: 'MyApp' });
await client.connect();

// Spawn a worker agent
await client.spawn({ name: 'Worker', cli: 'claude', task: 'Wait for instructions' });

// Send it a message
await client.send('Worker', 'Hello from my app');
```

---

## Philosophy

> **Do one thing well:** Real-time agent messaging with sub-5ms latency.

agent-relay is a messaging layer, not a framework. It works with any CLI tool, any orchestration system, and any memory layer.

---

## License

Apache-2.0 — Copyright 2025 Agent Workforce Incorporated

---

**Links:** [Documentation](https://docs.agent-relay.com/) · [Issues](https://github.com/AgentWorkforce/relay/issues) · [Cloud](https://agent-relay.com)
