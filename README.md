# agent-relay

[![CI](https://github.com/khaliqgant/agent-relay/actions/workflows/test.yml/badge.svg)](https://github.com/khaliqgant/agent-relay/actions/workflows/test.yml)
[![codecov](https://codecov.io/gh/khaliqgant/agent-relay/branch/main/graph/badge.svg)](https://codecov.io/gh/khaliqgant/agent-relay)

Real-time agent-to-agent communication system. Enables AI agents (Claude, Codex, Gemini, etc.) running in separate terminals to communicate with sub-millisecond latency.

## Installation

### One-Line Install (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/khaliqgant/agent-relay/main/install.sh | bash
```

This installs to `~/.agent-relay` and adds `agent-relay` to your PATH.

### Install Options

```bash
# Custom install directory
AGENT_RELAY_DIR=/opt/agent-relay curl -fsSL https://...install.sh | bash

# Install and start daemon immediately
AGENT_RELAY_START=true curl -fsSL https://...install.sh | bash

# Quiet mode (for agents/scripts)
AGENT_RELAY_QUIET=true curl -fsSL https://...install.sh | bash
```

### Manual Install

```bash
git clone https://github.com/khaliqgant/agent-relay.git
cd agent-relay
npm install
npm run build
```

### Requirements

- Node.js >= 18 (20+ recommended)
- macOS or Linux (Unix domain sockets)

## Troubleshooting

### `node-pty` / native module errors

If you see errors like `NODE_MODULE_VERSION ...` or `compiled against a different Node.js version`, rebuild native deps:

```bash
npm rebuild node-pty
```

### `listen EPERM: operation not permitted`

If your environment restricts creating sockets under `/tmp` (some sandboxes/containers do), pick a socket path you can write to:

```bash
npx agent-relay start -f -s ./agent-relay.sock
```

## Why We Built This

As AI agents become more capable, there's a growing need for them to collaborate in real-time. Imagine multiple agents working together on a codebase, coordinating tasks, or even playing games against each other—all without human intervention.

**The problem:** How do you get agents running in separate terminal sessions to talk to each other seamlessly?

## For Humans: When You’d Use agent-relay

Use agent-relay when you want **fast, local, real-time coordination** between multiple CLI-based agents without adopting a larger framework.

Common scenarios:
- **Multi-terminal agent swarms** where each agent runs in its own terminal and needs to exchange messages quickly.
- **Turn-based / tight-loop coordination** (games, schedulers, orchestrators) where polling latency becomes noticeable.
- **“Wrap anything” workflows** where you don’t control the agent implementation but you can run it as a CLI process.

Tradeoffs to know up front:
- Local IPC only (Unix domain sockets); no cross-host networking.
- Best-effort delivery today (no persistence/guaranteed retries yet).

### Existing Solutions (and why they're great)

We built agent-relay with deep respect for existing solutions that inspired this work:

#### [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
A thoughtful MCP-based agent communication system. Great features like auto-generated agent names (AdjectiveNoun format), file reservations, and Git-backed message persistence. If you're already in the MCP ecosystem, this is an excellent choice.

**Why choose agent-relay over mcp_agent_mail:** When you specifically want **low-latency, real-time, local IPC** and a **PTY wrapper** that can intercept output from *any* CLI agent without requiring MCP integration.

**Why choose mcp_agent_mail instead:** When you want **message persistence/auditability**, **file reservations**, and a workflow already built around MCP-style tooling.

#### [swarm-tools/swarm-mail](https://github.com/joelhooks/swarm-tools/tree/main/packages/swarm-mail)
Part of the swarm-tools ecosystem, providing inter-agent messaging. Well-designed for swarm coordination patterns.

**Why choose agent-relay over swarm-mail:** When you want **push-style delivery** and sub-second responsiveness; file-based polling can be great for robustness, but it’s not ideal for tight coordination loops.

**Why choose swarm-mail instead:** When you prefer **filesystem-backed messaging** (easy inspection, simple operations) and millisecond-level latency isn’t a requirement.

### Our Approach

agent-relay takes a different path:
- **Unix domain sockets** for sub-5ms latency
- **PTY wrapper** that works with any CLI (Claude, Codex, Gemini, etc.)
- **No protocol dependencies** - just wrap your command and go
- **Pattern detection** in terminal output (`@relay:` syntax)
- **Built-in game support** as a proof-of-concept for real-time coordination

## Features

- **Real-time messaging** via Unix domain sockets (<5ms latency)
- **PTY wrapper** for any CLI agent (Claude Code, Codex CLI, Gemini CLI)
- **Auto-generated agent names** (AdjectiveNoun format, like mcp_agent_mail)
- **Best-effort delivery** with per-stream ordering (ACK protocol defined, reliability optional)
- **Topic-based pub/sub** for game coordination and channels
- **Hearts game engine** as proof-of-concept for multi-agent interaction (see `src/games/hearts.ts`)

## Quick Start

### Option 1: One-Line Install (Recommended)

```bash
# Install agent-relay
curl -fsSL https://raw.githubusercontent.com/khaliqgant/agent-relay/main/install.sh | bash

# Start the daemon
agent-relay start -f

# In another terminal, wrap an agent (name auto-generated)
agent-relay wrap "claude"
# Output: Agent name: SilverMountain

# In another terminal, wrap another agent
agent-relay wrap "codex"
# Output: Agent name: BlueFox
```

### Option 2: From Source

```bash
git clone https://github.com/khaliqgant/agent-relay.git
cd agent-relay
npm install && npm run build

# Start the daemon
npx agent-relay start -f

# In another terminal, wrap an agent
npx agent-relay wrap "claude"
```

### Sending Messages Between Agents

Once agents are wrapped, they can send messages to each other:

```bash
# Direct message (from agent terminal)
@relay:BlueFox Hello from SilverMountain!

# Broadcast to all agents
@relay:* Anyone online?

# Messages appear in recipient's terminal as:
# [MSG] from SilverMountain: Hello from SilverMountain!
```

### Enable Your Agents

Copy [`AGENTS.md`](./AGENTS.md) to your project so AI agents know how to use agent-relay:

```bash
curl -fsSL https://raw.githubusercontent.com/khaliqgant/agent-relay/main/AGENTS.md > AGENTS.md
```

This file contains instructions that AI agents can read to learn how to send/receive messages.

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

**Tuning flags:**
- `-q, --quiet` to silence debug logs (stderr)
- `--log-interval <ms>` to throttle debug output
- `--inject-idle-ms <ms>` to change the idle window before injecting messages (default 1500ms)
- `--inject-retry-ms <ms>` to adjust how often we re-check for an idle window (default 500ms)

**Legacy PTY mode:**
If you need the old direct PTY mode, use the `--pty` flag:
```bash
agent-relay wrap --pty -n MyAgent "claude"
```

**Scrolling in tmux:**

By default, scroll wheel is sent to the application inside tmux. To scroll through history:

1. **Enter copy mode**: Press `Ctrl+b` then `[`
2. Scroll with arrow keys, Page Up/Down, or mouse wheel
3. Press `q` to exit copy mode

**Or enable mouse scrolling** (add to `~/.tmux.conf`):
```bash
set -g mouse on
```

Then reload: `tmux source-file ~/.tmux.conf`

**Compatibility:** Works with any CLI that accepts text input (Claude, Codex, Gemini, etc.)

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

### Supervisor Commands

For spawn-per-message agent management:

```bash
# Run the supervisor (foreground)
agent-relay supervisor -d /tmp/relay -v

# Run supervisor in background
agent-relay supervisor -d /tmp/relay --detach

# Check supervisor status
agent-relay supervisor-status

# Stop background supervisor
agent-relay supervisor-stop

# Register an agent with supervisor
agent-relay register -n AgentName -c "claude" -d /tmp/relay
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

See [PROTOCOL.md](./PROTOCOL.md) for the complete wire protocol specification including:
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
