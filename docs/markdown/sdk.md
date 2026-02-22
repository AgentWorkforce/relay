# Agent Relay SDK

The SDK provides programmatic access to Agent Relay for spawning agents, sending messages, and running workflows.

## Installation

```bash
# TypeScript/JavaScript
npm install @agent-relay/sdk

# Python
pip install agent-relay
```

---

## Quick Start

### TypeScript

```typescript
import { AgentRelay, Models } from '@agent-relay/sdk';

const relay = new AgentRelay();

// Spawn agents
const planner = await relay.claude.spawn({
  name: 'Planner',
  model: Models.Claude.OPUS
});

const coder = await relay.codex.spawn({
  name: 'Coder',
  model: Models.Codex.CODEX_5_3
});

// Send messages
await planner.sendMessage({ to: 'Coder', text: 'Implement the auth module' });

// Listen for messages
relay.onMessageReceived = (msg) => {
  console.log(`${msg.from} → ${msg.to}: ${msg.text}`);
};

await relay.shutdown();
```

### Python

```python
from agent_relay import AgentRelay, Models

relay = AgentRelay()

# Spawn agents
planner = relay.claude.spawn(
    name="Planner",
    model=Models.Claude.OPUS
)

coder = relay.codex.spawn(
    name="Coder",
    model=Models.Codex.CODEX_5_3
)

# Send messages
planner.send_message(to="Coder", text="Implement the auth module")

# Listen for messages
@relay.on_message
def handle_message(msg):
    print(f"{msg.from_agent} → {msg.to}: {msg.text}")

relay.shutdown()
```

---

## Model Enums

Type-safe model selection:

### TypeScript

```typescript
import { Models } from '@agent-relay/sdk';

// Claude
Models.Claude.OPUS      // 'opus'
Models.Claude.SONNET    // 'sonnet'
Models.Claude.HAIKU     // 'haiku'

// Codex (OpenAI)
Models.Codex.CODEX_5_3  // 'gpt-5.3-codex'
Models.Codex.O3         // 'o3'
Models.Codex.O4_MINI    // 'o4-mini'

// Gemini
Models.Gemini.PRO_2_5   // 'gemini-2.5-pro'
Models.Gemini.FLASH_2_5 // 'gemini-2.5-flash'

// Cursor
Models.Cursor.CLAUDE_SONNET  // 'claude-3.5-sonnet'
Models.Cursor.GPT_4O         // 'gpt-4o'
```

### Python

```python
from agent_relay import Models

Models.Claude.OPUS
Models.Claude.SONNET
Models.Codex.CODEX_5_3
Models.Gemini.PRO_2_5
```

---

## AgentRelay Class

### Constructor

```typescript
const relay = new AgentRelay({
  port: 3000,           // Broker port (default: auto-detect)
  autoConnect: true,    // Connect on creation (default: true)
});
```

### Spawning Agents

```typescript
// Claude agent
const agent = await relay.claude.spawn({
  name: 'Worker',
  model: Models.Claude.SONNET,
  task: 'Initial task description',
});

// Codex agent
const codexAgent = await relay.codex.spawn({
  name: 'Coder',
  model: Models.Codex.CODEX_5_3,
});

// Gemini agent
const geminiAgent = await relay.gemini.spawn({
  name: 'Analyst',
  model: Models.Gemini.PRO_2_5,
});
```

### Sending Messages

```typescript
// Direct message
await agent.sendMessage({
  to: 'OtherAgent',
  text: 'Hello!',
});

// Broadcast to all
await agent.sendMessage({
  to: '*',
  text: 'Announcement for everyone',
});

// To a channel
await agent.sendMessage({
  to: '#general',
  text: 'Channel message',
});

// With thread context
await agent.sendMessage({
  to: 'Worker',
  text: 'Follow up',
  thread: 'task-123',
});
```

### Receiving Messages

```typescript
relay.onMessageReceived = (message) => {
  console.log('From:', message.from);
  console.log('To:', message.to);
  console.log('Text:', message.text);
  console.log('Thread:', message.thread);
};
```

### Agent Lifecycle

```typescript
// List agents
const agents = await relay.listAgents();

// Get specific agent
const agent = await relay.getAgent('Worker');

// Release agent
await agent.release();

// Shutdown relay
await relay.shutdown();
```

