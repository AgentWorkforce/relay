# agent-relay

> Real-time messaging between AI agents. Sub-5ms latency, any CLI, any language.

[![npm](https://img.shields.io/npm/v/agent-relay)](https://www.npmjs.com/package/agent-relay)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/AgentWorkforce/relay/main/install.sh | bash
```

Or via npm (requires Node.js 18+):

```bash
npm install -g agent-relay
```

## Quick Start

```bash
agent-relay up --dashboard
```

Open **http://localhost:3888** to spawn agents, view real-time status, and stream logs.

---

## CLI Reference

| Command                                 | Description              |
| --------------------------------------- | ------------------------ |
| `agent-relay up`                        | Start broker + dashboard |
| `agent-relay down`                      | Stop broker              |
| `agent-relay spawn <name> <cli> "task"` | Spawn a worker agent     |
| `agent-relay status`                    | Check broker status      |

---

## SDK Usage

```bash
npm install @agent-relay/sdk
```

### Agent-to-Agent Messaging

```typescript
import { AgentRelay, Models } from '@agent-relay/sdk';

const relay = new AgentRelay();

// Spawn agents with different CLIs and models
const planner = await relay.claude.spawn({
  name: 'Planner',
  model: Models.Claude.OPUS
});

const coder = await relay.codex.spawn({
  name: 'Coder',
  model: Models.Codex.CODEX_5_3
});

// Send messages between agents
await planner.sendMessage({ to: 'Coder', text: 'Implement the auth module' });

// Listen for messages
relay.onMessageReceived = (msg) => {
  console.log(`${msg.from} → ${msg.to}: ${msg.text}`);
};

await relay.shutdown();
```

### Multi-Agent Workflows

Build workflows with different swarm patterns:

```typescript
import { workflow, Models, SwarmPatterns } from '@agent-relay/sdk/workflows';

// Hub-spoke: Lead coordinates workers
const result = await workflow('feature-build')
  .pattern(SwarmPatterns.HUB_SPOKE)
  .agent('lead', { cli: 'claude', model: Models.Claude.OPUS, role: 'Coordinator' })
  .agent('dev1', { cli: 'codex', model: Models.Codex.CODEX_5_3, role: 'Developer' })
  .agent('dev2', { cli: 'cursor', model: Models.Cursor.CLAUDE_SONNET, role: 'Developer' })
  .step('plan', { agent: 'lead', task: 'Break down the feature into tasks' })
  .step('impl1', { agent: 'dev1', task: 'Implement backend', dependsOn: ['plan'] })
  .step('impl2', { agent: 'dev2', task: 'Implement frontend', dependsOn: ['plan'] })
  .step('review', { agent: 'lead', task: 'Review and merge', dependsOn: ['impl1', 'impl2'] })
  .run();
```

**Swarm Patterns:**

| Pattern       | Description                                    |
| ------------- | ---------------------------------------------- |
| `hub-spoke`   | Central coordinator distributes tasks          |
| `dag`         | Directed acyclic graph with dependencies       |
| `fan-out`     | Parallel execution across multiple agents      |
| `pipeline`    | Sequential processing through stages           |
| `consensus`   | Agents reach agreement before proceeding       |
| `mesh`        | Fully connected peer-to-peer communication     |

---

## Cloud

For team collaboration across machines, use [agent-relay cloud](https://agent-relay.com):

```bash
agent-relay cloud link      # Link your machine
agent-relay cloud agents    # List agents across machines
agent-relay cloud send AgentName "Your message"
```

---

## License

Apache-2.0 — Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Documentation](https://docs.agent-relay.com/) · [Issues](https://github.com/AgentWorkforce/relay/issues) · [Cloud](https://agent-relay.com) · [Discord](https://discord.gg/6E6CTxM8um)
