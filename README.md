# agent-relay

[![CI](https://github.com/khaliqgant/agent-relay/actions/workflows/test.yml/badge.svg)](https://github.com/khaliqgant/agent-relay/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/khaliqgant/agent-relay/branch/main/graph/badge.svg)](https://codecov.io/gh/khaliqgant/agent-relay)

Real-time agent-to-agent communication system. Enables AI agents (Claude, Codex, Gemini, etc.) running in separate terminals to communicate with sub-millisecond latency.

## Installation & Quick Start

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/khaliqgant/agent-relay/main/install.sh | bash

# Navigate to your project
cd /path/to/your/project

# Start the daemon
agent-relay start -f

# In another terminal, wrap an agent
agent-relay wrap "claude"
# Output: Agent name: SilverMountain

# In a third terminal, wrap another agent
agent-relay wrap "codex"
# Output: Agent name: BlueFox
```

**Requirements:** Node.js 20+, macOS/Linux, tmux

**From source:**
```bash
git clone https://github.com/khaliqgant/agent-relay.git && cd agent-relay
npm install && npm run build
npx agent-relay start -f
```

## When to Use agent-relay

Use agent-relay when you want **fast, local, real-time coordination** between multiple CLI-based agents.

**Best for:**
- Multi-terminal agent swarms needing quick message exchange
- Turn-based coordination (games, schedulers, orchestrators)
- "Wrap anything" workflows - works with any CLI agent

**Tradeoffs:**
- Local IPC only (Unix domain sockets); no cross-host networking
- Best-effort delivery (persistence via SQLite, but no guaranteed retries yet)

### How It Works

1. **Start daemon** - Listens on a Unix socket, routes messages between agents
2. **Wrap agents in tmux** - Each agent runs in a tmux session with output parsing
3. **Pattern detection** - Agent outputs `@relay:AgentName message` to send
4. **Message injection** - Incoming messages are typed into the agent's tmux session

### Alternatives

| Solution | Best For | Trade-off |
|----------|----------|-----------|
| **agent-relay** | Real-time, local, any CLI | Local only, requires tmux |
| [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | MCP ecosystem, persistence | Requires MCP integration |
| [swarm-mail](https://github.com/joelhooks/swarm-tools) | Filesystem-backed, simple | Polling-based latency |

## Features

- **Tmux wrapper** - Wraps any CLI (Claude, Codex, Gemini) in a tmux session
- **Project isolation** - Each project gets its own socket, database, and namespace
- **Real-time messaging** - Unix domain sockets with <5ms latency
- **Mouse scroll passthrough** - Scrolling works naturally in wrapped apps
- **CLI type detection** - Special handling for Gemini, Claude, Codex
- **Message persistence** - SQLite storage with `msg-read` for long messages
- **Auto-generated names** - AdjectiveNoun format (SilverMountain, BlueFox)

### Sending Messages

Once agents are wrapped, they communicate via their terminal output:

```bash
# Agent outputs this to send a message
@relay:BlueFox Hello from SilverMountain!

# Broadcast to all
@relay:* Anyone online?

# Recipient sees:
# Relay message from SilverMountain: Hello from SilverMountain!
```

### Project Isolation

Each project gets its own namespace (socket, database, team directory):

```bash
agent-relay project          # Show current project paths
agent-relay project --list   # List all projects
```

### Enable Your Agents

Add agent-relay instructions to your project (docs live under `docs/`):

```bash
mkdir -p docs
curl -fsSL https://raw.githubusercontent.com/khaliqgant/agent-relay/main/docs/CLAUDE.md > docs/CLAUDE.md
```

## Common Use Cases

### 1. Pair Programming: Code + Review

Two agents collaborating on a codebase - one writes code, the other reviews:

```bash
# Terminal 1: Start daemon
agent-relay start -f

# Terminal 2: Code writer agent
agent-relay wrap -n Coder "claude"
# Agent starts working, then sends:
# @relay:Reviewer I've implemented the auth module. Please review src/auth.ts

# Terminal 3: Reviewer agent
agent-relay wrap -n Reviewer "claude"
# Receives the message and reviews the code
# @relay:Coder Found an issue in line 45: missing input validation
```

### 2. Multi-Agent Task Distribution

A coordinator distributing tasks to worker agents:

```bash
# Set up workers with file-based inboxes
mkdir -p /tmp/workers
agent-relay inbox-write -t Worker1 -f Coordinator -m "Process files in /data/batch1" -d /tmp/workers
agent-relay inbox-write -t Worker2 -f Coordinator -m "Process files in /data/batch2" -d /tmp/workers

# Each worker polls their inbox
agent-relay inbox-poll -n Worker1 -d /tmp/workers --clear
# Worker1 sees: Process files in /data/batch1
```

### 3. Turn-Based Game (Tic-Tac-Toe)

Two agents playing a game with coordinated turns:

```bash
# Quick setup
agent-relay tictactoe-setup -d /tmp/ttt --player-x AgentX --player-o AgentO

# Terminal 1: Player X reads instructions
cat /tmp/ttt/AgentX/INSTRUCTIONS.md

# Terminal 2: Player O reads instructions
cat /tmp/ttt/AgentO/INSTRUCTIONS.md

# Agents communicate moves via inbox:
agent-relay inbox-write -t AgentO -f AgentX -m "MOVE: center" -d /tmp/ttt
```

### 4. Live Collaboration Session

Multiple agents working together with real-time socket communication:

```bash
# Start daemon
agent-relay start -f

# Wrap multiple agents (3 terminals)
agent-relay wrap "claude"      # -> GreenLake
agent-relay wrap "codex"       # -> BlueRiver
agent-relay wrap "gemini-cli"  # -> RedMountain

# Any agent can message others:
# @relay:BlueRiver Can you handle the database migration?
# @relay:* I'm starting on the frontend components
```

> **More examples:** See the [`examples/`](./examples) directory for complete working examples including setup scripts.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  Claude Agent   │     │  Codex Agent    │     │  Gemini Agent   │
│  (Terminal 1)   │     │  (Terminal 2)   │     │  (Terminal 3)   │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
    ┌────┴────┐             ┌────┴────┐             ┌────┴────┐
    │ Wrapper │             │ Wrapper │             │ Wrapper │
    └────┬────┘             └────┬────┘             └────┬────┘
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    Unix Domain Socket
                                 │
                    ┌────────────┴────────────┐
                    │     agent-relay daemon   │
                    │   - Message Router       │
                    │   - Topic Subscriptions  │
                    │   - Game Coordinator     │
                    └─────────────────────────┘
```

## Agent Communication Syntax

Agents communicate using two formats embedded in their terminal output:

### Inline Format (single line)
```
@relay:BlueFox Your turn to play the 7 of hearts
@relay:* Broadcasting to all agents
@thinking:* I'm considering playing the Queen...
```

### Block Format (structured JSON)
```
[[RELAY]]
{
  "to": "BlueFox",
  "type": "action",
  "body": "Playing my card",
  "data": { "card": "7♥", "action": "play_card" }
}
[[/RELAY]]
```

### Escaping
To output literal `@relay:` without triggering the parser:
```
\@relay: This won't be parsed as a command
```

## CLI Commands

```bash
# Start the relay daemon (foreground)
npx agent-relay start -f

# Start daemon with custom socket path
npx agent-relay start -s /tmp/my-relay.sock

# Stop the daemon
npx agent-relay stop

# Wrap an agent (name auto-generated)
npx agent-relay wrap "claude"

# Wrap an agent with explicit name
npx agent-relay wrap -n my-agent "claude"

# Wrap with legacy PTY mode (if needed)
npx agent-relay wrap --pty -n PlayerX "claude"

# Check status
npx agent-relay status

# Send a test message
npx agent-relay send -t recipient -m "Hello"
```

### Tmux Mode (Default)

By default, `agent-relay wrap` uses tmux mode for better stability in multi-agent coordination:

```bash
# Terminal 1: Start daemon
agent-relay start -f

# Terminal 2: Start first agent (tmux mode is default)
agent-relay wrap -n PlayerX "claude"

# Terminal 3: Start second agent
agent-relay wrap -n PlayerO "codex"
```

**How it works:**
- Creates a detached tmux session for each agent
- Attaches your terminal directly to the session
- Background polling captures output and parses `@relay:` commands
- Incoming messages are injected via `tmux send-keys`

**Scrolling:** Mouse mode is enabled by default - scroll wheel passes through to the CLI app. Use `--no-mouse` to disable.

**CLI-specific handling:**
- **Gemini CLI** - Messages shown via echo to avoid command interpretation
- **Claude/Codex** - Standard message injection

**Tuning flags:**
- `-q, --quiet` - Silence debug logs
- `--no-mouse` - Disable mouse passthrough
- `--cli-type <type>` - Force CLI type (claude, codex, gemini, other)
- `--inject-idle-ms <ms>` - Idle time before injecting (default 1500ms)

**Legacy modes:**
```bash
agent-relay wrap --pty -n MyAgent "claude"  # Direct PTY mode
```

### File-Based Inbox Commands

For scenarios where PTY wrapping isn't ideal (scripts, automation, or agents that read files):

```bash
# Write to an agent's inbox (supports broadcast with *)
agent-relay inbox-write -t AgentName -f SenderName -m "Your message" -d /tmp/my-dir
agent-relay inbox-write -t "*" -f SenderName -m "Broadcast!" -d /tmp/my-dir

# Read an agent's inbox (non-blocking)
agent-relay inbox-read -n AgentName -d /tmp/my-dir
agent-relay inbox-read -n AgentName -d /tmp/my-dir --clear  # Clear after reading

# Block until inbox has messages (useful for agent loops)
agent-relay inbox-poll -n AgentName -d /tmp/my-dir --clear
agent-relay inbox-poll -n AgentName -d /tmp/my-dir -t 30    # 30s timeout

# List all agents in a data directory
agent-relay inbox-agents -d /tmp/my-dir
```

**Inbox message format:**
```markdown
## Message from SenderName | 2024-01-15T10:30:00Z
Your message content here
```

### Team Commands

For coordinating multiple agents working together on a project:

```bash
# Initialize a team workspace
agent-relay team-init -d /tmp/my-team -p /path/to/project -n "my-team"

# Set up a complete team from JSON config
agent-relay team-setup -f team-config.json -d /tmp/my-team

# Add an agent to the team
agent-relay team-add -n AgentName -r "Role description" -d /tmp/my-team

# List all agents in the team
agent-relay team-list -d /tmp/my-team

# Show team status with message counts
agent-relay team-status -d /tmp/my-team

# Send a message to teammate(s)
agent-relay team-send -n SenderName -t RecipientName -m "Hello" -d /tmp/my-team
agent-relay team-send -n SenderName -t "*" -m "Broadcast" -d /tmp/my-team

# Check your inbox (blocking wait)
agent-relay team-check -n AgentName -d /tmp/my-team
agent-relay team-check -n AgentName -d /tmp/my-team --no-wait  # Non-blocking

# Join an existing team (self-register)
agent-relay team-join -n AgentName -r "Role" -d /tmp/my-team

# Start team with auto-spawning
agent-relay team-start -f team-config.json -d /tmp/my-team
```

**Team config JSON format:**
```json
{
  "name": "my-project",
  "project": "/path/to/project",
  "agents": [
    {"name": "Architect", "cli": "claude", "role": "Design Lead", "tasks": ["Design system"]}
  ]
}
```

### Supervisor Commands (Advanced)

The supervisor is for **spawn-per-message** workflows - spawning an agent process when a message arrives, then it exits. This is different from the tmux wrapper which keeps agents running continuously.

**When to use supervisor:**
- Agents that can't run continuously (batch processing)
- Cost-conscious setups (no idle agents)
- One-shot task processing

**When to use tmux wrapper instead:**
- Real-time collaboration
- Interactive agents (Claude Code)
- Continuous monitoring

```bash
agent-relay supervisor -d /tmp/relay --detach   # Start in background
agent-relay register -n AgentName -c "claude"   # Register an agent
agent-relay supervisor-status                    # Check status
```

### Dashboard

Web-based dashboard for monitoring agent communication:

```bash
# Start dashboard on default port (3888)
agent-relay dashboard -d /tmp/my-team

# Start on custom port
agent-relay dashboard -p 8080 -d /tmp/my-team
```

### Games

```bash
# Set up tic-tac-toe for two agents
agent-relay tictactoe-setup -d /tmp/ttt --player-x AgentX --player-o AgentO
```

## Playing Hearts

> **Note:** The Hearts game engine (`src/games/hearts.ts`) is implemented but not yet wired to the CLI. The code below shows the intended usage pattern once CLI integration is complete.

```bash
# Terminal 1: Start daemon
npx agent-relay start -f

# Terminal 2-5: Start four agent players (names auto-generated)
npx agent-relay wrap "claude"      # -> GoldenEagle
npx agent-relay wrap "codex"       # -> SilverWolf
npx agent-relay wrap "gemini-cli"  # -> CrystalLake
npx agent-relay wrap "claude"      # -> BronzeBear

# Game coordinator integration coming soon
```

Each agent receives game state and prompts:
```json
{
  "kind": "your_turn",
  "hand": ["2♣", "7♥", "K♠", ...],
  "valid_plays": ["2♣"],
  "current_trick": [],
  "hearts_broken": false
}
```

Agents respond with:
```
[[RELAY]]
{"to": "hearts-coordinator", "type": "action", "data": {"action": "play_card", "card": {"suit": "clubs", "rank": "2"}}}
[[/RELAY]]
```

---

<details>
<summary><h2>For Agents (Click to expand)</h2></summary>

> **This section is specifically for AI agents setting up agent-relay autonomously.**

## Autonomous Setup Instructions

If you are an AI agent and need to set up agent-relay for inter-agent communication, follow these steps:

### Quick Setup (One Command)

```bash
# Install and start daemon in one command
AGENT_RELAY_START=true AGENT_RELAY_QUIET=true \
  curl -fsSL https://raw.githubusercontent.com/khaliqgant/agent-relay/main/install.sh | bash
```

The installer outputs machine-readable variables:
```
AGENT_RELAY_STATUS=SUCCESS
AGENT_RELAY_INSTALL_DIR=/home/user/.agent-relay
AGENT_RELAY_BIN_PATH=/home/user/.local/bin/agent-relay
AGENT_RELAY_DAEMON_PID=12345
```

### Manual Setup (Step by Step)

#### 1. Check Prerequisites

```bash
# Verify Node.js >= 18 (>= 20 recommended)
node --version

# Verify npm
npm --version
```

#### 2. Clone and Install

```bash
# If not already in the project directory
cd /path/to/agent-to-agent-communication

# Install dependencies
npm install

# Build the project
npm run build
```

#### 3. Start the Daemon

```bash
# Start in background (recommended for automation)
nohup npx agent-relay start -f > /tmp/agent-relay.log 2>&1 &

# Or start in foreground if you want to monitor
npx agent-relay start -f
```

#### 4. Verify Daemon is Running

```bash
# Check status
npx agent-relay status

# Should output: Status: RUNNING
```

### 5. Connect as an Agent

If you're wrapping another agent (name auto-generated):
```bash
npx agent-relay wrap "claude"
# Your agent name will be displayed, e.g., "Agent name: SwiftFalcon"
```

Or specify your own name:
```bash
npx agent-relay wrap -n MyAgent "claude"
```

If you're connecting programmatically:
```typescript
import { RelayClient, generateAgentName } from 'agent-relay';

// Auto-generate a name
const agentName = generateAgentName(); // e.g., "BraveOtter"

const client = new RelayClient({
  agentName,
  socketPath: '/tmp/agent-relay.sock',
});

await client.connect();

// Send messages
client.sendMessage('other-agent', 'Hello!', 'message');

// Listen for messages
client.onMessage = (from, payload) => {
  console.log(`Message from ${from}: ${payload.body}`);
};
```

## Communication Protocol for Agents

### Sending Messages

Use these patterns in your terminal output:

**Direct message to another agent:**
```
@relay:SwiftFalcon Your message here
```

**Broadcast to all agents:**
```
@relay:* Message for everyone
```

**Structured action (for games/coordination):**
```
[[RELAY]]
{"to": "*", "type": "action", "body": "description", "data": {"key": "value"}}
[[/RELAY]]
```

### Message Types

| Type | Use Case |
|------|----------|
| `message` | General communication |
| `action` | Game moves, commands |
| `state` | State updates, game state |
| `thinking` | Share reasoning (optional) |

### Receiving Messages

Messages from other agents appear in your terminal as:
```
[MSG] from SwiftFalcon: Their message
```

Or for thinking:
```
[THINKING] from SwiftFalcon: Their reasoning
```

## Coordination Patterns

### Turn-Based Games

1. Subscribe to game topic: `client.subscribe('hearts')`
2. Wait for `your_turn` state message
3. Respond with action: `@relay:coordinator {"action": "play_card", ...}`
4. Wait for next state update

### Collaborative Tasks

1. Broadcast availability: `@relay:* Ready to collaborate`
2. Direct message coordinator: `@relay:coordinator Taking task X`
3. Share progress: `@relay:* Completed task X`

### Error Handling

If connection fails:
1. Check daemon is running: `npx agent-relay status`
2. Check socket exists: `ls -la /tmp/agent-relay.sock`
3. Restart daemon if needed: `npx agent-relay stop && npx agent-relay start -f`

## Example: Agent Self-Registration

```typescript
import { RelayClient, generateAgentName } from 'agent-relay';

async function setupAgent() {
  const name = generateAgentName();
  const client = new RelayClient({ agentName: name });

  try {
    await client.connect();
    console.log(`Connected as ${name}`);

    // Announce presence
    client.broadcast(`${name} is online`, 'message');

    // Handle incoming messages
    client.onMessage = (from, payload) => {
      if (payload.body.includes('ping')) {
        client.sendMessage(from, 'pong', 'message');
      }
    };

    return client;
  } catch (err) {
    console.error('Failed to connect:', err);
    throw err;
  }
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Socket not found" | Start daemon: `npx agent-relay start -f` |
| "Connection refused" | Check daemon logs: `cat /tmp/agent-relay.log` |
| Messages not received | Verify agent name matches |
| High latency | Check system load, restart daemon |

## Socket Path

Default: `/tmp/agent-relay.sock`

Custom: Use `-s` flag or `socketPath` config option.

</details>

---

## Protocol Specification

See [PROTOCOL.md](./docs/PROTOCOL.md) for the complete wire protocol specification including:
- Frame format (4-byte length prefix + JSON)
- Message types (HELLO, SEND, DELIVER, ACK, etc.)
- Handshake flow
- Reconnection and state sync (spec defined, implementation pending)
- Backpressure handling (spec defined, implementation pending)

**Current implementation status:** The daemon provides best-effort message delivery with per-stream ordering. The protocol supports ACKs, retries, and RESUME/SYNC for reconnection, but these reliability features are optional and not yet fully wired in the current implementation.

## Acknowledgments

This project stands on the shoulders of giants:

- **[mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)** by Jeff Emanuel - Pioneered many patterns we adopted, including auto-generated AdjectiveNoun names, and demonstrated the power of persistent agent communication.
- **[swarm-tools](https://github.com/joelhooks/swarm-tools)** by Joel Hooks - Showed how swarm coordination patterns can enable powerful multi-agent workflows.

If MCP integration or file-based persistence fits your use case better, we highly recommend checking out these projects.

## Troubleshooting

### `node-pty` / `better-sqlite3` native module errors

If you see errors like `NODE_MODULE_VERSION ...` or `compiled against a different Node.js version`, rebuild native deps:

```bash
npm rebuild better-sqlite3
npm rebuild node-pty
```

### `listen EPERM: operation not permitted`

If your environment restricts creating sockets under `/tmp` (some sandboxes/containers do), pick a socket path you can write to:

```bash
agent-relay start -f -s ./agent-relay.sock
```

### Messages not appearing

1. Check daemon is running: `agent-relay status`
2. Check socket exists: `ls -la /tmp/agent-relay/<project-id>/relay.sock`
3. Verify agents are using the same project paths: `agent-relay project`
4. Restart daemon: `agent-relay stop && agent-relay start -f`

### Scrolling not working in tmux

By default, mouse mode is enabled for scroll passthrough. If scrolling still doesn't work:

1. Check your terminal emulator settings (iTerm2, Terminal.app, etc.)
2. Use `--no-mouse` flag to disable tmux mouse mode
3. Use tmux copy mode: `Ctrl+b` then `[`, scroll with arrows, `q` to exit

### Gemini CLI interpreting messages as commands

Gemini CLI has special handling. If issues persist:

```bash
agent-relay wrap --cli-type gemini -n MyGemini "gemini-cli"
```

### Project paths confusion

If agents can't find each other, they may be using different project paths:

```bash
# Check current project paths
agent-relay project

# List all known projects
agent-relay project --list

# Force global paths (not recommended)
agent-relay start --global
```

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

## License

MIT
