# @agent-relay/sdk

TypeScript SDK for building multi-agent workflows with Agent Relay. Provides both low-level broker control and high-level workflow orchestration.

## Installation

```bash
npm install @agent-relay/sdk
```

## Quick Start

### Workflow Builder (Recommended)

The workflow builder is the primary way to define and run multi-agent workflows:

```ts
import { workflow } from "@agent-relay/sdk/workflows";

const result = await workflow("my-feature")
  .pattern("dag")
  .agent("planner", { cli: "claude", role: "Planning lead" })
  .agent("builder", { cli: "codex", role: "Implementation engineer" })
  .step("plan", { agent: "planner", task: "Create a detailed plan" })
  .step("build", { agent: "builder", task: "Implement the plan", dependsOn: ["plan"] })
  .run();
```

### High-Level Facade

The `AgentRelay` class provides a clean API for spawning and managing agents:

```ts
import { AgentRelay } from "@agent-relay/sdk";

const relay = new AgentRelay();

// Event hooks
relay.onMessageReceived = (msg) => console.log(`${msg.from}: ${msg.text}`);
relay.onAgentIdle = ({ name, idleSecs }) => console.log(`${name} idle for ${idleSecs}s`);

// Spawn agents using shorthand spawners
const worker = await relay.claude.spawn({ name: "Worker1", channels: ["general"] });

// Or use the generic spawn method
const agent = await relay.spawn("Worker2", "codex", "Build the API", {
  channels: ["dev"],
  model: "gpt-4o",
});

// Wait for agent to finish (go idle or exit)
const result = await agent.waitForIdle(120_000);

// Send messages
const human = relay.human({ name: "Orchestrator" });
await human.sendMessage({ to: "Worker1", text: "Start the task" });

// Clean up
await relay.shutdown();
```

### Low-Level Client

For direct broker control:

```ts
import { AgentRelayClient } from "@agent-relay/sdk";

const client = await AgentRelayClient.start({
  binaryPath: "/path/to/agent-relay-broker", // optional, auto-detected
  channels: ["general"],
});

await client.spawnPty({
  name: "Worker1",
  cli: "claude",
  channels: ["general"],
  task: "Implement user authentication",
});

const agents = await client.listAgents();
await client.release("Worker1");
await client.shutdown();
```

## Features

- **Workflow Builder** — Fluent API for defining DAG-based multi-agent workflows
- **Agent Spawning** — Spawn Claude, Codex, Gemini, Aider, or Goose agents
- **Idle Detection** — Configurable silence threshold with `onAgentIdle` hook and `waitForIdle()`
- **Message Delivery** — Track message delivery states (queued, injected, active, verified)
- **Event Streaming** — Real-time events for agent lifecycle, output, and messaging
- **Shadow Agents** — Spawn observer agents that monitor other agents
- **Consensus** — Multi-agent voting and consensus helpers

## Subpath Exports

```ts
import { AgentRelayClient } from "@agent-relay/sdk/client";
import { workflow, WorkflowBuilder } from "@agent-relay/sdk/workflows";
import { ConsensusCoordinator } from "@agent-relay/sdk/consensus";
import { ShadowCoordinator } from "@agent-relay/sdk/shadow";
```

## Workflow Templates

Built-in templates for common patterns:

```ts
import { fanOut, pipeline, dag } from "@agent-relay/sdk/workflows";

// Fan-out: parallel execution with synthesis
const builder = fanOut("analysis", {
  tasks: ["Analyze backend", "Analyze frontend"],
  synthesisTask: "Combine analyses into action plan",
});

// Pipeline: sequential stages
const builder = pipeline("release", {
  stages: [
    { name: "plan", task: "Create release plan" },
    { name: "implement", task: "Implement changes" },
    { name: "verify", task: "Run verification" },
  ],
});
```

## Relaycast Integration

The SDK re-exports Relaycast client types for cloud-based relay coordination:

```ts
import { RelayCast, AgentClient } from "@agent-relay/sdk";
```

## Development

```bash
# Build
npm --prefix packages/sdk run build

# Run tests
npm --prefix packages/sdk test

# Run demo
npm --prefix packages/sdk run demo
```

## License

Apache-2.0
