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

Install the SDK:

```bash
npm install @agent-relay/sdk
```

### Agent-to-Agent Messaging

```typescript
import { AgentRelay } from '@agent-relay/sdk';

const relay = new AgentRelay();

// Spawn agents with different CLIs and models
const claude = await relay.claude.spawn({
  name: 'Planner',
  model: 'claude-sonnet-4-20250514'
});

const codex = await relay.codex.spawn({
  name: 'Coder',
  model: 'o3'
});

// Send messages between agents
await claude.sendMessage({ to: 'Coder', text: 'Implement the auth module' });

// Listen for messages
relay.onMessageReceived = (msg) => {
  console.log(`${msg.from} → ${msg.to}: ${msg.text}`);
};

// Clean up
await relay.shutdown();
```

### Workflows

Run multi-agent workflows with dependency management:

```typescript
import { workflow } from '@agent-relay/sdk/workflows';

const result = await workflow('feature-dev')
  .agent('architect', { cli: 'claude', role: 'System architect', model: 'claude-sonnet-4-20250514' })
  .agent('developer', { cli: 'codex', role: 'Developer', model: 'o3' })
  .agent('reviewer', { cli: 'claude', role: 'Code reviewer' })
  .step('design', { agent: 'architect', task: 'Design the API' })
  .step('implement', { agent: 'developer', task: 'Implement the design', dependsOn: ['design'] })
  .step('review', { agent: 'reviewer', task: 'Review the code', dependsOn: ['implement'] })
  .run();
```

Built-in workflow templates: `feature-dev`, `bug-fix`, `code-review`, `security-audit`, `refactor`, `documentation`

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