---

## Workflows

### Builder API

```typescript
import { workflow, Models, SwarmPatterns } from '@agent-relay/sdk/workflows';

const result = await workflow('my-workflow')
  .pattern(SwarmPatterns.HUB_SPOKE)
  .agent('lead', { cli: 'claude', model: Models.Claude.OPUS })
  .agent('worker', { cli: 'codex', model: Models.Codex.CODEX_5_3 })
  .step('plan', { agent: 'lead', task: 'Create plan' })
  .step('execute', { agent: 'worker', task: '{{steps.plan.output}}', dependsOn: ['plan'] })
  .onError('retry', { maxRetries: 2 })
  .run();
```

### Swarm Patterns

| Pattern | Description |
|---------|-------------|
| `DAG` | Dependency-based execution |
| `HUB_SPOKE` | Central coordinator |
| `FAN_OUT` | Parallel execution |
| `PIPELINE` | Sequential stages |
| `CONSENSUS` | Voting/agreement |
| `MESH` | Full connectivity |
| `MAP_REDUCE` | Split and aggregate |
| `ESCALATION` | Tiered escalation |
| `RED_TEAM` | Attacker vs defender |
| `SAGA` | Distributed transactions |

### WorkflowRunner

For more control:

```typescript
import { WorkflowRunner } from '@agent-relay/sdk/workflows';

const runner = new WorkflowRunner({ cwd: '/project' });

runner.on((event) => {
  console.log(event.type, event.stepName);
});

const config = await runner.parseYamlFile('workflow.yaml');
const run = await runner.execute(config);

// Control
runner.pause();
runner.unpause();
runner.abort();
```

---

## Templates

### List Templates

```typescript
import { TemplateRegistry } from '@agent-relay/sdk/workflows';

const registry = new TemplateRegistry();
const templates = await registry.listTemplates();
```

### Run Template

```typescript
const config = await registry.loadTemplate('feature-dev');
const runner = new WorkflowRunner();
await runner.execute(config, undefined, {
  task: 'Add user authentication',
});
```

### Available Templates

| Template | Pattern | Description |
|----------|---------|-------------|
| `feature-dev` | hub-spoke | Full feature development |
| `bug-fix` | hub-spoke | Bug investigation and fix |
| `code-review` | fan-out | Parallel code review |
| `security-audit` | pipeline | Security scanning |
| `refactor` | hierarchical | Code refactoring |
| `documentation` | handoff | Doc generation |

---

## Events

### Workflow Events

```typescript
runner.on((event) => {
  switch (event.type) {
    case 'workflow:started':
      console.log('Workflow started');
      break;
    case 'step:started':
      console.log(`Step ${event.stepName} started`);
      break;
    case 'step:completed':
      console.log(`Step ${event.stepName} completed`);
      break;
    case 'step:failed':
      console.error(`Step ${event.stepName} failed:`, event.error);
      break;
    case 'workflow:completed':
      console.log('Workflow completed');
      break;
  }
});
```

---

## Cloud Integration

### Run in Cloud

```typescript
const result = await workflow('feature')
  .agent('dev', { cli: 'claude' })
  .step('build', { agent: 'dev', task: 'Build it' })
  .cloud()  // Execute in cloud
  .run();

console.log(result.cloudRunId);
```

### Monitor Cloud Runs

```typescript
import { CloudWorkflowRunner } from '@agent-relay/sdk/cloud';

const cloud = new CloudWorkflowRunner();

// List runs
const runs = await cloud.listRuns();

// Get status
const status = await cloud.getRunStatus(runId);

// Stream logs
await cloud.streamLogs(runId, (log) => console.log(log));

// Resume failed run
await cloud.resume(runId);
```

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_RELAY_PORT` | Broker port | 3000 |
| `AGENT_RELAY_SOCKET` | Unix socket path | `/tmp/agent-relay.sock` |
| `AGENT_RELAY_CLOUD_URL` | Cloud API URL | `https://cloud.agent-relay.com` |

### Config File

`~/.config/agent-relay/config.json`:

```json
{
  "defaultCli": "claude",
  "defaultModel": "sonnet",
  "cloudApiKey": "ar_live_xxx"
}
```
