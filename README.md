# agent-relay

> Real-time messaging between AI agents. Sub-5ms latency, any CLI, any language.

[![npm](https://img.shields.io/npm/v/agent-relay)](https://www.npmjs.com/package/agent-relay)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

---

## Install

**Quick install (recommended - no Node.js required!):**

```bash
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

This downloads a standalone binary that works without any dependencies.

**Or via npm:**

```bash
npm install -g agent-relay
```

_The npm method requires Node.js 18+_

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

| Command                                 | Description                                              |
| --------------------------------------- | -------------------------------------------------------- |
| `agent-relay <cli>`                     | Start broker + coordinator (claude, codex, gemini, etc.) |
| `agent-relay up`                        | Start broker + dashboard                                 |
| `agent-relay down`                      | Stop broker                                              |
| `agent-relay status`                    | Check broker status                                      |
| `agent-relay spawn <name> <cli> "task"` | Spawn a worker agent                                     |
| `agent-relay bridge <projects...>`      | Bridge multiple projects                                 |
| `agent-relay doctor`                    | Diagnose issues                                          |

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

Names automatically match roles (case-insensitive). Create agents using either method:

**Option A: Dashboard (recommended for interactive use)**

1. Open http://localhost:3888
2. Click "Spawn Agent"
3. Enter name "Lead" and select CLI "claude"

**Option B: CLI (for scripting/automation)**

```bash
agent-relay spawn Lead claude "Your task instructions"
```

Agents with matching names automatically assume the corresponding role from your `.claude/agents/` directory.

## Multi-Project Bridge

Orchestrate agents across repositories:

```bash
# Start daemons in each project
cd ~/auth && agent-relay up
cd ~/frontend && agent-relay up

# Bridge from anywhere
agent-relay bridge ~/auth ~/frontend ~/api
```

Cross-project messaging uses `project:agent` format via MCP tools:

```
relay_send(to: "auth:Lead", message: "Please review the token refresh logic")
```

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

## For Agents

Paste this into your LLM agent session:

```bash
curl -s https://raw.githubusercontent.com/AgentWorkforce/relay/main/docs/guide/agent-setup.md
```

Or read the full [Agent Setup Guide](./docs/guide/agent-setup.md).

## Using the Agent Relay SDK

The easiest way to develop against relay:

```bash
# Install globally and start broker
npm install -g agent-relay
agent-relay up

# In your project
npm install @agent-relay/sdk
```

```typescript
import { AgentRelayClient } from '@agent-relay/sdk';

const client = await AgentRelayClient.start({ env: process.env });

// Spawn a worker agent
await client.spawnPty({ name: 'Worker', cli: 'claude', channels: ['general'] });

// List connected agents
const agents = await client.listAgents();
console.log(agents);

// Release and shut down
await client.release('Worker');
await client.shutdown();
```

---

## Philosophy

> **Do one thing well:** Real-time agent messaging with sub-5ms latency.

agent-relay is a messaging layer, not a framework. It works with any CLI tool, any orchestration system, and any memory layer.

---

## License

Apache-2.0 — Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Documentation](https://docs.agent-relay.com/) · [Issues](https://github.com/AgentWorkforce/relay/issues) · [Cloud](https://agent-relay.com) · [Discord](https://discord.gg/6E6CTxM8um)
