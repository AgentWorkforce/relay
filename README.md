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
  model: Models.Codex.O3
});

// Send messages between agents
await planner.sendMessage({ to: 'Coder', text: 'Implement the auth module' });

// Listen for messages
relay.onMessageReceived = (msg) => {
  console.log(`${msg.from} → ${msg.to}: ${msg.text}`);
};

await relay.shutdown();
```

### Built-in Workflow Templates

Run pre-configured multi-agent workflows:

```typescript
import { TemplateRegistry, WorkflowRunner } from '@agent-relay/sdk/workflows';

const registry = new TemplateRegistry();
const config = await registry.loadTemplate('feature-dev');

const runner = new WorkflowRunner();
const result = await runner.execute(config, undefined, {
  task: 'Add WebSocket support to the API'
});
```

**Built-in templates:**

| Template           | Pattern    | Agents                              |
| ------------------ | ---------- | ----------------------------------- |
| `feature-dev`      | hub-spoke  | lead, planner, developer, reviewer  |
| `bug-fix`          | dag        | investigator, fixer, verifier       |
| `code-review`      | fan-out    | lead, reviewers (security, quality) |
| `security-audit`   | pipeline   | scanner, analyzer, reporter         |
| `refactor`         | dag        | analyzer, refactorer, tester        |
| `documentation`    | fan-out    | writer, reviewer                    |

### Custom Workflows

Build workflows programmatically:

```typescript
import { workflow, Models } from '@agent-relay/sdk/workflows';

const result = await workflow('my-pipeline')
  .pattern('dag')
  .agent('architect', { cli: 'claude', model: Models.Claude.OPUS, role: 'System architect' })
  .agent('developer', { cli: 'codex', model: Models.Codex.O3, role: 'Developer' })
  .agent('reviewer', { cli: 'claude', model: Models.Claude.SONNET, role: 'Code reviewer' })
  .step('design', { agent: 'architect', task: 'Design the API' })
  .step('implement', { agent: 'developer', task: 'Implement the design', dependsOn: ['design'] })
  .step('review', { agent: 'reviewer', task: 'Review the code', dependsOn: ['implement'] })
  .run();
```

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
