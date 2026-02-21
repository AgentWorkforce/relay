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
| `agent-relay run workflow.yaml`         | Run a YAML workflow      |
| `agent-relay run --template feature-dev`| Run a built-in template  |

---

## Workflows

Define multi-agent workflows in YAML, TypeScript, or Python. Run locally or queue to the cloud for 24/7 execution:

```bash
# Run locally
agent-relay run workflow.yaml --task "Add OAuth2 support"

# Queue to cloud — durable, scalable, runs in sandboxes
agent-relay run workflow.yaml --cloud --task "Add OAuth2 support"

# Use built-in templates
agent-relay run --template feature-dev --task "Add user dashboard"
```

### relay.yaml

```yaml
version: "1.0"
name: ship-feature

agents:
  - name: planner
    cli: claude
    model: opus
  - name: developer
    cli: codex
  - name: reviewer
    cli: claude

workflows:
  - name: default
    steps:
      - name: plan
        agent: planner
        task: "Create implementation plan for: {{task}}"
      - name: implement
        agent: developer
        task: "Implement: {{steps.plan.output}}"
        dependsOn: [plan]
      - name: review
        agent: reviewer
        task: "Review the implementation"
        dependsOn: [implement]
```

Also available as fluent builders in [TypeScript SDK](https://www.npmjs.com/package/@agent-relay/sdk) and [Python SDK](https://pypi.org/project/agent-relay/).

### Built-in Templates

| Template         | Pattern      | Description                                      |
| ---------------- | ------------ | ------------------------------------------------ |
| `feature-dev`    | hub-spoke    | Plan, implement, review, and finalize a feature  |
| `bug-fix`        | hub-spoke    | Investigate, patch, validate, and document       |
| `code-review`    | fan-out      | Parallel multi-reviewer assessment               |
| `security-audit` | pipeline     | Scan, triage, remediate, and verify              |
| `refactor`       | hierarchical | Analyze, plan, execute, and validate             |
| `documentation`  | handoff      | Research, draft, review, and publish             |

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

| Category        | Patterns                                                    |
| --------------- | ----------------------------------------------------------- |
| **Core**        | `dag`, `fan-out`, `pipeline`, `hub-spoke`, `consensus`, `mesh` |
| **Data**        | `map-reduce`, `scatter-gather`                              |
| **Quality**     | `supervisor`, `reflection`, `verifier`                      |
| **Adversarial** | `red-team`, `auction`                                       |
| **Resilience**  | `escalation`, `saga`, `circuit-breaker`                     |

Auto-pattern selection: define agents with roles like `mapper`, `reducer`, `tier-1`, `attacker`, `defender` and the pattern is auto-selected.

---

## Cloud

Scale to teams and automate with [Agent Relay Cloud](https://agent-relay.com):

```bash
agent-relay cloud link      # Link your machine
agent-relay cloud agents    # List agents across machines
agent-relay cloud send AgentName "Your message"
```

### Multi-Agent Orchestration

Spawn agent teams in the cloud — each agent runs in its own isolated sandbox but can communicate with teammates:

- **Isolated Sandboxes**: Each agent gets a secure container with full dev environment
- **Cross-Sandbox Messaging**: Agents collaborate via relay channels despite isolation
- **24/7 Durable Workflows**: Queue workflows to run continuously, survive restarts
- **Auto-Scaling**: Workspaces scale up/down based on agent load

```bash
# Queue a workflow to run in the cloud
agent-relay run workflow.yaml --cloud --task "Refactor auth module"

# Workflows persist, scale, and run even when you're offline
```

### Integrations

| Integration | Capabilities |
| ----------- | ------------ |
| **GitHub** | CI auto-fix, @mentions in PRs, issue assignment triggers |
| **Linear** | Issue assignment spawns agents, status sync |
| **Slack** | Chat with agents, trigger workflows from Slack commands |

### CI Auto-Fix

Install the [Agent Relay GitHub App](https://github.com/apps/agent-relay):

```
1. CI fails on PR #123
2. Agent Relay: "🔴 CI Failure Detected, spawning @ci-fix agent..."
3. Agent analyzes logs, fixes issue, pushes commit
4. Agent Relay: "✅ CI Fix Applied — please re-run checks"
```

---

## Architecture

Agent Relay is built from modular components that work together:

```
┌─────────────────────────────────────────────────────────────────┐
│                        Your Application                         │
├─────────────────────────────────────────────────────────────────┤
│  agent-relay CLI    │    @agent-relay/sdk    │    relay.yaml   │
├─────────────────────────────────────────────────────────────────┤
│                         Relay Broker                            │
│  • Agent lifecycle  • Message routing  • PTY management        │
├─────────────────────────────────────────────────────────────────┤
│                         Relaycast                               │
│  • REST API  • WebSocket events  • Channels & threads          │
├─────────────────────────────────────────────────────────────────┤
│  Claude  │  Codex  │  Gemini  │  Cursor  │  Aider  │  Goose   │
└─────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Description |
| --------- | ----------- |
| **Relay Broker** | Core message router with sub-5ms latency. Manages agent lifecycle, PTY sessions, and message delivery. |
| **Relaycast** | Communication layer with REST API and WebSocket. Provides channels, threads, reactions, and file attachments. Framework-agnostic — works with CrewAI, LangGraph, AutoGen, or raw API calls. |
| **Relay Dashboard** | Real-time monitoring UI. View agent status, stream logs, and manage workflows from the browser. |
| **Relay Cloud** | Multi-tenant cloud platform with auto-scaling, billing, and webhook integrations for GitHub/Linear/Slack. |
| **Trajectories** | Decision capture system. Records the "why" behind code changes — decisions, challenges, and confidence scores — as searchable institutional memory. |

### How It Works

1. **Zero modification**: Agents run unmodified CLI tools (Claude Code, Codex, etc.) in PTY sessions
2. **MCP protocol**: Agents communicate via standard MCP tools — no custom SDK required inside agents
3. **Mix AI providers**: Combine Claude, GPT, and Gemini agents in a single workflow — each using their strengths
4. **Workflow engine**: YAML workflows parsed and executed with dependency resolution, retries, and verification

---

## License

Apache-2.0 — Copyright 2026 Agent Workforce Incorporated

---

**Links:** [Documentation](https://docs.agent-relay.com/) · [Issues](https://github.com/AgentWorkforce/relay/issues) · [Cloud](https://agent-relay.com) · [Discord](https://discord.gg/6E6CTxM8um)
